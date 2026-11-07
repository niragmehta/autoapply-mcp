import { readFile, rm, writeFile } from "node:fs/promises";
import { logger } from "../../util/logger.js";
import { workdayTenant } from "../workdayFlow.js";
import {
  fetchVerificationCode,
  fetchVerificationLink,
  readVerificationInboxConfig,
  type VerificationInboxConfig,
} from "../verificationInbox.js";
import type { AnyLocator, AnyPage } from "./playwright.js";
import { clickSubmit } from "./submit.js";
import type { BrowserRunOptions } from "./types.js";

const VERIFICATION_SUBMIT_SELECTORS = [
  'form:has(input[maxlength="1"]) button[type="submit"]',
  'form:has(input[maxlength="1"]) button:has-text("Submit")',
  'form:has(input[maxlength="1"]) button:has-text("Confirm")',
  'form:has(input[maxlength="1"]) button:has-text("Verify")',
];

/**
 * Whether a run can hold the browser at a verification gate.
 *
 * Two independent readers can supply the code: a file a person writes, and a
 * configured mailbox. Either is sufficient on its own. This used to demand the
 * file, so a run with only a mailbox returned instantly and reported that no
 * code had arrived, on a form that was otherwise completely filled.
 */
export function canAwaitVerificationCode(options: {
  codeWaitMs?: number;
  codeFilePath?: string;
  verificationInbox?: VerificationInboxConfig | null;
}): boolean {
  if ((options.codeWaitMs ?? 0) <= 0) return false;
  const inbox = options.verificationInbox ?? readVerificationInboxConfig();
  return Boolean(options.codeFilePath) || Boolean(inbox);
}

/**
 * Reads the link Workday emails to verify a candidate account, from the
 * mailbox that already supplies one-time codes and within the same wait
 * budget. Without both, an account awaiting verification is left for a person
 * as before: a link has no file hand-off, so only the mailbox can supply one.
 */
export function workdayVerificationLinkReader(
  options: { codeWaitMs?: number; verificationInbox?: VerificationInboxConfig | null },
  pageUrl: string,
  fetchLink: typeof fetchVerificationLink = fetchVerificationLink,
): ((since: Date) => Promise<string | null>) | undefined {
  const timeoutMs = options.codeWaitMs ?? 0;
  const inbox = options.verificationInbox ?? readVerificationInboxConfig();
  if (timeoutMs <= 0 || !inbox) return undefined;
  const tenant = workdayTenant(pageUrl);
  return (since) => fetchLink(inbox, { since, timeoutMs, tenant });
}

/**
 * Holds the session open at a verification gate, polling for the code.
 *
 * The code is bound to the submit that requested it, so it cannot survive into
 * a later run: re-submitting to supply an old code is exactly what invalidates
 * it. Waiting here keeps one browser session alive across the round trip to
 * whoever is reading the inbox, which is the only point at which the code is
 * still good.
 *
 * A mailbox read that fails - a dropped IMAP connection included - counts as
 * "no code yet": the gate stays open and the next poll reconnects, until the
 * deadline. Aborting there would throw away a fully filled form over a blip.
 */
export async function awaitVerificationCode(
  options: BrowserRunOptions,
  page: AnyPage,
  emailedAt: Date,
): Promise<string | undefined> {
  const waitMs = options.codeWaitMs ?? 0;
  const path = options.codeFilePath;
  const inbox = options.verificationInbox ?? readVerificationInboxConfig();
  if (!canAwaitVerificationCode(options)) return undefined;

  // A code emailed before this moment is already dead, so whoever is reading
  // the inbox needs to know when this attempt's code was sent rather than
  // guessing which of several similar emails is current.
  const signalPath = path ? `${path}.waiting` : undefined;
  if (signalPath) {
    await writeFile(signalPath, emailedAt.toISOString(), "utf8").catch(() => undefined);
  }

  try {
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      const code = path
        ? await readFile(path, "utf8")
            .then((text) => text.trim())
            .catch(() => "")
        : "";
      if (code && path) {
        // Consumed, so a stale code from an earlier attempt can never be picked
        // up by the next one.
        await rm(path, { force: true }).catch(() => undefined);
        return code;
      }
      // A configured mailbox is a second reader of the same round trip, not a
      // replacement: a person can still drop the code in the file at any point,
      // and whichever arrives first wins.
      if (inbox) {
        const emailed = await fetchVerificationCode(inbox, emailedAt).catch((error: unknown) => {
          logger.warn("verification inbox unreadable", { detail: String(error) });
          return null;
        });
        if (emailed) return emailed;
      }
      await page.waitForTimeout(2000);
    }
    return undefined;
  } finally {
    if (signalPath) await rm(signalPath, { force: true }).catch(() => undefined);
  }
}

