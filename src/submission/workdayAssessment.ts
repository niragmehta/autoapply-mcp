import { isWorkdayUrl } from "./workdayFlow.js";

/**
 * Workday's "Take Assessment" step when the assessment is the Work Opportunity
 * Tax Credit questionnaire.
 *
 * WOTC is a federal hiring incentive: the employer asks about veteran status,
 * public assistance and similar circumstances so that it can claim a tax
 * credit. Fiserv's step says taking part is "completely voluntary" and that a
 * candidate who does not wish to should click "Take Assessment" followed by
 * "Opt Out". Until one of the two happens the step refuses to save ("You must
 * complete the assessment test to continue"), so the run stalled there with
 * every question already answered.
 *
 * Opting out discloses nothing, which is the candidate's standing choice for
 * every voluntary disclosure. Any other assessment - a skills test, a
 * personality inventory - is the candidate's to take, so only a step that names
 * the tax credit and offers the opt-out is handled here.
 */

type Locator = {
  nth: (index: number) => Locator;
  count: () => Promise<number>;
  click: (options?: unknown) => Promise<void>;
  isVisible: () => Promise<boolean>;
  innerText: () => Promise<string>;
  getAttribute?: (name: string) => Promise<string | null>;
};

/** A page, a popup window or one of their frames: anywhere a vendor screen can render. */
export type AssessmentSurface = {
  locator: (selector: string) => Locator;
  url: () => string;
};

export type AssessmentPage = AssessmentSurface & {
  waitForTimeout: (ms: number) => Promise<void>;
  waitForLoadState: (state: string, options?: unknown) => Promise<void>;
  waitForEvent?: (event: string, options?: unknown) => Promise<unknown>;
  goto?: (url: string, options?: unknown) => Promise<unknown>;
  frames?: () => AssessmentSurface[];
  mainFrame?: () => AssessmentSurface;
  isClosed?: () => boolean;
  close?: () => Promise<void>;
  bringToFront?: () => Promise<void>;
};

export type AssessmentOutcome = { optedOut: boolean; detail: string };

/** Photographs a page at a named stage, for the run's artifacts. */
export type AssessmentSnapshot = (target: AssessmentPage, stage: string) => Promise<void>;

const TAX_CREDIT = /\bwork opportunity tax credit\b|\bwotc\b/i;
const OPT_OUT_WORDS = /\bopt(?:ing)?[\s-]?out\b/i;

/** Whether a step's text is the tax-credit questionnaire and says it can be declined. */
export function isTaxCreditOptOutStep(text: string): boolean {
  return TAX_CREDIT.test(text) && OPT_OUT_WORDS.test(text);
}

const CLICKABLE = 'button, a, [role="button"], input[type="button"], input[type="submit"]';
const CHOICE = 'label, [role="radio"]';
const LAUNCH = /^take (?:the )?assessment$/i;
const OPT_OUT_CONTROL = /\bopt[\s-]?out\b|\bdo not wish to participate\b|\bdecline to participate\b/i;
// A privacy banner's opt-out concerns cookies or the sale of data, not the questionnaire.
const UNRELATED_OPT_OUT = /\b(?:cookies?|sell|sale|share|sharing|marketing|texts?|sms|e-?mails?|advertis\w*)\b/i;
const SEND = /^(?:next|continue|submit|done|finish|save)\b/i;
// Exact words only: "Yes, I want to participate" must never pass for a confirmation.
const CONFIRM = /^(?:yes|confirm|ok|opt[\s-]?out)$/i;
const CONFIRM_PROMPT = /\bare you sure\b|\bconfirm (?:that )?you (?:want|wish)\b/i;
const RETURN =
  /^(?:return|go back|back) to (?:the |your )?(?:job )?(?:application|workday)\b|^continue (?:to|with) (?:the |your )?(?:job )?application\b|^close(?: (?:this )?window)?$/i;
const MAX_CONTROL_TEXT = 80;
const POPUP_WAIT_MS = 10_000;
const SETTLE_MS = 2500;
const POLL_MS = 2000;
const FIND_ATTEMPTS = 8;
const FINISH_ATTEMPTS = 10;

