import { logger } from "../../util/logger.js";
import type { BrowserRunResult } from "../browser/types.js";
import { detectSubmissionConfirmation } from "../form/pageSignals.js";
import type { SubmissionPacket } from "../packet.js";
import {
  clickEnabledButton, markElement, result, resumeUpload, settle, unansweredRadioQuestions, waitFor,
} from "./helpers.js";
import type { CareerSiteHooks, CareerSiteRun, SitePage, StepFill } from "./types.js";

// ---------------------------------------------------------------- Amazon

const AMAZON_CONTINUE = "^(skip & continue|save (?:&|and) continue|continue|next)$";
const AMAZON_DEMOGRAPHIC_STEP = /self[- ]identification|veteran|disability|equal employment/i;

export const AMAZON_CONFIRMATION = /application (?:has been |was )?submitted|thank you for (?:applying|your application)|you(?:'ve| have) (?:successfully )?applied|we(?:'ve| have) received your application/i;

/** The heading of the wizard step on screen: the first visible heading after the progress list. */
async function amazonStepName(page: SitePage): Promise<string> {
  return ((await page.evaluate(
    `(() => {
      const main = document.querySelector('main') || document.body;
      const skip = /^(apply|my progress|optional)$/i;
      const shown = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden'; };
      const heads = Array.from(main.querySelectorAll('h1, h2, h3, legend'))
        .filter(shown)
        .map((h) => (h.innerText || '').replace(/\\s+/g, ' ').trim())
        .filter((t) => t && !skip.test(t) && !/\\(ID: \\d+\\)/.test(t));
      return heads[0] || '';
    })()`,
  )) as string);
}

/** On a self-identification step, every chosen answer must be a decline. */
async function amazonNonDeclineChoices(page: SitePage): Promise<string[]> {
  return (await page.evaluate(
    `(() => {
      const DECLINE = /(not|n't) (wish|want) to|decline|prefer not|choose not|not to (disclose|answer|self)/i;
      const picked = [];
      for (const radio of document.querySelectorAll('input[type="radio"]:checked, input[type="checkbox"]:checked')) {
        const label = (radio.id && document.querySelector('label[for="' + CSS.escape(radio.id) + '"]')) || radio.closest('label');
        const text = ((label && label.innerText) || radio.value || '').replace(/\\s+/g, ' ').trim();
        if (text && !DECLINE.test(text)) picked.push(text);
      }
      for (const select of document.querySelectorAll('select')) {
        const text = (select.options[select.selectedIndex] || {}).text || '';
        if (select.selectedIndex > 0 && !DECLINE.test(text)) picked.push(text.trim());
      }
      return picked;
    })()`,
  )) as string[];
}

const AMAZON_AI_PREFERENCE = /choose your ai preference|amazon uses ai to enhance/i;

/**
 * Amazon's "Choose your AI preference" consent, a Yes / No pair whose labels
 * run on into a description, so a generic filler cannot match "Yes" to them.
 * Answered only from an answer recorded for that question, on the application
 * or in the answer bank.
 */
async function answerAmazonAiPreference(page: SitePage, packet: SubmissionPacket, hooks: CareerSiteHooks): Promise<boolean> {
  const recorded =
    packet.answers.find((answer) => AMAZON_AI_PREFERENCE.test(answer.label) && answer.answer.trim())?.answer.trim() ??
    hooks.resolveChoice("Choose your AI preference", ["Yes", "No"]);
  if (!recorded) return false;
  return (await page.evaluate(
    `(() => {
      const want = ${JSON.stringify(recorded.toLowerCase().startsWith("y") ? "yes" : "no")};
      const radios = Array.from(document.querySelectorAll('input[type="radio"][name="consent-choice"]'));
      if (radios.length === 0 || radios.some((r) => r.checked)) return false;
      for (const radio of radios) {
        const label = (radio.id && document.querySelector('label[for="' + CSS.escape(radio.id) + '"]')) || radio.closest('label');
        const text = ((label && label.innerText) || '').trim().toLowerCase();
        const rect = (label || radio).getBoundingClientRect();
        if (rect.width > 0 && text.startsWith(want)) { (label || radio).click(); return true; }
      }
      return false;
    })()`,
  )) as boolean;
}