/**
 * Selectors for the box a board shows after emailing a one-time code. Ordered
 * most specific first so a generic text input is only ever a last resort, and
 * that last resort is confined to a box short enough to be a code field.
 */
const VERIFICATION_INPUT_SELECTORS = [
  'input[name*="verification" i]',
  'input[id*="verification" i]',
  'input[name*="confirmation_code" i]',
  'input[autocomplete="one-time-code"]',
  'input[name*="otp" i]',
  'input[id*="otp" i]',
  'input[aria-label*="code" i]',
  'input[placeholder*="code" i]',
  'input[name*="code" i]',
  'input[id*="code" i]',
];

/**
 * Types an emailed one-time code and confirms it. Handles both a single box
 * and the segmented one-character-per-box layout Greenhouse renders, where a
 * fill() into any one box would only ever deliver a single character.
 *
 * Returns false when no code box can be found, so the caller reports the gate
 * rather than claiming an attempt that never happened.
 */
/**
 * Enters the code and sends it, returning a description of the action taken or
 * null when nothing could be entered.
 *
 * The description is not decoration. A gate that is still on screen afterwards
 * means either a refused code or a button that was never pressed, and those have
 * opposite remedies. Every diagnosis costs a fresh code and another round trip
 * to whoever reads the inbox, so the run records what it did rather than leaving
 * the next attempt to guess.
 */
export async function enterVerificationCode(page: AnyPage, code: string): Promise<string | null> {
  const trimmed = code.trim();
  if (!trimmed) return null;

  const lastBox = await fillSegmentedCode(page, trimmed);
  if (lastBox) {
    const action = await submitVerificationCode(page, lastBox);
    return action ? `filled ${trimmed.length} segmented boxes, then ${action}` : null;
  }

  for (const selector of VERIFICATION_INPUT_SELECTORS) {
    const locator = page.locator(selector).first();
    if ((await locator.count()) === 0) continue;
    if (!(await locator.isVisible().catch(() => false))) continue;
    await locator.fill(trimmed).catch(() => undefined);
    const value = await locator.inputValue?.().catch(() => "");
    // Only report success once the box actually holds the code. A readonly or
    // shadowed input accepts fill() silently and would otherwise look filled.
    if (value !== undefined && value !== trimmed) continue;
    const action = await submitVerificationCode(page, locator);
    return action ? `filled ${selector}, then ${action}` : null;
  }
  return null;
}

/**
 * The code gate renders its own submit control, while the job post it sits under
 * usually still carries an apply control earlier in the document. Clicking the
 * first submit-looking button on the page therefore lands on the wrong one and
 * the correctly typed code is never sent, which reads exactly like a refused
 * code. The search is scoped to the form owning the code boxes, and falls back
 * to pressing Enter in the code field itself.
 */
const DESCRIBE_GATE = `(() => {
  const boxes = Array.from(document.querySelectorAll('input[maxlength="1"]'));
  if (boxes.length === 0) return 'no code boxes present';
  const first = boxes[0];
  const form = first.closest('form');
  const scope = form || (first.parentElement && first.parentElement.parentElement) || document;
  const controls = Array.from(scope.querySelectorAll('button, input[type=submit]')).slice(0, 6).map((node) => {
    const text = (node.innerText || node.value || node.getAttribute('aria-label') || '').trim().slice(0, 30);
    const type = node.getAttribute('type') || '-';
    return node.tagName.toLowerCase() + '[type=' + type + ']' + (node.disabled ? '[disabled]' : '') + '"' + text + '"';
  });
  const values = boxes.map((el) => el.value || '_').join('');
  return 'form=' + (form ? 'yes' : 'no') + ' boxes="' + values + '" controls=' + (controls.length ? controls.join(', ') : 'none');
})()`;

/**
 * Describes the controls a persistent code gate offers, so a run that failed
 * because nothing was clicked can be told apart from one that failed because
 * the code was genuinely refused. Reading this costs nothing; guessing wrong
 * costs another emailed code and another round trip to the candidate.
 */