type Found = { control: Locator; text: string; surface: AssessmentSurface };

async function controlText(control: Locator): Promise<string> {
  const text = (await control.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
  if (text) return text;
  // A submit input carries its caption in its value, not its text.
  return ((await control.getAttribute?.("value").catch(() => null)) ?? "").replace(/\s+/g, " ").trim();
}

async function visibleControls(surface: AssessmentSurface, selector: string): Promise<Found[]> {
  const all = surface.locator(selector);
  const count = Math.min(await all.count().catch(() => 0), 60);
  const found: Found[] = [];
  for (let index = 0; index < count; index += 1) {
    const control = all.nth(index);
    if (!(await control.isVisible().catch(() => false))) continue;
    const text = await controlText(control);
    if (text) found.push({ control, text, surface });
  }
  return found;
}

async function findControl(
  surfaces: readonly AssessmentSurface[],
  selector: string,
  accept: (text: string) => boolean,
): Promise<Found | null> {
  for (const surface of surfaces) {
    for (const entry of await visibleControls(surface, selector)) {
      if (entry.text.length <= MAX_CONTROL_TEXT && accept(entry.text)) return entry;
    }
  }
  return null;
}

/** The page itself and every frame inside it: an inline vendor renders in an iframe. */
function surfacesOf(page: AssessmentPage): AssessmentSurface[] {
  const main = page.mainFrame?.();
  return [page, ...(page.frames?.() ?? []).filter((frame) => frame !== main)];
}

function isOptOutControl(text: string): boolean {
  return OPT_OUT_CONTROL.test(text) && !UNRELATED_OPT_OUT.test(text);
}

/** The host alone: a vendor link carries candidate and session tokens. */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "an unreadable address";
  }
}

async function describeControls(page: AssessmentPage): Promise<string> {
  const texts: string[] = [];
  for (const surface of surfacesOf(page)) {
    for (const entry of await visibleControls(surface, CLICKABLE)) {
      if (texts.length < 15) texts.push(entry.text.slice(0, 50));
    }
  }
  return texts.length > 0 ? texts.map((text) => `"${text}"`).join(", ") : "no visible controls";
}

/**
 * Declines on the vendor's screen: a button that opts out, or an opt-out choice
 * and its send button. Waits on the Workday tab: the vendor's window can close
 * itself at any moment, and waiting on a closed page throws.
 */
async function declineQuestionnaire(
  vendor: AssessmentPage,
  waiter: AssessmentPage,
): Promise<{ ok: boolean; detail: string }> {
  for (let attempt = 0; attempt < FIND_ATTEMPTS; attempt += 1) {
    const surfaces = surfacesOf(vendor);
    const button = await findControl(surfaces, CLICKABLE, isOptOutControl);
    if (button) {
      await button.control.click({ timeout: 10_000 });
      return { ok: true, detail: `pressed "${button.text}"` };
    }
    const choice = await findControl(surfaces, CHOICE, isOptOutControl);
    if (choice) {
      await choice.control.click({ timeout: 10_000 });
      const send = await findControl([choice.surface], CLICKABLE, (text) => SEND.test(text));
      if (!send) return { ok: false, detail: `chose "${choice.text}" but found no button to send it` };
      await send.control.click({ timeout: 10_000 });
      return { ok: true, detail: `chose "${choice.text}" and pressed "${send.text}"` };
    }
    if (vendor.isClosed?.()) return { ok: false, detail: "the vendor window closed before offering an opt-out" };
    await waiter.waitForTimeout(POLL_MS);
  }
  return { ok: false, detail: "no opt-out control appeared" };
}

async function confirmsOptOut(surface: AssessmentSurface): Promise<boolean> {
  const text = await surface.locator("body").innerText().catch(() => "");
  return CONFIRM_PROMPT.test(text);
}

/** Whether the vendor has handed back: its window closed, or the tab is on Workday with no opt-out left. */
async function handedBack(vendor: AssessmentPage, popup: AssessmentPage | null): Promise<boolean> {
  if (popup) return popup.isClosed?.() ?? false;
  if (!isWorkdayUrl(vendor.url())) return false;
  return (await findControl(surfacesOf(vendor), CLICKABLE, isOptOutControl)) === null;
}