/**
 * Amazon renders its choice questions with Select2: the real `<select>` is
 * hidden behind a styled span, so the generic filler never sees them. Each
 * visible one is answered through `resolveChoice` and set on the underlying
 * select, with the change event Select2 and the form listen for.
 */
async function fillAmazonSelects(page: SitePage, hooks: CareerSiteHooks): Promise<{ filled: string[]; open: string[] }> {
  const fields = (await page.evaluate(
    `(() => {
      const shown = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.opacity !== '0'; };
      return Array.from(document.querySelectorAll('select')).map((select, index) => {
        select.setAttribute('data-autoapply-sel', String(index));
        const widget = select.nextElementSibling && /select2/.test(select.nextElementSibling.className) ? select.nextElementSibling : null;
        const labelledBy = widget && widget.querySelector('[aria-labelledby]') && widget.querySelector('[aria-labelledby]').getAttribute('aria-labelledby');
        const label = (labelledBy && document.getElementById(labelledBy) && document.getElementById(labelledBy).innerText)
          || (select.id && document.querySelector('label[for="' + CSS.escape(select.id) + '"]') && document.querySelector('label[for="' + CSS.escape(select.id) + '"]').innerText)
          || select.getAttribute('aria-label') || '';
        return {
          index,
          visible: widget ? shown(widget) : shown(select),
          label: label.replace(/\\s*\\*\\s*$/, '').replace(/\\s+/g, ' ').trim(),
          options: Array.from(select.options).map((o) => o.text.replace(/\\s+/g, ' ').trim()),
          chosen: select.selectedIndex > 0 || (select.selectedIndex === 0 && select.options[0] && select.options[0].value !== ''),
          required: select.required || !!(widget && widget.querySelector('[aria-required="true"]')),
        };
      }).filter((field) => field.visible);
    })()`,
  )) as Array<{ index: number; label: string; options: string[]; chosen: boolean; required: boolean }>;
  const filled: string[] = [];
  const open: string[] = [];
  for (const field of fields) {
    if (field.chosen) continue;
    const offered = field.options.filter((option) => option.length > 0 && !/^select an option$/i.test(option));
    const choice = hooks.resolveChoice(field.label, offered);
    if (!choice) {
      if (field.required) open.push(field.label || "an unlabelled choice");
      continue;
    }
    const set = (await page.evaluate(
      `(() => {
        const select = document.querySelector('[data-autoapply-sel="${field.index}"]');
        const index = Array.from(select.options).findIndex((o) => o.text.replace(/\\s+/g, ' ').trim() === ${JSON.stringify(choice)});
        if (index < 0) return false;
        select.selectedIndex = index;
        select.dispatchEvent(new Event('input', { bubbles: true }));
        select.dispatchEvent(new Event('change', { bubbles: true }));
        if (window.jQuery) window.jQuery(select).trigger('change');
        return select.selectedIndex === index;
      })()`,
    )) as boolean;
    if (set) filled.push(field.label);
    else open.push(field.label);
    await page.waitForTimeout(300);
  }
  return { filled, open };
}

/**
 * Amazon's radio questions carry their wording only in a label the group points
 * at through aria-labelledby, and that label is hidden from assistive tech, so
 * the generic filler sees bare Yes / No pairs. Each visible group with nothing
 * chosen is answered through `resolveChoice` and set by clicking the option's
 * label, which is what the page's own state listens to.
 */
