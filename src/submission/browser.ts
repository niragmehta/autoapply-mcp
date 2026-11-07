import { mkdirSync } from "node:fs";
import { AppError } from "../util/errors.js";
import { logger } from "../util/logger.js";
import { assertUrlAllowed, checkUrlAllowed } from "./allowlist.js";
import {
  detectAlreadyApplied, detectCaptcha, detectSubmissionConfirmation, detectSubmissionRejection, workdayListsSubmitted,
} from "./form/pageSignals.js";
import { coverLetterFor, enterCoverLetter } from "./coverLetter.js";
import { waitForResumeProcessing } from "./resumeProcessing.js";
import { hasVisibleCaptchaChallenge } from "./captcha.js";
import { ashbyEmbedFallbackUrl } from "./ashbyEmbed.js";
import { isTaxCreditOptOutStep, optOutOfTaxCreditAssessment } from "./workdayAssessment.js";
import { inertControlIndexes } from "./inertControls.js";
import { recordStepFailures, stepFailureList, wizardStepKey, type StepFailures } from "./wizardFailures.js";
import { redactSecrets } from "./credentials.js";
import {
  WORKDAY_MAX_RETRIES, WORKDAY_MAX_STEPS, advanceWorkdayStep, clearInvalidOptionalFields, describeControl,
  readListboxOptions, recoverWorkdayError, retriesEmptyWorkdayStep, reviewOmissions, workdayRequiredErrors,
  workdayStepName,
} from "./workday/wizard.js";
import { enterWorkdayApplication, isWorkdayUrl } from "./workdayFlow.js";
import type { SubmissionPacket } from "./packet.js";
import { careerSiteFor } from "./careerSites.js";
import { aborted, capture, captureCaptchaAbort, readBodyText } from "./browser/capture.js";
import { runCareerSite } from "./browser/careerSite.js";
import { StrayValueError, clearPhoneExtension, reassertChoices, repairReportedFields } from "./browser/controls.js";
import { attachResume, dedupeResumeAttachments, guardedFillFormPage, resumeIsAttached } from "./browser/fillPage.js";
import { loadPlaywright, type PersistentLauncher } from "./browser/playwright.js";
import {
  VERIFIED_SUBMIT_TIMEOUT_MS, awaitHumanSubmission, clickSubmit, describeSubmitControl, detectVerificationCodeGate,
  readValidationErrors, waitForSubmissionOutcome,
} from "./browser/submit.js";
import type { BrowserRunOptions, BrowserRunResult } from "./browser/types.js";
import {
  awaitVerificationCode, describeVerificationGate, enterVerificationCode, workdayVerificationLinkReader,
} from "./browser/verification.js";

export { READ_VALIDATION_ERRORS } from "./validationErrors.js";

