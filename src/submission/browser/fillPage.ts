import { AppError } from "../../util/errors.js";
import { logger } from "../../util/logger.js";
import { declinesByLeavingBlank } from "../form/answerVocabulary.js";
import { augmentAnswersForBrowser } from "../form/browserAnswers.js";
import { fallbackAnswersForFields } from "../form/fallbackAnswers.js";
import type { FieldDescriptor } from "../form/fieldModel.js";
import { answerValueForField } from "../form/matching.js";
import { optionSearchCandidates } from "../form/optionSearch.js";
import { looksLikeApplicationForm } from "../form/pageSignals.js";
import { buildFillPlan, orderFieldsForBrowser, stalePlaceholderFields, type FillPlan } from "../formFields.js";
import { validateResumeFile } from "../resume.js";
import { hasVisibleCaptchaChallenge } from "../captcha.js";
import type { SubmissionPacket } from "../packet.js";
import { captureCaptchaAbort } from "./capture.js";
import { COLLECT_FIELDS } from "./collectFields.js";
import { StrayValueError, fillControl, reassertChoices, type ChoiceSelection } from "./controls.js";
import type { AnyPage } from "./playwright.js";
import type { BrowserRunOptions, BrowserRunResult } from "./types.js";

/**
 * Opens an application form, fills what the packet supports, and captures a
 * screenshot. Submits only when `submit` is true.
 */
/**
 * Fills every field currently on screen and reports what happened.
 *
 * Split out of the single-page run so the Workday wizard can reuse it: that
 * flow spreads one application across six pages, each of which must be filled
 * and saved before the next exists, and every page needs exactly this handling.
 *
 * Reports `hasForm: false` rather than throwing when the page holds no form, so
 * the single-page path can abort with its own diagnosis while the wizard treats
 * it as the end of the walk.
 */
async function fillFormPage(
  page: AnyPage,
  packet: SubmissionPacket,
  options: BrowserRunOptions,
  /**
   * Inside a wizard the page is already known to belong to the application, so
   * the "does this look like a form?" heuristic must not run. It asks for a
   * name, an email or a file upload, and a later step of a Workday application
   * has none of those: NVIDIA's "Application Questions" step is two work
   * authorization dropdowns and nothing else, which the heuristic read as a
   * non-form and skipped, leaving both required questions blank forever.
   */
  knownApplicationPage = false,
): Promise<{
  hasForm: boolean;
  plan: FillPlan;
  filled: Array<{ label: string; source: string }>;
  failedRequired: string[];
  choiceLog: ChoiceSelection[];
  answeredGroups: Set<string>;
  /** The wordings each filled field's answer was approved to be chosen under, by label. */
  statedAs: Map<string, readonly string[]>;
}> {
  const fields = (await page.evaluate(COLLECT_FIELDS)) as FieldDescriptor[];
  const empty = {
    plan: { toFill: [], unfilled: [], unmatchedRequired: [], unusedAnswers: [] } as unknown as FillPlan,
    filled: [] as Array<{ label: string; source: string }>,
    failedRequired: [] as string[],
    choiceLog: [] as ChoiceSelection[],
    answeredGroups: new Set<string>(),
    statedAs: new Map<string, readonly string[]>(),
  };
  if (!knownApplicationPage && !looksLikeApplicationForm(fields)) return { hasForm: false, ...empty };
  // A wizard step with no controls at all really is the end of the walk.
  if (knownApplicationPage && fields.length === 0) return { hasForm: false, ...empty };

  const packetAnswers = augmentAnswersForBrowser(packet.answers, options.candidateCountry);
  const plan = buildFillPlan(fields, [
    ...packetAnswers,
    ...fallbackAnswersForFields(
      fields,
      packetAnswers,
      options.answerBank ?? [],
      options.personalResolver,
      options.narrativeResolver,
      options.experienceResolver,
    ),
  ]);
  const filled: Array<{ label: string; source: string }> = [];
  const failedRequired: string[] = [];
  const choiceLog: ChoiceSelection[] = [];
  const answeredGroups = new Set<string>();
  const statedAs = new Map<string, readonly string[]>();

  // Which answer each required control drew, before anything is typed. A run
  // that ends "unmatched required" otherwise gives no way to tell a missing
  // answer apart from one that matched the question but named no option.
  logger.info("fill plan", {
    required: plan.toFill
      .filter((match) => match.field.required)
      .map((match) => `${match.field.label}${match.field.optionLabel ? ` [${match.field.optionLabel}]` : ""} <- ${match.answer?.questionKey ?? "none"}`),
    unmatchedRequired: plan.unmatchedRequired.map(
      (field) => `${field.label}${field.optionLabel ? ` [${field.optionLabel}]` : ""}`,
    ),
  });

  for (const match of orderFieldsForBrowser(plan.toFill)) {
    // Selecting nothing is this form's own way to decline, so driving the
    // widget through every decline wording could only end in "no option
    // matched" - after 90 seconds a field on Thomson Reuters' form.
    if (declinesByLeavingBlank(match.field, match.answer!)) {
      logger.info("left blank to decline, as the form instructs", { label: match.field.label.slice(0, 120) });
      continue;
    }
    const locator = page.locator(`[data-autoapply-idx="${match.field.selectorIndex}"]`).first();
    const value = answerValueForField(match.field, match.answer!);
    const candidates = optionSearchCandidates(match.field, match.answer!, packet.company);
    try {
      if (await hasVisibleCaptchaChallenge(page)) {
        throw new AppError("captcha_required", "Interactive CAPTCHA appeared during form filling");
      }
      await fillControl(page, locator, match.field, value, candidates, choiceLog);
      filled.push({ label: match.field.label, source: match.answer!.source });
      statedAs.set(match.field.label, candidates);
      if (match.field.groupKey) answeredGroups.add(match.field.groupKey);
    } catch (error) {
      if (error instanceof AppError && error.code === "captcha_required") throw error;
      logger.warn("field fill failed", { label: match.field.label, error: String(error) });
      // The reason is what makes a failure actionable. Reporting the bare label
      // sent a Workday prompt back as indistinguishable from a field no answer
      // matched, and the two need opposite fixes - one needs a working click,
      // the other needs an answer.
      if (match.field.required || error instanceof StrayValueError) {
        const reason = String(error instanceof Error ? error.message : error)
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 500);
        failedRequired.push(reason ? `${match.field.label} [fill failed: ${reason}]` : match.field.label);
      }
    }
  }

  const lostChoices = await reassertChoices(page, choiceLog);
  for (const label of lostChoices) {
    logger.warn("choice would not hold", { label });
    const index = filled.findIndex((entry) => entry.label === label);
    if (index >= 0) filled.splice(index, 1);
    failedRequired.push(label);
  }

  for (const field of stalePlaceholderFields(fields, plan)) {
    await page
      .locator(`[data-autoapply-idx="${field.selectorIndex}"]`)
      .first()
      .fill("")
      .catch(() => undefined);
    logger.info("cleared a stale optional value", { label: field.label });
  }

  return { hasForm: true, plan, filled, failedRequired, choiceLog, answeredGroups, statedAs };
}