async function answerAmazonRadios(page: SitePage, hooks: CareerSiteHooks): Promise<{ filled: string[]; open: string[] }> {
  const groups = (await page.evaluate(
    `(() => {
      const shown = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden'; };
      const labelFor = (r) => (r.id && document.querySelector('label[for="' + CSS.escape(r.id) + '"]')) || r.closest('label');
      return Array.from(document.querySelectorAll('[role="radiogroup"]')).map((group, index) => {
        group.setAttribute('data-autoapply-rg', String(index));
        const radios = Array.from(group.querySelectorAll('input[type="radio"]'));
        const ref = group.getAttribute('aria-labelledby');
        const question = ((ref && ref.split(/\\s+/).map((id) => document.getElementById(id)).filter(Boolean).map((el) => el.innerText || el.textContent || '').join(' '))
          || group.getAttribute('aria-label') || '').replace(/\\s*\\*\\s*$/, '').replace(/\\s+/g, ' ').trim();
        return {
          index,
          question,
          options: radios.map((r) => ((labelFor(r) && labelFor(r).innerText) || r.value || '').replace(/\\s+/g, ' ').trim()),
          visible: radios.some((r) => shown(r) || shown(labelFor(r))),
          answered: radios.some((r) => r.checked),
          required: radios.some((r) => r.required || r.getAttribute('aria-required') === 'true') || /\\brequired\\b/.test(group.className),
        };
      }).filter((group) => group.visible && !group.answered && group.question);
    })()`,
  )) as Array<{ index: number; question: string; options: string[]; required: boolean }>;
  const filled: string[] = [];
  const open: string[] = [];
  for (const group of groups) {
    if (AMAZON_AI_PREFERENCE.test(group.question)) continue;
    const choice = hooks.resolveChoice(group.question, group.options);
    if (!choice) {
      if (group.required) open.push(group.question);
      continue;
    }
    const marked = (await page.evaluate(
      `(() => {
        document.querySelectorAll('[data-autoapply-pick]').forEach((el) => el.removeAttribute('data-autoapply-pick'));
        const group = document.querySelector('[data-autoapply-rg="${group.index}"]');
        for (const radio of group.querySelectorAll('input[type="radio"]')) {
          const label = (radio.id && document.querySelector('label[for="' + CSS.escape(radio.id) + '"]')) || radio.closest('label');
          const text = ((label && label.innerText) || radio.value || '').replace(/\\s+/g, ' ').trim();
          if (text === ${JSON.stringify(choice)}) { (label || radio).setAttribute('data-autoapply-pick', '1'); return true; }
        }
        return false;
      })()`,
    )) as boolean;
    if (marked) await page.locator("[data-autoapply-pick]").first().click();
    await page.waitForTimeout(300);
    const checked = (await page.evaluate(
      `(() => Array.from(document.querySelectorAll('[data-autoapply-rg="${group.index}"] input[type="radio"]')).some((r) => r.checked))()`,
    )) as boolean;
    if (checked) filled.push(group.question.slice(0, 120));
    else open.push(group.question);
  }
  return { filled, open };
}

/**
 * Amazon keeps one résumé on the candidate profile and pre-completes the
 * Resume step with it, so the wizard never stops there: a new application's
 * review page offered "Resume.pdf, uploaded Aug 29, 2025". It is replaced from
 * the review page's own file input and the new name checked on screen.
 */
async function replaceAmazonResume(page: SitePage, packet: SubmissionPacket): Promise<string | null> {
  const upload = resumeUpload(packet);
  const card = async () =>
    (await page.evaluate(
      `(() => {
        const head = Array.from(document.querySelectorAll('h1, h2, h3, h4')).find((h) => /upload your r[eé]sum[eé]/i.test(h.innerText || ''));
        let box = head;
        for (let i = 0; i < 3 && box && box.parentElement; i += 1) box = box.parentElement;
        return ((box && box.innerText) || '').replace(/\\s+/g, ' ');
      })()`,
    )) as string;
  const before = await card();
  const input = page.locator('#document-replace-input, input[type="file"]').first();
  if ((await input.count()) === 0) return "Amazon's review page offered no way to replace the résumé on file";
  await input.setInputFiles(upload);
  let after = "";
  // Amazon parses the file before showing it: "Resume upload in progress...
  // Please wait" sat on screen for over 45 seconds on one run. The card then
  // reads "Uploaded: Just now" - as it did before a re-upload minutes later -
  // so passing through that progress state is what proves this upload ran.
  let sawProgress = false;
  const replaced = await waitFor(
    page,
    async () => {
      after = await card();
      if (/upload in progress|please wait/i.test(after)) {
        sawProgress = true;
        return false;
      }
      return after.includes(upload.name) && (sawProgress || after !== before);
    },
    150_000,
  );
  if (!replaced) {
    return /upload in progress|please wait/i.test(after)
      ? "Amazon's résumé upload did not finish processing within 150 seconds"
      : `the résumé on Amazon's review page did not change to ${upload.name}`;
  }
  logger.info("amazon resume replaced", { file: upload.name });
  return null;
}