export async function runApplicationForm(packet: SubmissionPacket, options: BrowserRunOptions): Promise<BrowserRunResult> {
  assertUrlAllowed(packet.applyUrl, options.policy);
  const playwright = await loadPlaywright();
  const chromium = playwright.chromium;
  if (!chromium) throw new AppError("playwright_missing", "Playwright chromium driver unavailable");

  mkdirSync(options.artifactsDir, { recursive: true });
  const timeout = options.timeoutMs ?? 45_000;
  const site = careerSiteFor(packet.applyUrl);
  if (site) return runCareerSite(chromium as unknown as PersistentLauncher, site, packet, options);
  const browser = await chromium.launch({ headless: options.headless ?? false });

  try {
    const context = await browser.newContext({ acceptDownloads: false });
    const page = await context.newPage();
    await page.goto(packet.applyUrl, { waitUntil: "domcontentloaded", timeout });
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);

    const embeddedForm = ashbyEmbedFallbackUrl(page.url(), await readBodyText(page));
    if (embeddedForm) {
      logger.info("ashby hosted page not found; loading the embedded form", { url: embeddedForm });
      await page.goto(embeddedForm, { waitUntil: "domcontentloaded", timeout });
      await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
    }

    if (!checkUrlAllowed(page.url(), options.policy).allowed) {
      return aborted(`page redirected off the allowlist to ${page.url()}`, page.url());
    }

    const pageText = await readBodyText(page);
    // A passive reCAPTCHA v3 badge only leaves "protected by reCAPTCHA" in the
    // page text and needs no human action, so it must not abort a fill-only
    // (assisted) run. Anything actually interactive still aborts, and a
    // self-submitting run stays strict.
    const interactiveChallenge = await hasVisibleCaptchaChallenge(page);
    if (interactiveChallenge || (options.submit && detectCaptcha(pageText))) {
      const shot = await capture(page, options.artifactsDir, packet.applicationId, "captcha");
      return {
        status: "aborted",
        reason: "anti-bot challenge detected; this application must be completed by a human",
        filledFields: [],
        unmatchedRequired: [],
        unusedAnswers: [],
        screenshotPath: shot,
        finalUrl: page.url(),
        confirmationText: "",
        captchaDetected: true,
      };
    }

    // Workday hides the form behind an advert, a modal and a sign-in wall, so it
    // needs a walk-in step before there is anything to fill.
    const priorFilled: Array<{ label: string; source: string }> = [];
    const priorStatedAs = new Map<string, readonly string[]>();
    const priorFailedRequired: string[] = [];
    let stepFailures: StepFailures = new Map();
    let workdayRetries = 0;
    let assessmentAttempts = 0;
    let resumeAttached = false;
    if (isWorkdayUrl(page.url())) {
      const entry = await enterWorkdayApplication(page, options.accountEmail ?? "", {
        allowAccountCreation: options.allowAccountCreation ?? false,
        awaitVerificationLink: workdayVerificationLinkReader(options, page.url()),
      });
      if (await hasVisibleCaptchaChallenge(page)) return await captureCaptchaAbort(page, packet, options);
      if (entry.reached !== "form") {
        const shot = await capture(page, options.artifactsDir, packet.applicationId, "workday-entry");
        return {
          ...aborted(redactSecrets(entry.detail), page.url()),
          screenshotPath: shot,
        };
      }
      logger.info("workday application entered", { detail: entry.detail, createdAccount: entry.createdAccount });
      await page.waitForTimeout(1500);

      // Workday spreads one application over roughly six pages - My Information,
      // My Experience, Application Questions, Voluntary Disclosures, Self
      // Identify, Review - and each has to be saved before the next exists. Walk
      // to the last page here so the code below sees a form it can finish, the
      // same way it does on a single-page board.
      let stalledOn = "";
      let stalls = 0;
      let stalledCollected = -1;
      for (let step = 0; step < WORKDAY_MAX_STEPS; step += 1) {
        await recoverWorkdayError(page as never);
        const name = await workdayStepName(page);
        // A step that refuses to advance - Adobe's Education block rejects the
        // form until every one of its prompts is answered - otherwise burns the
        // whole step budget re-filling the same page and then reports whatever
        // the last iteration happened to see. Three attempts is enough to tell a
        // slow save from a blocked one.
        if (name && name === stalledOn) {
          stalls += 1;
          if (stalls >= 3) {
            logger.warn("workday step will not advance", { step: name });
            // The banner names questions an earlier answer revealed after the
            // step was collected, which are the ones a person has to answer.
            const missing = await workdayRequiredErrors(page as never).catch(() => [] as string[]);
            if (missing.length > 0) logger.info("workday step reports required fields", { missing });
            priorFailedRequired.push(...missing);
            // Reported, not just logged: a wizard that never reached Review has
            // not filled the application, and without this the run ends
            // "unmatched required: []" and looks ready to submit.
            priorFailedRequired.push(`${name.replace(/\s+/g, " ").trim()} would not advance`);
            break;
          }
        } else {
          stalledOn = name;
          stalls = 0;
          stalledCollected = -1;
        }
        // The resume upload lives on My Experience rather than the first page,
        // so it is offered on every step and lands on whichever one accepts it.
        // The upload is asynchronous and does sometimes drop, so it is retried
        // until the board shows the file name back.
        for (let attempt = 0; attempt < 3; attempt += 1) {
          if (resumeAttached) break;
          // Checked before attaching: Workday keeps the file on the saved
          // profile, so uploading again adds a second identical copy rather
          // than replacing the first.
          if (await resumeIsAttached(page, packet.resumePath)) {
            resumeAttached = true;
            break;
          }
          await attachResume(page, packet.resumePath);
          await page.waitForTimeout(1200);
          if (await hasVisibleCaptchaChallenge(page)) return await captureCaptchaAbort(page, packet, options, priorFilled);
          if (await resumeIsAttached(page, packet.resumePath)) {
            resumeAttached = true;
            break;
          }
        }
        if (resumeAttached) await dedupeResumeAttachments(page);
        // A tax-credit questionnaire step holds no fields to fill and will not
        // save until the questionnaire is taken or declined. Declining is the
        // candidate's standing choice for every voluntary disclosure.
        if (/assessment/i.test(name) && assessmentAttempts < 2) {
          const stepText = await page.locator("body").innerText().catch(() => "");
          if (isTaxCreditOptOutStep(stepText)) {
            assessmentAttempts += 1;
            const outcome = await optOutOfTaxCreditAssessment(page as never, async (target, stage) => {
              await capture(target as never, options.artifactsDir, packet.applicationId, stage);
            }).catch((error: unknown) => ({
              optedOut: false,
              detail: `the assessment could not be declined: ${String((error as Error)?.message ?? error).slice(0, 200)}`,
            }));
            logger.info("workday tax-credit assessment", outcome);
            if (outcome.optedOut && (await advanceWorkdayStep(page as never))) {
              await page.waitForTimeout(1500);
              continue;
            }
          }
        }
        const stepFill = await guardedFillFormPage(page, packet, options, true);
        if ("status" in stepFill) return { ...stepFill, filledFields: [...priorFilled, ...stepFill.filledFields] };
        await clearPhoneExtension(page);
        // The transient fault can also arrive part-way through a step, after
        // the recovery above has already run. The step then collects nothing
        // and the run ends up reporting a live posting as removed, so the same
        // step is reloaded and retried before that conclusion is drawn.
        const collected = stepFill.plan.toFill.length + stepFill.plan.unfilled.length;
        if (retriesEmptyWorkdayStep(name, collected, workdayRetries, WORKDAY_MAX_RETRIES)) {
          workdayRetries += 1;
          logger.warn("workday step collected nothing, retrying", { step: name || `step ${step + 1}` });
          await recoverWorkdayError(page as never);
          step -= 1;
          continue;
        }
        // A step that reveals a question with each save is making progress, not
        // stalling: Intel shows 11c only once 11 is answered and 11d only once
        // 11c is, and three attempts ran out just as 11d appeared. Only an
        // attempt that finds nothing new counts towards giving up.
        if (name && name === stalledOn && stalledCollected >= 0 && collected > stalledCollected) stalls = Math.max(0, stalls - 1);
        stalledCollected = Math.max(stalledCollected, collected);
        priorFilled.push(...stepFill.filled);
        for (const [label, wordings] of stepFill.statedAs) priorStatedAs.set(label, wordings);
        // A required question left unmatched on an earlier wizard page is just
        // as blocking as one on the last page, but only the last page's plan
        // reaches the report. Without this the run ends "unmatched required: []"
        // while a saved step still refuses to advance - the exact silent success
        // this whole path was built to stop.
        const stepUnmatchedFields = stepFill.plan.unmatchedRequired
          .filter((entry) => !(entry.groupKey && stepFill.answeredGroups.has(entry.groupKey)));
        // A Workday dropdown is a button whose options exist only once it is
        // opened, so an unfillable required one otherwise reports nothing but
        // its label and the only way on is to guess at employer-specific
        // consent wording. Opening it turns that into a decision on the record.
        const stepUnmatched: string[] = [];
        for (const entry of stepUnmatchedFields) {
          let choices = entry.options ?? [];
          if (choices.length === 0 && stepUnmatched.length < 3) {
            choices = await readListboxOptions(page as never, entry.selectorIndex, entry.label);
          }
          if (choices.length > 0) {
            stepUnmatched.push(`${entry.label} [options: ${choices.join(" | ")}]`);
            continue;
          }
          // No options at all usually means it is not a dropdown. Saying so
          // costs one evaluate and replaces a round of guesswork.
          const shape = stepUnmatched.length < 3
            ? await describeControl(page as never, entry.selectorIndex, entry.label)
            : "";
          stepUnmatched.push(shape ? `${entry.label} [${shape}]` : entry.label);
        }
        stepFailures = recordStepFailures(stepFailures, wizardStepKey(name, step), [
          ...stepFill.failedRequired,
          ...stepUnmatched,
        ]);
        logger.info("workday step filled", {
          step: name || `step ${step + 1}`,
          filled: stepFill.filled.length,
          collected: stepFill.plan.toFill.length + stepFill.plan.unfilled.length,
          failedRequired: stepFill.failedRequired.length,
          unmatchedRequired: stepUnmatched,
        });
        // The last step is Review, and its footer button is Submit, not Save
        // and Continue. Advancing past it sends the application - which a
        // fill-only run must never do, and a submitting run must only do
        // through the guarded submit path below. So the walk stops here.
        if (/review/i.test(name)) break;
        // A value the step rejected holds it on every attempt, even in an
        // optional field: KLA's Facebook field held the LinkedIn URL. The banner
        // from the last attempt names it, and an empty optional field passes.
        const clearedInvalid = await clearInvalidOptionalFields(page as never).catch(() => [] as string[]);
        if (clearedInvalid.length > 0) logger.info("cleared optional fields Workday rejected", { labels: clearedInvalid });
        if (!(await advanceWorkdayStep(page))) break;
        await page.waitForTimeout(1500);
      }
      // Workday does not mark Resume/CV required, so a dropped upload reaches
      // Review as "No Response" without a word of complaint. Reporting it is
      // what stops an application being submitted with no resume at all.
      if (!resumeAttached) {
        priorFailedRequired.push("Resume/CV (upload did not take)");
      }
    }

    // The wizard has already attached and verified the resume; re-offering it on
    // the review page would add a second copy to the saved profile.
    if (!resumeAttached) {
      await attachResume(page, packet.resumePath);
    }
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
    if (await hasVisibleCaptchaChallenge(page)) return await captureCaptchaAbort(page, packet, options, priorFilled);
    if (/\.ashbyhq\.com$/i.test(new URL(page.url()).hostname)) {
      await page
        .locator("text=Autofill completed!")
        .first()
        .waitFor({ state: "visible", timeout: 15_000 })
        .catch(() => undefined);
    }
    if (/^jobs(?:\.eu)?\.lever\.co$/i.test(new URL(page.url()).hostname)) {
      await waitForResumeProcessing(page.locator(".resume-upload-working").first(), timeout);
    }
    await page.waitForTimeout(1000);

    const pageFill = await guardedFillFormPage(page, packet, options);
    if ("status" in pageFill) return { ...pageFill, filledFields: [...priorFilled, ...pageFill.filledFields] };
    // A page with no inputs is normally a dead posting. After a wizard has
    // already filled and saved earlier pages it is instead the Review page,
    // which has nothing to fill and everything to submit.
    if (!pageFill.hasForm && priorFilled.length === 0) {
      const shot = await capture(page, options.artifactsDir, packet.applicationId, "no-form");
      // A board showing no form because the application is already on file is
      // the opposite of a removed posting, and saying "removed" there loses a
      // real application. Cisco's Workday tenant does exactly this.
      const noFormText = await readBodyText(page);
      if (detectAlreadyApplied(noFormText)) {
        return {
          status: "submitted",
          reason: "the board reports an application for this posting is already on file",
          filledFields: [],
          unmatchedRequired: [],
          unusedAnswers: [],
          screenshotPath: shot,
          finalUrl: page.url(),
          confirmationText: noFormText.slice(0, 600),
          captchaDetected: false,
        };
      }
      return {
        status: "aborted",
        reason:
          "no application form found at the final URL; the posting has most likely been removed and the board redirected to its job index",
        filledFields: [],
        unmatchedRequired: [],
        unusedAnswers: [],
        screenshotPath: shot,
        finalUrl: page.url(),
        confirmationText: "",
        captchaDetected: false,
      };
    }
    const { plan, choiceLog, answeredGroups } = pageFill;
    // Entered after the field pass, so the pass cannot overwrite the letter
    // written for this application with the drafted template, and before the
    // screenshot, so the record shows what was sent.
    const letterOutcome = await enterCoverLetter(page, coverLetterFor(packet));
    if (letterOutcome === "failed") logger.warn("cover letter could not be entered", { url: page.url() });
    const letterFilled = letterOutcome === "entered"
      ? [{ label: "Cover Letter", source: packet.coverLetter.trim().length > 0 ? "cover-letter" : "approved-answer" }]
      : [];
    // Pages saved earlier in a multi-step wizard are part of this application,
    // so what they filled has to survive into the final report.
    const filled = [...priorFilled, ...pageFill.filled, ...letterFilled];
    const statedAs = new Map([...priorStatedAs, ...pageFill.statedAs]);
    const failedRequired = [...stepFailureList(stepFailures), ...priorFailedRequired, ...pageFill.failedRequired];

    const screenshotPath = await capture(page, options.artifactsDir, packet.applicationId, "prepared");
    const inertIndexes = await inertControlIndexes(
      page,
      plan.unmatchedRequired.map((entry) => entry.selectorIndex),
    );
    const unmatchedFields = plan.unmatchedRequired
      // Some required controls switch themselves off in response to another
      // answer: ticking "Current role" disables the end-date selects. A
      // disabled control submits nothing, so it cannot be what is missing,
      // and filling it would contradict the answer that disabled it.
      .filter((entry) => !inertIndexes.has(entry.selectorIndex))
      // One tick answers a whole multi-select question; the boxes left clear
      // are choices declined, not requirements left unmet.
      .filter((entry) => !(entry.groupKey && answeredGroups.has(entry.groupKey)));
    // A required dropdown no answer matched is reported with the choices it
    // actually offers. Employer-specific consent wording - Unity's privacy
    // notice takes neither "Yes" nor "I Acknowledge" - otherwise leaves
    // guessing at legal text as the only way on, which is never acceptable.
    const unmatchedLabels: string[] = [];
    for (const entry of unmatchedFields) {
      const choices = entry.options && entry.options.length > 0
        ? entry.options
        : unmatchedLabels.length < 3
          ? await readListboxOptions(page as never, entry.selectorIndex, entry.label)
          : [];
      logger.info("unmatched required field", { label: entry.label.slice(0, 80), type: entry.type, choices });
      unmatchedLabels.push(choices.length > 0 ? `${entry.label} [options: ${choices.join(" | ")}]` : entry.label);
    }
    const unmatchedRequired = [
      ...unmatchedLabels,
      ...failedRequired,
    ].filter((label, index, labels) => labels.indexOf(label) === index);

    // A wizard reporting every field filled is not evidence the form states
    // the truth. A signed-in Workday draft resumes values from earlier runs,
    // and the run's own side effects can set values no answer supplied:
    // Adobe's Review page claimed prior employment as an "Employee" (ticked by
    // the options probe, which now reads toggles without clicking them) and a
    // source of "Findem" while the log showed zero failures.
    // Check the page repeats the distinctive answers that were given.
    const answerFor = new Map(packet.answers.map((answer) => [answer.label, answer.answer]));
    const contradicted = isWorkdayUrl(page.url())
      ? await reviewOmissions(
          page,
          filled
            .map((entry) => ({
              label: entry.label,
              value: answerFor.get(entry.label) ?? "",
              alternatives: statedAs.get(entry.label) ?? [],
            }))
            .filter((entry) => entry.value.length > 0),
          packet.company,
        )
      : [];
    if (contradicted.length > 0) {
      logger.warn("form does not state what was answered", { labels: contradicted.map((entry) => entry.label) });
    }
    const notStatedBack = contradicted.map(
      (entry) => `${entry.label} [answered ${JSON.stringify(entry.value)} but the page does not say it back]`,
    );

    if (!options.submit) {
      const keepOpenMs = options.keepOpenMs ?? 0;
      if (keepOpenMs > 0) {
        logger.info("holding form open for human review", { keepOpenMs, url: page.url() });
        const confirmation = await awaitHumanSubmission(page, keepOpenMs);
        if (confirmation !== undefined) {
          const shot = await capture(page, options.artifactsDir, packet.applicationId, "confirmation");
          logger.info("the person submitted the held form", { url: page.url() });
          return {
            status: "submitted",
            reason: "submitted by a person in the held window; confirmation detected and captured",
            filledFields: filled,
            unmatchedRequired: [],
            unusedAnswers: plan.unusedAnswers.map((answer) => answer.label),
            screenshotPath: shot,
            finalUrl: page.url(),
            confirmationText: confirmation.slice(0, 600),
            captchaDetected: false,
          };
        }
      }
      // A window the person closed during the hold has no challenge left to
      // report; the form was prepared and simply not submitted.
      const challenged = await hasVisibleCaptchaChallenge(page).catch(() => false);
      if (challenged) return await captureCaptchaAbort(page, packet, options, filled);
      return {
        status: "prepared",
        reason:
          keepOpenMs > 0
            ? "form filled and left open for human review and submission"
            : "form filled and captured; submission not requested",
        filledFields: filled,
        unmatchedRequired: [...unmatchedRequired, ...notStatedBack],
        leftForHuman: plan.unfilled.map((entry) => entry.label),
        unusedAnswers: plan.unusedAnswers.map((answer) => answer.label),
        screenshotPath,
        finalUrl: page.url(),
        confirmationText: "",
        captchaDetected: false,
      };
    }

    if (unmatchedRequired.length > 0) {
      return {
        status: "aborted",
        reason: `required field(s) could not be filled: ${unmatchedRequired.join("; ")}`,
        filledFields: filled,
        unmatchedRequired,
        unusedAnswers: plan.unusedAnswers.map((answer) => answer.label),
        screenshotPath,
        finalUrl: page.url(),
        confirmationText: "",
        captchaDetected: false,
      };
    }

    if (notStatedBack.length > 0) {
      // Submitting now would send whatever the page is actually holding, which
      // is not what was approved. Stop with the discrepancy named.
      return {
        status: "aborted",
        reason: `the form does not state what was answered: ${notStatedBack.join("; ")}`,
        filledFields: filled,
        unmatchedRequired: notStatedBack,
        unusedAnswers: plan.unusedAnswers.map((answer) => answer.label),
        screenshotPath,
        finalUrl: page.url(),
        confirmationText: "",
        captchaDetected: false,
      };
    }

    // Choices were verified before the screenshot, but every fill after that
    // point re-renders the form, and Ashby drops a selection when it re-renders
    // the control that holds it. Harvey rejected two submissions for a missing
    // work-authorisation answer that the run had verified as set moments
    // earlier. Verify again with nothing left to disturb the form, so what is
    // submitted is what was checked.
    const lostAtSubmit = await reassertChoices(page, choiceLog);
    if (lostAtSubmit.length > 0) {
      for (const label of lostAtSubmit) logger.warn("choice would not hold at submit", { label });
      return {
        status: "aborted",
        reason: `choice(s) would not stay selected, so nothing was submitted: ${lostAtSubmit.join("; ")}`,
        filledFields: filled.filter((entry) => !lostAtSubmit.includes(entry.label)),
        unmatchedRequired: lostAtSubmit,
        unusedAnswers: plan.unusedAnswers.map((answer) => answer.label),
        screenshotPath,
        finalUrl: page.url(),
        confirmationText: "",
        captchaDetected: false,
      };
    }

    // A submit that leaves us on the page is ambiguous: the request may have
    // been rejected by the board, or never sent at all. Recording what the
    // network actually did is the difference between a diagnosable failure and
    // a shrug, and it is the only way to see a server-side refusal that the
    // page never renders.
    const failedCalls: string[] = [];
    const onResponse = (response: { status: () => number; url: () => string }) => {
      const status = response.status();
      if (status < 400) return;
      const url = response.url();
      if (!/appl|submit|graphql|candidate/i.test(url)) return;
      failedCalls.push(`${status} ${url.split("?")[0]}`);
    };
    page.on?.("response", onResponse as (payload: never) => void);

    const submitState = await describeSubmitControl(page);
    if (await hasVisibleCaptchaChallenge(page)) {
      page.off?.("response", onResponse as (payload: never) => void);
      return await captureCaptchaAbort(page, packet, options, filled);
    }
    // The board emails its code the moment this click lands, so this is the
    // only honest measure of that code's age. Reading the clock later - after
    // the page settles, the outcome is polled and a screenshot is taken - dates
    // the code minutes into the future and rejects the very email being waited
    // for.
    const submitClickedAt = new Date();
    // The wizard walk can complete a Workday submission itself and land on
    // Candidate Home, where there is no submit control left to find.
    if (isWorkdayUrl(page.url()) && workdayListsSubmitted(await readBodyText(page), packet.jobTitle)) {
      page.off?.("response", onResponse as (payload: never) => void);
      const shot = await capture(page, options.artifactsDir, packet.applicationId, "confirmation");
      return {
        status: "submitted",
        reason: "Workday's Candidate Home lists this application as submitted",
        filledFields: filled,
        unmatchedRequired: [],
        unusedAnswers: plan.unusedAnswers.map((answer) => answer.label),
        screenshotPath: shot,
        finalUrl: page.url(),
        confirmationText: (await readBodyText(page)).slice(0, 600),
        captchaDetected: false,
      };
    }
    const clicked = await clickSubmit(page);
    if (!clicked) {
      page.off?.("response", onResponse as (payload: never) => void);
      return {
        status: "aborted",
        reason: "no submit control found on the page",
        filledFields: filled,
        unmatchedRequired: [],
        unusedAnswers: plan.unusedAnswers.map((answer) => answer.label),
        screenshotPath,
        finalUrl: page.url(),
        confirmationText: "",
        captchaDetected: false,
      };
    }

    await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => undefined);
    const postSubmitText = await waitForSubmissionOutcome(page);
    page.off?.("response", onResponse as (payload: never) => void);
    const captchaDetected = detectCaptcha(postSubmitText) || (await hasVisibleCaptchaChallenge(page));
    if (captchaDetected) {
      const shot = await capture(page, options.artifactsDir, packet.applicationId, "captcha");
      return {
        status: "aborted",
        reason: "anti-bot challenge activated after submit; this application must be completed by a human",
        filledFields: filled,
        unmatchedRequired: [],
        unusedAnswers: plan.unusedAnswers.map((answer) => answer.label),
        screenshotPath: shot,
        finalUrl: page.url(),
        confirmationText: "",
        captchaDetected: true,
      };
    }

    if (!checkUrlAllowed(page.url(), options.policy).allowed) {
      return aborted(`page redirected off the allowlist to ${page.url()}`, page.url());
    }

    const confirmationShot = await capture(page, options.artifactsDir, packet.applicationId, "confirmation");
    if (!detectSubmissionConfirmation(postSubmitText, page.url())) {
      const verification = detectVerificationCodeGate(postSubmitText);
      const code = verification
        ? options.verificationCode ?? (await awaitVerificationCode(options, page, submitClickedAt))
        : undefined;
      if (verification && code) {
        const entered = await enterVerificationCode(page, code);
        if (entered) {
          await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => undefined);
          const codeText = await waitForSubmissionOutcome(page, {
            gateIsOutcome: false,
            timeoutMs: VERIFIED_SUBMIT_TIMEOUT_MS,
          });
          const codeShot = await capture(page, options.artifactsDir, packet.applicationId, "confirmation");
          if (detectSubmissionConfirmation(codeText, page.url())) {
            return {
              status: "submitted",
              reason: "verification code accepted; submission confirmation detected and captured",
              filledFields: filled,
              unmatchedRequired: [],
              unusedAnswers: plan.unusedAnswers.map((answer) => answer.label),
              screenshotPath: codeShot,
              finalUrl: page.url(),
              confirmationText: codeText.slice(0, 600),
              captchaDetected: false,
            };
          }
          // A code that is wrong, already used or expired is worth saying
          // plainly: the remedy is a fresh code, not another attempt at this
          // one, and each attempt emails a new code. A gate that reports no
          // error at all usually means the code was never sent rather than
          // refused, so the controls it offers are recorded to tell the two
          // apart without burning another code on a guess.
          const codeErrors = await readValidationErrors(page);
          const stillGated = detectVerificationCodeGate(codeText);
          const gate = codeErrors.length ? "" : await describeVerificationGate(page);
          return {
            status: "aborted",
            reason: `verification code was entered but the submission was not confirmed${
              codeErrors.length ? `; page reported: ${codeErrors.join(" | ")}` : ""
            }${stillGated ? " The gate is still on screen after the wait, so the code was most likely refused and a new one has been emailed." : ""}${
              ` Code entry: ${entered}.`
            }${gate ? ` Gate controls: ${gate}` : ""}`,
            filledFields: filled,
            unmatchedRequired: [],
            unusedAnswers: plan.unusedAnswers.map((answer) => answer.label),
            screenshotPath: codeShot,
            finalUrl: page.url(),
            confirmationText: "",
            captchaDetected: false,
          };
        }
      }
      if (verification) {
        return {
          status: "aborted",
          reason: `${verification} Every field is filled. A code cannot be carried over from an earlier run, because clicking submit is what causes one to be sent; re-run with waitForCodeSeconds so the browser holds this session open, or in assisted mode and enter it by hand.`,
          filledFields: filled,
          unmatchedRequired: [],
          unusedAnswers: plan.unusedAnswers.map((answer) => answer.label),
          screenshotPath: confirmationShot,
          finalUrl: page.url(),
          confirmationText: "",
          captchaDetected: false,
        };
      }
      const pageErrors = await readValidationErrors(page);
      const detail = pageErrors.length ? ` page reported: ${pageErrors.join(" | ")}` : "";
      const network = failedCalls.length ? ` submit request failed: ${failedCalls.join("; ")}` : "";
      const control = submitState ? ` ${submitState}` : "";
      const finalText = await readBodyText(page);
      // Ashby paints its success panel after the outcome poll has already given
      // up, so the first read of the page can miss a submission that did land.
      // Reporting a successful application as a failure is the worst outcome
      // available - it invites a duplicate - so the later read decides.
      if (detectSubmissionConfirmation(finalText, page.url())) {
        const lateShot = await capture(page, options.artifactsDir, packet.applicationId, "confirmation");
        page.off?.("response", onResponse as (payload: never) => void);
        return {
          status: "submitted",
          reason: "submission confirmed on a second read of the page, after the board rendered its success panel late",
          filledFields: filled,
          unmatchedRequired: [],
          unusedAnswers: plan.unusedAnswers.map((answer) => answer.label),
          screenshotPath: lateShot,
          finalUrl: page.url(),
          confirmationText: finalText.slice(0, 600),
          captchaDetected: false,
        };
      }
      if (detectSubmissionRejection(finalText) || detectSubmissionRejection(postSubmitText)) {
        return {
          status: "aborted",
          reason: `the employer refused the submission, so nothing was sent - do not treat this as possibly submitted. Submit this one by hand.${detail}${network}`,
          filledFields: filled,
          unmatchedRequired: [],
          unusedAnswers: plan.unusedAnswers.map((answer) => answer.label),
          screenshotPath: confirmationShot,
          finalUrl: page.url(),
          confirmationText: "",
          captchaDetected: false,
        };
      }
      // The board has told us which fields it thinks are empty. Repair exactly
      // those and click again: validation failed, so nothing was sent, and a
      // further click cannot produce a second application. Ashby reports one
      // lost field at a time - Abridge named Full Name, then LinkedIn Profile,
      // then Phone across three runs - so this repeats until the board either
      // accepts the form or stops naming a field this run can repair.
      let roundErrors = pageErrors;
      const allRepaired: string[] = [];
      let lastShot = confirmationShot;
      for (let round = 0; round < 4; round += 1) {
        let repairedFields: string[];
        try {
          repairedFields = await repairReportedFields(page, plan.toFill, roundErrors, packet.company);
        } catch (error) {
          if (!(error instanceof StrayValueError)) throw error;
          // Clicking again would send a value nobody approved.
          page.off?.("response", onResponse as (payload: never) => void);
          return {
            status: "aborted",
            reason: `repairing a field the board reported empty left it stating something that was never answered, so the form was not sent again: ${error.message}`,
            filledFields: filled,
            unmatchedRequired: [],
            unusedAnswers: plan.unusedAnswers.map((answer) => answer.label),
            screenshotPath: lastShot,
            finalUrl: page.url(),
            confirmationText: "",
            captchaDetected: false,
          };
        }
        if (repairedFields.length === 0) break;
        allRepaired.push(...repairedFields.filter((label) => !allRepaired.includes(label)));
        logger.info("repairing fields the board reported empty", { round: round + 1, fields: repairedFields });
        await reassertChoices(page, choiceLog);
        if (!(await clickSubmit(page))) break;
        await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => undefined);
        const retryText = await waitForSubmissionOutcome(page);
        lastShot = await capture(page, options.artifactsDir, packet.applicationId, "confirmation");
        if (detectSubmissionConfirmation(retryText, page.url())) {
          page.off?.("response", onResponse as (payload: never) => void);
          return {
            status: "submitted",
            reason: `submission confirmed after re-entering ${allRepaired.join("; ")}, which the board had reported empty`,
            filledFields: filled,
            unmatchedRequired: [],
            unusedAnswers: plan.unusedAnswers.map((answer) => answer.label),
            screenshotPath: lastShot,
            finalUrl: page.url(),
            confirmationText: retryText.slice(0, 600),
            captchaDetected: false,
          };
        }
        // A code gate after the repair means the form was accepted and only the
        // code is outstanding. That needs the full gated path, which this repair
        // deliberately does not duplicate, so say so plainly rather than guess.
        const retryGate = detectVerificationCodeGate(retryText);
        if (retryGate) {
          page.off?.("response", onResponse as (payload: never) => void);
          return {
            status: "aborted",
            reason: `${retryGate} The form was repaired and accepted, so re-run this application to clear the code gate.`,
            filledFields: filled,
            unmatchedRequired: [],
            unusedAnswers: plan.unusedAnswers.map((answer) => answer.label),
            screenshotPath: lastShot,
            finalUrl: page.url(),
            confirmationText: "",
            captchaDetected: false,
          };
        }
        roundErrors = await readValidationErrors(page);
        if (roundErrors.length === 0) {
          // No complaint left. Either the success panel arrived late or the
          // board went quiet; a fresh read of the page tells us which.
          const settledText = await readBodyText(page);
          if (detectSubmissionConfirmation(settledText, page.url())) {
            page.off?.("response", onResponse as (payload: never) => void);
            return {
              status: "submitted",
              reason: `submission confirmed after re-entering ${allRepaired.join("; ")}, which the board had reported empty`,
              filledFields: filled,
              unmatchedRequired: [],
              unusedAnswers: plan.unusedAnswers.map((answer) => answer.label),
              screenshotPath: lastShot,
              finalUrl: page.url(),
              confirmationText: settledText.slice(0, 600),
              captchaDetected: false,
            };
          }
          break;
        }
      }
      if (allRepaired.length > 0) {
        page.off?.("response", onResponse as (payload: never) => void);
        return {
          status: "aborted",
          reason: `re-entered ${allRepaired.join("; ")} and clicked submit again, but the board still did not confirm.${
            roundErrors.length ? ` page reported: ${roundErrors.join(" | ")}` : ""
          }`,
          filledFields: filled,
          unmatchedRequired: roundErrors.length > 0 ? allRepaired : [],
          unusedAnswers: plan.unusedAnswers.map((answer) => answer.label),
          screenshotPath: lastShot,
          finalUrl: page.url(),
          confirmationText: "",
          captchaDetected: false,
        };
      }
      return {
        status: "aborted",
        reason: `submit control clicked but no submission confirmation was detected; verify this application manually.${control}${detail}${network}`,
        filledFields: filled,
        unmatchedRequired: [],
        unusedAnswers: plan.unusedAnswers.map((answer) => answer.label),
        screenshotPath: confirmationShot,
        finalUrl: page.url(),
        confirmationText: "",
        captchaDetected: false,
      };
    }

    const confirmationText = postSubmitText.slice(0, 600);

    return {
      status: "submitted",
      reason: "submission confirmation detected and captured",
      filledFields: filled,
      unmatchedRequired: [],
      unusedAnswers: plan.unusedAnswers.map((answer) => answer.label),
      screenshotPath: confirmationShot,
      finalUrl: page.url(),
      confirmationText,
      captchaDetected: false,
    };
  } finally {
    await browser.close().catch(() => undefined);
  }
}