/**
 * After the opt-out: answers an "are you sure" prompt, follows a link back to
 * the application, and waits for the vendor to hand back to Workday. Fiserv's
 * vendor closes its own window the moment "Opt Out" is pressed.
 */
async function finishVendor(
  vendor: AssessmentPage,
  popup: AssessmentPage | null,
  waiter: AssessmentPage,
): Promise<boolean> {
  for (let attempt = 0; attempt < FINISH_ATTEMPTS; attempt += 1) {
    if (await handedBack(vendor, popup)) return true;
    await waiter.waitForTimeout(POLL_MS);
    if (await handedBack(vendor, popup)) return true;
    const surfaces = surfacesOf(vendor);
    for (const surface of surfaces) {
      if (!(await confirmsOptOut(surface))) continue;
      const confirm = await findControl([surface], CLICKABLE, (text) => CONFIRM.test(text));
      if (confirm) await confirm.control.click({ timeout: 10_000 }).catch(() => undefined);
    }
    const back = await findControl(surfaces, CLICKABLE, (text) => RETURN.test(text));
    if (back) await back.control.click({ timeout: 10_000 }).catch(() => undefined);
  }
  return handedBack(vendor, popup);
}

/**
 * Takes the "Take Assessment" step's opt-out. Follows the vendor wherever it
 * opens - a new window, the same tab, or a frame inside the step - and returns
 * to the application afterwards. Reports what the vendor offered when no
 * opt-out could be found, so a new vendor can be supported from the log alone.
 */
export async function optOutOfTaxCreditAssessment(
  page: AssessmentPage,
  snapshot?: AssessmentSnapshot,
): Promise<AssessmentOutcome> {
  const launch = await findControl([page], CLICKABLE, (text) => LAUNCH.test(text));
  if (!launch) return { optedOut: false, detail: "the step shows no Take Assessment button" };
  const origin = page.url();
  const popupWait: Promise<AssessmentPage | null> = page.waitForEvent
    ? page.waitForEvent("popup", { timeout: POPUP_WAIT_MS }).then((opened) => opened as AssessmentPage, () => null)
    : Promise.resolve(null);
  await launch.control.click({ timeout: 10_000 });
  const popup = await popupWait;
  const vendor = popup ?? page;
  await vendor.waitForLoadState("domcontentloaded", { timeout: 30_000 }).catch(() => undefined);
  await page.waitForTimeout(SETTLE_MS);
  await snapshot?.(vendor, "assessment-vendor");
  const where = popup ? "in a vendor window" : isWorkdayUrl(vendor.url()) ? "inside the step" : "in the same tab";
  const vendorHost = hostOf(vendor.url());
  const declined = await declineQuestionnaire(vendor, page);
  if (!declined.ok) {
    const offered = await describeControls(vendor);
    await returnToWorkday(page, popup, origin);
    return { optedOut: false, detail: `${declined.detail} ${where} at ${vendorHost}; it offered ${offered}` };
  }
  const returned = await finishVendor(vendor, popup, page);
  await snapshot?.(vendor.isClosed?.() ? page : vendor, "assessment-declined");
  await returnToWorkday(page, popup, origin);
  return {
    optedOut: true,
    detail: `${declined.detail} ${where} at ${vendorHost}${returned ? "" : "; the vendor did not hand back by itself"}`,
  };
}

/** Closes a vendor window still open, and brings a tab the vendor took over back to the step. */
async function returnToWorkday(page: AssessmentPage, popup: AssessmentPage | null, origin: string): Promise<void> {
  if (popup && !(popup.isClosed?.() ?? false)) await popup.close?.().catch(() => undefined);
  if (!popup && !isWorkdayUrl(page.url()) && page.goto) {
    await page.goto(origin, { waitUntil: "domcontentloaded" }).catch(() => undefined);
  }
  await page.bringToFront?.().catch(() => undefined);
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => undefined);
  await page.waitForTimeout(SETTLE_MS);
}