/** Every question and answer Amazon's review page states, read after expanding each section. */
async function amazonReviewAnswers(page: SitePage): Promise<Array<{ section: string; question: string; answer: string }>> {
  const toggles = (await page.evaluate(
    `(() => {
      const found = Array.from(document.querySelectorAll('a, button, [role="button"], span, div'))
        .filter((el) => /^show all answers/i.test((el.innerText || '').trim()) && !Array.from(el.children).some((c) => /^show all answers/i.test((c.innerText || '').trim())));
      found.forEach((el, index) => el.setAttribute('data-autoapply-toggle', String(index)));
      return found.length;
    })()`,
  )) as number;
  for (let index = 0; index < toggles; index += 1) {
    await page.locator(`[data-autoapply-toggle="${index}"]`).first().click({ timeout: 5000 }).catch(() => undefined);
    await page.waitForTimeout(400);
  }
  return (await page.evaluate(
    `(() => {
      const pairs = [];
      // Each section is a tabpanel named after its step; each question carries
      // a data-questionid, its wording in the "-label" label and its answer in
      // .input-display-mode behind an "A." prefix and screen-reader text.
      for (const panel of document.querySelectorAll('[role="tabpanel"][aria-label]')) {
        const section = (panel.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim();
        for (const item of panel.querySelectorAll('.question[data-questionid]')) {
          // The review page is itself a tabpanel around every section.
          if (item.closest('[role="tabpanel"]') !== panel) continue;
          const label = item.querySelector('label[id$="-label"]');
          const display = item.querySelector('.input-display-mode');
          if (!label || !display) continue;
          const answer = display.cloneNode(true);
          answer.querySelectorAll('.answer-prefix, .sr-only').forEach((node) => node.remove());
          pairs.push({
            section,
            question: (label.innerText || label.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 1500),
            answer: (answer.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 200),
          });
        }
      }
      return pairs;
    })()`,
  )) as Array<{ section: string; question: string; answer: string }>;
}