export async function describeVerificationGate(page: AnyPage): Promise<string> {
  const described = await page.evaluate(DESCRIBE_GATE).catch(() => "");
  return typeof described === "string" ? described : "";
}

/**
 * Clicks the control that belongs to the code gate, identified by proximity to
 * the code boxes rather than by type or wording. Greenhouse puts the boxes
 * inside the whole application form and gives the gate an unlabelled
 * `type=button` arrow, so neither a submit-type search nor a text search can
 * find it, and a form-wide search finds "Remove file" instead.
 *
 * The scope widens one ancestor at a time and stops as soon as a container
 * holds a small, unambiguous set of controls. A container crowded with buttons
 * belongs to the form rather than the gate, so it is refused instead of clicked.
 */
const CLICK_CODE_SUBMIT = `(() => {
  const boxes = Array.from(document.querySelectorAll('input[maxlength="1"]'));
  if (boxes.length === 0) return 'no-boxes';
  const last = boxes[boxes.length - 1];
  let scope = last.parentElement;
  while (scope && boxes.some((box) => !scope.contains(box))) scope = scope.parentElement;
  if (!scope) return 'no-scope';
  for (let depth = 0; depth < 4 && scope; depth += 1) {
    const controls = Array.from(scope.querySelectorAll('button, input[type=submit]')).filter((node) => {
      return !node.disabled && node.getClientRects().length > 0;
    });
    if (controls.length > 2) return 'ambiguous:' + controls.length;
    if (controls.length > 0) {
      const target = controls[controls.length - 1];
      const label = (target.innerText || target.value || target.getAttribute('aria-label') || 'unlabelled').trim().slice(0, 30);
      target.click();
      return 'clicked:' + label;
    }
    scope = scope.parentElement;
  }
  return 'no-control';
})()`;

/**
 * Sends the entered code, returning what it did: the label of the control it
 * clicked, the selector it fell back to, or the key it pressed. Returns "" when
 * nothing could be actioned.
 */
export async function submitVerificationCode(page: AnyPage, codeField: AnyLocator): Promise<string> {
  const nearby = await page.evaluate(CLICK_CODE_SUBMIT).catch(() => "");
  if (typeof nearby === "string" && nearby.startsWith("clicked:")) return `clicked gate control ${nearby.slice(8)}`;
  // Records why the proximity search declined, because "ambiguous:7" and
  // "no-boxes" call for different fixes.
  const declined = typeof nearby === "string" && nearby ? ` (proximity search returned ${nearby})` : "";

  for (const selector of VERIFICATION_SUBMIT_SELECTORS) {
    const locator = page.locator(selector).first();
    if ((await locator.count().catch(() => 0)) === 0) continue;
    if (!(await locator.isVisible().catch(() => false))) continue;
    await locator.click().catch(() => undefined);
    return `clicked ${selector}${declined}`;
  }
  const pressed = await codeField
    .press?.("Enter")
    .then(() => true)
    .catch(() => false);
  if (pressed) return `pressed Enter in the code field${declined}`;
  return (await clickSubmit(page)) ? `clicked the form's submit control${declined}` : "";
}

/**
 * Fills a row of single-character boxes, one character each. Requires exactly
 * as many boxes as the code has characters, so a partial code is never left
 * sitting in a form that would then be submitted incomplete. Returns the last
 * box so the caller can submit from inside the code field.
 */
export async function fillSegmentedCode(page: AnyPage, code: string): Promise<AnyLocator | null> {
  const boxes = page.locator('input[maxlength="1"]');
  const total = await boxes.count().catch(() => 0);
  if (total === 0) return null;

  const visible: AnyLocator[] = [];
  for (let i = 0; i < total; i += 1) {
    const box = boxes.nth(i);
    if (await box.isVisible().catch(() => false)) visible.push(box);
  }
  if (visible.length !== code.length) return null;

  for (let i = 0; i < code.length; i += 1) {
    await visible[i]!.fill(code[i]!).catch(() => undefined);
  }

  // Confirm every box took its character before clicking anything. Some
  // components rewrite or clear input they consider invalid.
  for (let i = 0; i < code.length; i += 1) {
    const value = await visible[i]!.inputValue?.().catch(() => undefined);
    if (value !== undefined && value !== code[i]) return null;
  }
  return visible[code.length - 1] ?? null;
}
