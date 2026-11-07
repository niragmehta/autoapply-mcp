import { detectSubmissionConfirmation } from "../form/pageSignals.js";
import { READ_VALIDATION_ERRORS } from "../validationErrors.js";
import { readBodyText } from "./capture.js";
import type { AnyPage } from "./playwright.js";

const SUBMIT_SELECTORS = [
  'button[type="submit"]',
  'input[type="submit"]',
  'button:has-text("Submit application")',
  'button:has-text("Submit Application")',
  'button:has-text("Submit")',
  'button:has-text("Apply")',
];

/**
 * How long to keep looking for a confirmation before deciding one never came.
 * Single-page boards re-render in place after the POST returns, so "load state
 * is idle" is not the same as "the outcome is on screen". Polling ends as soon
 * as an outcome appears, so the ceiling only costs time on a silent page - and
 * a Greenhouse embed has been seen taking ~29s to raise its security-code gate,
 * which a 30s ceiling reported as "no confirmation detected".
 */
const SUBMISSION_OUTCOME_TIMEOUT_MS = 60_000;
// A code-verified submit is slower than an ordinary one: the board revalidates
// the whole application behind the gate, and its button sits disabled with a
// spinner the entire time.
export const VERIFIED_SUBMIT_TIMEOUT_MS = 120_000;
const SUBMISSION_OUTCOME_POLL_MS = 1_000;

/**
 * Reads the page repeatedly until it shows a submission outcome.
 *
 * Sampling once shortly after the click reports "no confirmation" for any board
 * that takes a moment to render one, and that verdict is worse than a slow
 * answer: it says an application failed when it was in fact accepted, and the
 * obvious response - submit again - sends the employer a duplicate.
 *
 * Polling stops early on a confirmation, and also on a validation error, since
 * a form that is objecting to its own contents is not going to confirm.
 */
/**
 * The verification gate is an outcome the first time it appears - the board
 * asked for a code, so there is nothing left to wait for. After a code has been
 * sent it is the opposite: the gate stays on screen with its button spinning
 * while the submission is in flight, so treating it as an outcome ends the wait
 * before the board has answered and reports an accepted code as a refused one.
 */
export async function waitForSubmissionOutcome(
  page: AnyPage,
  options: { gateIsOutcome?: boolean; timeoutMs?: number } = {},
): Promise<string> {
  const gateIsOutcome = options.gateIsOutcome ?? true;
  const deadline = Date.now() + (options.timeoutMs ?? SUBMISSION_OUTCOME_TIMEOUT_MS);
  let text = await readBodyText(page);
  while (Date.now() < deadline) {
    if (detectSubmissionConfirmation(text, page.url())) return text;
    if (gateIsOutcome && detectVerificationCodeGate(text)) return text;
    if ((await readValidationErrors(page)).length > 0) return readBodyText(page);
    await page.waitForTimeout(SUBMISSION_OUTCOME_POLL_MS);
    text = await readBodyText(page);
  }
  return text;
}

export async function clickSubmit(page: AnyPage): Promise<boolean> {
  // Workday's review page carries no button[type=submit] at all: the control is
  // the same footer button that says "Save and Continue" on every earlier step
  // and "Submit" on the last one. Without this the generic selectors find
  // nothing and a fully filled application is reported as unsubmittable.
  const footer = page.locator('[data-automation-id="pageFooterNextButton"]').first();
  if ((await footer.count()) > 0 && (await footer.isVisible().catch(() => false))) {
    const label = ((await (footer as { textContent?: () => Promise<string | null> }).textContent?.().catch(() => "")) ?? "").trim();
    if (/submit/i.test(label)) {
      await footer.click();
      return true;
    }
  }
  for (const selector of SUBMIT_SELECTORS) {
    const locator = page.locator(selector).first();
    if ((await locator.count()) > 0 && (await locator.isVisible().catch(() => false))) {
      await locator.click();
      return true;
    }
  }
  return false;
}