const SELF_ID_DECLINE = /(?:not|n't) (?:wish|want) to|decline|prefer not|choose not|not to (?:disclose|answer|self)/i;
/** A veteran-status answer stating the candidate is not one: a fact on file, not an identity the run chose. */
const VETERAN_NEGATIVE = /^no\b|\bnot an? (?:protected )?veteran\b|\bdo not believe\b/i;
/** Questions with legal weight, where an answer on file must agree with the record before anything is sent. */
const ELIGIBILITY_QUESTION = /sponsor|immigration|\bvisa\b|authori[sz]ed to work|work authori[sz]ation/i;

/**
 * Yes / No eligibility answers the review page states but the record answers
 * the other way. Amazon pre-completes answers from the candidate profile and
 * fills the rest in the wizard, so the review page is the one place both can
 * be checked together: a sponsorship question defining sponsorship to include
 * TN went out as "No" once, when the record answers it "Yes".
 */
export function contradictedEligibilityAnswers(
  stated: ReadonlyArray<{ question: string; answer: string }>,
  hooks: Pick<CareerSiteHooks, "resolveChoice">,
): string[] {
  const problems: string[] = [];
  for (const pair of stated) {
    if (!ELIGIBILITY_QUESTION.test(pair.question) || !/^(?:yes|no)$/i.test(pair.answer.trim())) continue;
    const expected = hooks.resolveChoice(pair.question, ["Yes", "No"]);
    if (expected && expected.toLowerCase() !== pair.answer.trim().toLowerCase()) {
      problems.push(`${pair.question.slice(0, 80)}... states "${pair.answer}" but the record answers "${expected}"`);
    }
  }
  return problems;
}

export async function walkAmazon(run: CareerSiteRun): Promise<BrowserRunResult> {
  const { page, packet, hooks } = run;
  await page.goto(packet.applyUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await settle(page, 5000);
  const host = new URL(page.url()).hostname;
  if (host !== "www.amazon.jobs" && host !== "account.amazon.jobs") {
    return result("aborted", "not signed in to Amazon.jobs in the career-site browser profile; sign in again by hand", page, {
      screenshotPath: await hooks.capture("amazon-signin"),
    });
  }
  const filled: StepFill["filled"] = [];
  let resumeDone = false;
  let previous = "";
  let repeats = 0;
  for (let step = 0; step < 16; step += 1) {
    if (await answerAmazonAiPreference(page, packet, hooks)) {
      filled.push({ label: "Choose your AI preference", source: "human" });
      await page.waitForTimeout(1000);
    }
    const name = await amazonStepName(page);
    const text = await hooks.readText();
    if (AMAZON_CONFIRMATION.test(text)) break;
    if (/review (?:&|and) submit|review your application/i.test(name) || (await markElement(page, 'button, [role="button"], a', "^submit application$"))) break;
    repeats = name === previous ? repeats + 1 : 0;
    previous = name;
    if (repeats >= 2) {
      return result("aborted", `Amazon's "${name}" step would not advance`, page, {
        filledFields: filled,
        screenshotPath: await hooks.capture("amazon-stuck"),
      });
    }
    if (!resumeDone) {
      const input = page.locator('input[type="file"]');
      if ((await input.count()) > 0 && /r[eé]sum[eé]/i.test(name)) {
        await input.first().setInputFiles(resumeUpload(packet));
        await page.waitForTimeout(4000);
        resumeDone = true;
        filled.push({ label: "Resume", source: "profile" });
      }
    }
    if (!/sms/i.test(name)) {
      const fill = await hooks.fillStep();
      if ("status" in fill) return { ...fill, filledFields: [...filled, ...fill.filledFields] };
      filled.push(...fill.filled);
      const selects = await fillAmazonSelects(page, hooks);
      for (const label of selects.filled) filled.push({ label, source: "profile" });
      const radios = await answerAmazonRadios(page, hooks);
      for (const label of radios.filled) filled.push({ label, source: "profile" });
      // The AI-preference pair sits in the DOM of every step but is answered by
      // answerAmazonAiPreference where it is shown; the generic filler cannot
      // read its run-on labels, so its complaint about it is not a blocker.
      const problems = [
        ...fill.problems.filter((problem) => !AMAZON_AI_PREFERENCE.test(problem)),
        ...selects.open,
        ...radios.open,
        ...(await unansweredRadioQuestions(page)).filter(
          (problem) =>
            !AMAZON_AI_PREFERENCE.test(problem) && !radios.open.some((question) => question.slice(0, 120) === problem.slice(0, 120)),
        ),
      ];
      if (AMAZON_DEMOGRAPHIC_STEP.test(name)) {
        const chosen = await amazonNonDeclineChoices(page);
        if (chosen.length > 0) problems.push(`self-identification answered with ${chosen.join(", ")} instead of a decline`);
      }
      if (problems.length > 0) {
        return result("aborted", `required field(s) could not be filled on "${name}": ${problems.join("; ")}`, page, {
          filledFields: filled,
          unmatchedRequired: problems,
          screenshotPath: await hooks.capture("amazon-unfilled"),
        });
      }
    }
    if (!(await clickEnabledButton(page, AMAZON_CONTINUE, 'button, [role="button"], a'))) {
      return result("aborted", `no way forward from Amazon's "${name}" step`, page, {
        filledFields: filled,
        screenshotPath: await hooks.capture("amazon-no-continue"),
      });
    }
    await settle(page, 3500);
  }

  const resumeProblem = await replaceAmazonResume(page, packet);
  if (resumeProblem) {
    return result("aborted", resumeProblem, page, { filledFields: filled, screenshotPath: await hooks.capture("amazon-resume") });
  }
  filled.push({ label: "Resume", source: "profile" });
  // The self-identification and eligibility answers on file were pre-completed
  // from the candidate profile, so the wizard never showed them: read them back.
  const stated = await amazonReviewAnswers(page);
  logger.info("amazon review answers", { answers: stated.map((pair) => `${pair.section} | ${pair.question.slice(0, 90)} => ${pair.answer}`) });
  const undeclined = stated.filter(
    (pair) =>
      AMAZON_DEMOGRAPHIC_STEP.test(pair.section) &&
      pair.answer &&
      !SELF_ID_DECLINE.test(pair.answer) &&
      !(/veteran/i.test(pair.section) && VETERAN_NEGATIVE.test(pair.answer)),
  );
  const reviewShot = await hooks.capture("amazon-review");
  if (undeclined.length > 0) {
    return result(
      "aborted",
      `self-identification on file is not a decline: ${undeclined.map((pair) => `${pair.question.slice(0, 60)} => ${pair.answer}`).join("; ")}`,
      page,
      { filledFields: filled, screenshotPath: reviewShot },
    );
  }
  const contradicted = contradictedEligibilityAnswers(stated, hooks);
  if (contradicted.length > 0) {
    return result(
      "aborted",
      `the review states an eligibility answer the record contradicts: ${contradicted.join("; ")}`,
      page,
      { filledFields: filled, screenshotPath: reviewShot },
    );
  }
  if (!run.submit) {
    return result("prepared", "Amazon application filled to its review step; Submit not pressed", page, {
      filledFields: filled,
      screenshotPath: reviewShot,
    });
  }
  if (await answerAmazonAiPreference(page, packet, hooks)) {
    filled.push({ label: "Choose your AI preference", source: "human" });
    await page.waitForTimeout(1000);
  }
  if (!(await clickEnabledButton(page, "^submit application$", 'button, [role="button"], a'))) {
    return result("aborted", "the Submit application button on Amazon's review step was missing or disabled", page, {
      filledFields: filled,
      screenshotPath: reviewShot,
    });
  }
  // Amazon asks for the AI preference in a dialog that opens only once Submit
  // is pressed ("Before you continue, do we have permission to improve your
  // job search and interview experience?"); the application waits behind it.
  await page.waitForTimeout(2500);
  if (await answerAmazonAiPreference(page, packet, hooks)) {
    filled.push({ label: "Choose your AI preference", source: "human" });
    await page.waitForTimeout(800);
    const continued =
      (await clickEnabledButton(page, "^continue$", '[role="dialog"] button, .modal button')) ||
      (await clickEnabledButton(page, "^continue$", 'button, [role="button"]'));
    if (!continued) {
      return result("aborted", "Amazon's AI-preference dialog offered no Continue button", page, {
        filledFields: filled,
        screenshotPath: await hooks.capture("amazon-ai-preference"),
      });
    }
  }
  let text = "";
  const confirmed = await waitFor(
    page,
    async () => {
      text = await hooks.readText();
      return AMAZON_CONFIRMATION.test(text) || detectSubmissionConfirmation(text, page.url());
    },
    60_000,
  );
  const shot = await hooks.capture(confirmed ? "confirmation" : "amazon-after-submit");
  return result(
    confirmed ? "submitted" : "aborted",
    confirmed
      ? "Amazon application submitted; confirmation captured"
      : "Submit was pressed but Amazon showed no confirmation; check the Amazon.jobs dashboard",
    page,
    { filledFields: filled, screenshotPath: shot, confirmationText: text.replace(/\s+/g, " ").slice(0, 600) },
  );
}