export async function guardedFillFormPage(
  page: AnyPage,
  packet: SubmissionPacket,
  options: BrowserRunOptions,
  knownApplicationPage = false,
): Promise<Awaited<ReturnType<typeof fillFormPage>> | BrowserRunResult> {
  try {
    if (await hasVisibleCaptchaChallenge(page)) return await captureCaptchaAbort(page, packet, options);
    const result = await fillFormPage(page, packet, options, knownApplicationPage);
    if (await hasVisibleCaptchaChallenge(page)) return await captureCaptchaAbort(page, packet, options, result.filled);
    return result;
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== "captcha_required") throw error;
    return await captureCaptchaAbort(page, packet, options);
  }
}

/**
 * Removes duplicate resume uploads.
 *
 * Workday stores attachments on the saved candidate profile, so every run that
 * uploaded again left another identical copy behind - three of them by the time
 * this was found. Extra copies are deleted so a submitted application carries
 * exactly one resume.
 */
export async function dedupeResumeAttachments(page: AnyPage): Promise<void> {
  const items = page.locator('[data-automation-id="file-upload-item"]');
  for (let guard = 0; guard < 5; guard += 1) {
    const count = await items.count();
    if (count <= 1) return;
    const remove = items.nth(count - 1).locator('button[data-automation-id="delete-file"]');
    if ((await remove.count()) === 0) return;
    await remove.click({ timeout: 5000 }).catch(() => undefined);
    await page.waitForTimeout(1200);
  }
}

export async function attachResume(page: AnyPage, resumePath: string): Promise<boolean> {
  const check = validateResumeFile(resumePath);
  if (!check.ok) {
    throw new AppError("resume_unusable", check.reason, { path: resumePath });
  }
  const fileInput = page.locator('input[type="file"]').first();
  if ((await fileInput.count()) === 0) {
    logger.warn("no file input found on the application form", { url: page.url() });
    return false;
  }
  // A failed upload must abort: submitting without the resume is worse than
  // failing loudly and handing the application back to a person.
  try {
    await fileInput.setInputFiles(resumePath);
  } catch (error) {
    throw new AppError("resume_upload_failed", `could not attach resume: ${String(error)}`, { path: resumePath });
  }
  return true;
}

/**
 * Confirms the board is actually holding the file.
 *
 * Workday accepts the upload asynchronously and does not mark Resume/CV
 * required, so a dropped upload reached the review page as "No Response" and
 * the run still reported success - an application submitted with no resume.
 */
export async function resumeIsAttached(page: AnyPage, resumePath: string): Promise<boolean> {
  const name = resumePath.split(/[\\/]/).pop() ?? "";
  if (!name) return false;
  return (await page.locator(`text=${name}`).count()) > 0;
}