/**
 * Ashby greys its submit button by setting `aria-disabled`, which Playwright
 * still considers clickable, so the click lands on a control that ignores it:
 * no navigation, no error, no request. Recording the button's own state turns
 * that silent nothing into a reportable cause.
 */
export async function describeSubmitControl(page: AnyPage): Promise<string> {
  for (const selector of SUBMIT_SELECTORS) {
    const locator = page.locator(selector).first();
    if ((await locator.count()) === 0) continue;
    if (!(await locator.isVisible().catch(() => false))) continue;
    const ariaDisabled = await locator.getAttribute("aria-disabled").catch(() => null);
    const enabled = (await locator.isEnabled?.().catch(() => true)) ?? true;
    if (!enabled || ariaDisabled === "true") {
      return `submit control was disabled when clicked (aria-disabled=${ariaDisabled ?? "none"}, enabled=${enabled})`;
    }
    return "";
  }
  return "";
}

const HOLD_POLL_MS = 3_000;

/**
 * Waits out an assisted hold, returning the confirmation as soon as the
 * person's own submission lands rather than keeping a finished window open for
 * the rest of the hold, which also left the submission unrecorded until a
 * person said so. Wording already on the form before anything was submitted is
 * not evidence, so then only a move to a new page counts. Undefined when the
 * hold ends, or the window is closed, without a confirmation.
 */
export async function awaitHumanSubmission(page: AnyPage, keepOpenMs: number): Promise<string | undefined> {
  const startUrl = page.url();
  const confirmedBefore = detectSubmissionConfirmation(await readBodyText(page), startUrl);
  for (let waited = 0; waited < keepOpenMs; waited += HOLD_POLL_MS) {
    try {
      await page.waitForTimeout(Math.min(HOLD_POLL_MS, keepOpenMs - waited));
    } catch {
      return undefined;
    }
    const url = page.url();
    const text = await readBodyText(page);
    if (detectSubmissionConfirmation(text, url) && (!confirmedBefore || url !== startUrl)) return text || url;
  }
  return undefined;
}

/**
 * Greenhouse increasingly emails a one-time code and refuses the submission
 * until it is typed back in. That is not a failed submission and not an
 * anti-bot challenge in the CAPTCHA sense: the form is complete and correct,
 * and only a human with mailbox access can finish it. Reporting it as "no
 * confirmation detected" hid the one fact that decides what to do next, so it
 * is now named. Returns the employer's own wording where it can be quoted.
 */
export function detectVerificationCodeGate(text: string): string | undefined {
  const flat = text.replace(/\s+/g, " ");
  const patterns = [
    /a verification code was sent to .{1,120}?\.(?=\s|$)/i,
    /enter the \d+[- ]character code to confirm you'?re a human\.?/i,
    /we (?:have )?sent a (?:one[- ]time |verification |security )?code to .{1,120}?\.(?=\s|$)/i,
    /check your email for a (?:verification|security|one[- ]time) code/i,
  ];
  for (const pattern of patterns) {
    const hit = pattern.exec(flat);
    if (hit) return hit[0].trim();
  }
  return undefined;
}

/**
 * Reads the board's own complaints, waiting for them to render.
 *
 * Ashby paints its "Your form needs corrections" block after the click has
 * already settled the page, so a single read races it and comes back empty -
 * which is how an Abridge submission was reported as an unexplained "no
 * confirmation" while the screenshot plainly showed the board naming a field.
 * Polling only costs time on a run that has already failed.
 */
export async function readValidationErrors(page: AnyPage): Promise<string[]> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      const errors = (await page.evaluate(READ_VALIDATION_ERRORS)) as unknown;
      const list = Array.isArray(errors) ? errors.filter((entry): entry is string => typeof entry === "string") : [];
      if (list.length > 0) return list;
    } catch {
      return [];
    }
    await page.waitForTimeout(800);
  }
  return [];
}
