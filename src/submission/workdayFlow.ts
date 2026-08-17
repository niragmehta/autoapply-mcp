import { AppError } from "../util/errors.js";
import { logger } from "../util/logger.js";
import { getAtsCredentials, type AtsCredentials } from "./credentials.js";

/**
 * Workday's pre-form flow.
 *
 * Unlike Greenhouse, Lever and Ashby, a Workday posting does not show a form.
 * It shows a job advert with an Apply button, then a modal, then a sign-in wall.
 * The application itself only appears once an account exists on that employer's
 * tenant, and every employer is a separate tenant with a separate account.
 *
 * Selectors here are Workday's own `data-automation-id` values, which are
 * stable across tenants because they come from the platform rather than the
 * employer's configuration.
 */

type Page = {
  goto: (url: string, options?: unknown) => Promise<unknown>;
  locator: (selector: string) => Locator;
  url: () => string;
  waitForTimeout: (ms: number) => Promise<void>;
  waitForLoadState: (state: string, options?: unknown) => Promise<void>;
  evaluate: (fn: unknown, arg?: unknown) => Promise<unknown>;
  reload: (options?: unknown) => Promise<unknown>;
  keyboard: { press: (key: string) => Promise<void> };
};
type Locator = {
  first: () => Locator;
  nth: (index: number) => Locator;
  count: () => Promise<number>;
  click: (options?: unknown) => Promise<void>;
  fill: (value: string, options?: unknown) => Promise<void>;
  isVisible: () => Promise<boolean>;
  waitFor: (options?: unknown) => Promise<void>;
  locator: (selector: string) => Locator;
  allInnerTexts: () => Promise<string[]>;
};

export const WORKDAY_HOST_PATTERN = /(^|\.)myworkdayjobs\.com$/i;

export function isWorkdayUrl(rawUrl: string): boolean {
  try {
    return WORKDAY_HOST_PATTERN.test(new URL(rawUrl).hostname);
  } catch {
    return false;
  }
}

const SEL = {
  apply: '[data-automation-id="adventureButton"]',
  applyManually: '[data-automation-id="applyManually"]',
  useMyLastApplication: '[data-automation-id="useMyLastApplication"]',
  signInWithEmail: '[data-automation-id="SignInWithEmailButton"]',
  googleSignIn: '[data-automation-id="GoogleSignInButton"]',
  email: '[data-automation-id="email"]',
  password: '[data-automation-id="password"]',
  verifyPassword: '[data-automation-id="verifyPassword"]',
  createAccountSubmit: '[data-automation-id="createAccountSubmitButton"]',
  signInSubmit: '[data-automation-id="signInSubmitButton"]',
  signInLink: '[data-automation-id="signInLink"]',
  createAccountLink: '[data-automation-id="createAccountLink"]',
  errorBanner: '[data-automation-id="errorMessage"]',
} as const;

export type WorkdayEntryResult = {
  reached: "form" | "sign-in" | "blocked";
  detail: string;
  createdAccount: boolean;
};

/**
 * Workday's dropdowns are not inputs, so a plain fill writes nowhere.
 *
 * The markup is a `multiSelectContainer` (or a `button[aria-haspopup=listbox]`)
 * with a hidden text input beside it. The field collector only ever sees that
 * input: filling it changes nothing the form reads, the run reports the field
 * as filled, and Workday then refuses to save the page because the field is
 * still empty. Every one of these has to be opened and an option clicked.
 *
 * Two traps are specific to this widget and both are load-bearing here:
 *
 * - An already-chosen value renders as a `selectedItem` pill that also carries
 *   `role="option"`. It is a delete control, not a choice, so a page-wide
 *   option query offers up other fields' answers and "choosing" one erases
 *   them. Pills are excluded everywhere.
 * - Long lists are nested one level ("Linkedin Jobs" under "Job Board") and
 *   typing does not search into the categories, so a leaf is only reachable by
 *   opening its parent. The menu has no back control that is safe to click -
 *   the only back-looking button on the page is `backToJobPosting`, which
 *   leaves the application - so each category is tried from a freshly reopened
 *   menu instead.
 */
const WD_PILL = '[data-automation-id="selectedItem"]';
const WD_MENU_ITEM = `[role="option"]:visible:not(${WD_PILL})`;
const WD_MAX_CATEGORIES = 8;

export type WorkdayPromptResult = { filled: boolean; detail: string };

function promptContainer(field: Locator): Locator {
  return field.locator(
    '[data-automation-id="multiSelectContainer"], button[aria-haspopup="listbox"]',
  );
}

/** True when this field is one of Workday's prompt widgets rather than a text input. */
export async function isWorkdayPrompt(field: Locator): Promise<boolean> {
  return (await promptContainer(field).count()) > 0;
}

/** A picker nests its options one level; a plain dropdown is flat. */
async function isPicker(field: Locator): Promise<boolean> {
  return (await field.locator('[data-automation-id="multiSelectContainer"]').count()) > 0;
}

async function closeMenu(page: Page): Promise<void> {
  await page.keyboard.press("Escape").catch(() => undefined);
  await page.waitForTimeout(300);
}

async function openMenu(page: Page, field: Locator): Promise<boolean> {
  // A click that lands while a previously open menu is still closing is
  // swallowed, which reads as "this widget offers nothing" and hides the real
  // reason a required field stayed blank. One retry settles it.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await promptContainer(field)
      .first()
      .click({ timeout: 10_000 })
      .catch(() => undefined);
    await page.waitForTimeout(1_200);
    if ((await page.locator(WD_MENU_ITEM).count()) > 0) return true;
  }
  return false;
}

/**
 * The values already chosen.
 *
 * A picker shows them as pills; a plain dropdown has none and shows the choice
 * as the button's own text, so both have to be read or a successful selection
 * on a dropdown is misreported as a failure.
 */
const WD_PLACEHOLDER = /^(select one|select\.{0,3}|search|)$/i;

async function chosenValues(field: Locator): Promise<string[]> {
  const clean = (text: string): string => text.replace(/\s+/g, " ").trim();
  const pills = field.locator(WD_PILL);
  if ((await pills.count()) > 0) {
    return (await pills.allInnerTexts()).map(clean).filter(Boolean);
  }
  const button = field.locator('button[aria-haspopup="listbox"]');
  if ((await button.count()) > 0) {
    return (await button.allInnerTexts()).map(clean).filter((text) => !WD_PLACEHOLDER.test(text));
  }
  return [];
}

/**
 * Yes and no are too short to match on substrings: "no" appears inside "NOT",
 * and "Yes, no restriction" contains both. A bare polarity answer therefore
 * only takes an option that leads with the same word - the rule the option
 * matcher already applies everywhere else.
 */
const WD_POLARITY = /^(yes|no)$/;

/** Substring matching alone lets "no" hide inside "not" and answer the opposite. */
function containsWord(haystack: string, needle: string): boolean {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(haystack);
}

function matches(optionText: string, candidate: string): boolean {
  const option = optionText.replace(/\s+/g, " ").trim().toLowerCase();
  const wanted = candidate.replace(/\s+/g, " ").trim().toLowerCase();
  if (!option || !wanted) return false;
  if (WD_PLACEHOLDER.test(option)) return false;
  if (isRefusal(option) && isRefusal(wanted)) return true;
  if (WD_POLARITY.test(wanted)) return new RegExp(`^${wanted}\\b`, "i").test(option);
  return option === wanted || containsWord(option, wanted) || containsWord(wanted, option);
}

/**
 * Employers name the same choice differently, and a Workday prompt offers no
 * free text to fall back on, so a stored answer has to be tried under the
 * tenant's own vocabulary. NVIDIA lists a mobile number as "Home Cellular".
 */
const WD_SYNONYMS: readonly (readonly string[])[] = [["mobile", "cell", "cellular"]];

/**
 * A refusal to answer, however it is spelled.
 *
 * NVIDIA alone offers three spellings on one step - "Decline to State" for
 * ethnicity and gender, "I DO NOT WISH TO SELF-IDENTIFY" for veteran status -
 * and the stored answer says "decline to self-identify". Chasing that with a
 * list of literals is a losing game, so both sides are recognised as refusals
 * instead. Both must be refusals for this to apply, so a real answer can never
 * be turned into a decline.
 */
const WD_REFUSAL =
  /(decline to|prefer not to|do not wish to|don't wish to|do not want to|choose not to|rather not|wish not to|not to disclose|not to self.?identify|no response)/;

function isRefusal(text: string): boolean {
  return WD_REFUSAL.test(text);
}

function expand(candidate: string): string[] {
  const lower = candidate.toLowerCase();
  const group = WD_SYNONYMS.find((words) => words.some((word) => lower.includes(word)));
  if (!group) return [candidate];
  return [candidate, ...group.filter((word) => !lower.includes(word))];
}

async function clickMatch(page: Page, candidate: string): Promise<boolean> {
  const items = page.locator(WD_MENU_ITEM);
  const texts = await items.allInnerTexts().catch(() => [] as string[]);
  const hits = texts
    .map((text, index) => ({ text, index }))
    .filter((entry) => matches(entry.text, candidate));
  if (hits.length === 0) return false;
  // The least qualified match wins, the same rule the option matcher uses
  // elsewhere: given "Cellular" and "Work Cellular", the bare one is meant.
  hits.sort((a, b) => a.text.length - b.text.length);
  await items.nth(hits[0]!.index).click({ timeout: 10_000 });
  await page.waitForTimeout(1_000);
  return true;
}

/**
 * Chooses a value in a Workday prompt, reporting honestly when it cannot.
 *
 * The caller must be able to tell a real selection from a no-op, so success is
 * confirmed by re-reading the widget's pills rather than by the click resolving.
 */
export async function fillWorkdayPrompt(
  page: Page,
  field: Locator,
  candidates: readonly string[],
): Promise<WorkdayPromptResult> {
  const before = await chosenValues(field);
  const already = before.find((value) => candidates.some((candidate) => matches(value, candidate)));
  if (already) return { filled: true, detail: `already set to ${already}` };
  // A prompt that takes one value rejects a second, so anything already chosen
  // by a previous pass of the wizard loop is left alone.
  if (before.length > 0) return { filled: true, detail: `already set to ${before.join(", ")}` };

  for (const candidate of candidates.flatMap(expand)) {
    await closeMenu(page);
    if (!(await openMenu(page, field))) continue;

    if (await clickMatch(page, candidate)) {
      const after = await chosenValues(field);
      if (after.length > before.length) return { filled: true, detail: `selected ${after.join(", ")}` };
    }

    // Only a picker nests its options. A plain dropdown is flat, and "opening"
    // one of its entries would select it, so probing there would quietly answer
    // the question with whatever was tried first.
    if (!(await isPicker(field))) continue;

    // Not offered at the top level: try each category from a fresh menu.
    await closeMenu(page);
    if (!(await openMenu(page, field))) continue;
    const categories = (await page.locator(WD_MENU_ITEM).allInnerTexts().catch(() => [] as string[]))
      .map((text) => text.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .slice(0, WD_MAX_CATEGORIES);

    for (const category of categories) {
      await closeMenu(page);
      if (!(await openMenu(page, field))) break;
      if (!(await clickMatch(page, category))) continue;

      // An entry that turned out to be a value rather than a category has just
      // answered the question. Undo it: the pill is its own delete control.
      const opened = await chosenValues(field);
      if (opened.length > before.length) {
        if (opened.some((value) => matches(value, candidate))) {
          return { filled: true, detail: `selected ${opened.join(", ")}` };
        }
        await field.locator(WD_PILL).first().click({ timeout: 5_000 }).catch(() => undefined);
        await page.waitForTimeout(500);
        continue;
      }

      if (!(await clickMatch(page, candidate))) continue;
      const after = await chosenValues(field);
      if (after.length > before.length) {
        return { filled: true, detail: `selected ${after.join(", ")} under ${category}` };
      }
    }
  }

  // Say what was actually on offer. Without it every mismatch needs a bespoke
  // browser probe to diagnose, because the wanted values are all the log shows.
  let offered: string[] = [];
  if (await openMenu(page, field)) {
    offered = (await page.locator(WD_MENU_ITEM).allInnerTexts().catch(() => [] as string[]))
      .map((text) => text.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .slice(0, WD_MAX_CATEGORIES);
  }
  await closeMenu(page);
  return {
    filled: false,
    detail: `no Workday option matched ${JSON.stringify(candidates)}; offered ${JSON.stringify(offered)}`,
  };
}

const CLICK_FILTER = '[data-automation-id="click_filter"]';

/**
 * Workday intermittently replaces a wizard step with "Something went wrong.
 * Please refresh the page and then try again." The page keeps its stepper and
 * its chrome but loses every control, so a run that hits this collected no
 * fields and reported the posting as dead - a confident, wrong diagnosis of a
 * fault the page itself says is transient. Doing what it asks recovers it.
 */
const WD_TRANSIENT_ERROR = /something went wrong/i;

export async function recoverWorkdayError(page: Page, attempts = 2): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!WD_TRANSIENT_ERROR.test(await visibleText(page, "body"))) return true;
    await page.reload({ waitUntil: "domcontentloaded" }).catch(() => undefined);
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
    await page.waitForTimeout(2_500);
  }
  return !WD_TRANSIENT_ERROR.test(await visibleText(page, "body"));
}

/**
 * Builds the in-page script that clicks a Workday control.
 *
 * Workday renders every button twice: a real `<button>` carrying the
 * data-automation-id, marked `aria-hidden` with `tabindex="-2"`, and a
 * transparent `div[data-automation-id="click_filter"]` laid over it that holds
 * `role="button"` and receives the pointer events. Clicking the button
 * therefore never lands - the overlay intercepts it and Playwright retries
 * until it times out. The overlay is what a person actually clicks.
 *
 * Where several overlays share an ancestor the aria-label picks the right one;
 * an ambiguous group is left alone and the walk continues outwards, because
 * clicking a neighbouring button is worse than not clicking at all.
 */
export function buildOverlayClickScript(selector: string): string {
  return `(() => {
    const target = document.querySelector(${JSON.stringify(selector)});
    if (!target) return "missing";
    const norm = (value) => (value || "").replace(/\\s+/g, " ").trim().toLowerCase();
    const label = norm(target.textContent) || norm(target.getAttribute("aria-label"));
    let node = target.parentElement;
    for (let depth = 0; depth < 4 && node; depth += 1) {
      const overlays = Array.from(node.querySelectorAll(${JSON.stringify(CLICK_FILTER)}));
      if (overlays.length > 0) {
        const match = overlays.length === 1
          ? overlays[0]
          : overlays.find((overlay) => norm(overlay.getAttribute("aria-label")) === label);
        if (match) {
          match.click();
          return "overlay";
        }
      }
      node = node.parentElement;
    }
    target.click();
    return "direct";
  })()`;
}

/**
 * Clicks a control if it is present, reporting whether the click landed.
 *
 * Never throws. A control that cannot be clicked must leave the caller free to
 * try the next route - a failed sign-in has to be able to fall through to
 * registration rather than aborting the whole application.
 */
async function clickIfPresent(page: Page, selector: string, timeoutMs = 8000): Promise<boolean> {
  const locator = page.locator(selector).first();
  try {
    await locator.waitFor({ state: "visible", timeout: timeoutMs });
  } catch {
    return false;
  }

  try {
    await locator.click({ timeout: Math.min(timeoutMs, 5000) });
    await page.waitForTimeout(2500);
    return true;
  } catch {
    // Intercepted or detached; try the overlay Workday actually listens on.
  }

  let outcome = "failed";
  try {
    outcome = (await page.evaluate(buildOverlayClickScript(selector))) as string;
  } catch {
    return false;
  }
  if (outcome === "missing" || outcome === "failed") return false;
  await page.waitForTimeout(2500);
  return true;
}

async function visibleText(page: Page, selector: string): Promise<string> {
  const count = await page.locator(selector).first().count();
  if (count === 0) return "";
  return (await page.evaluate(
    `(() => { const e = document.querySelector(${JSON.stringify(selector)}); return e ? (e.innerText || '') : ''; })()`,
  )) as string;
}

/**
 * Reports whether the page is still showing a sign-in gate.
 *
 * Used to tell "signed in already" apart from "the credential form has not
 * opened yet". Both states lack a password field, so absence alone cannot
 * distinguish them and the provider chooser has to be looked for directly.
 */
async function atSignInWall(page: Page): Promise<boolean> {
  for (const selector of [SEL.signInWithEmail, SEL.googleSignIn, SEL.email]) {
    const visible = await page.locator(selector).first().isVisible().catch(() => false);
    if (visible) return true;
  }
  return false;
}

/**
 * Walks from a Workday job advert to its application form, signing in or
 * registering as needed.
 *
 * Sign-in is always attempted before registration: an existing account must not
 * be duplicated, and a "there is already an account" error is a far better
 * outcome than a second account the candidate does not know about.
 */
export async function enterWorkdayApplication(
  page: Page,
  profileEmail: string,
  options: { allowAccountCreation: boolean },
): Promise<WorkdayEntryResult> {
  const credentials: AtsCredentials = getAtsCredentials(profileEmail);

  await clickIfPresent(page, SEL.apply, 15_000);
  // The modal offers "Autofill with Resume" and "Apply Manually". Manual is the
  // honest path: resume autofill silently invents field values from parsed text.
  await clickIfPresent(page, SEL.applyManually, 8000);
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);

  // Newer tenants gate the credential form behind a provider chooser offering
  // "Sign in with Google" or "Sign in with email". That page carries no email or
  // password field at all, so the form has to be opened before it can be found.
  await clickIfPresent(page, SEL.signInWithEmail, 6000);

  const onAccountPage = await page.locator(SEL.password).first().isVisible().catch(() => false);
  if (!onAccountPage) {
    // An absent password field is not evidence of being signed in - it is also
    // what a provider chooser looks like. Claiming "form reached" there sends the
    // caller off to fill a form that does not exist, so the wall is named instead.
    if (await atSignInWall(page)) {
      return {
        reached: "sign-in",
        detail: "stopped at the sign-in wall; the credential form did not open",
        createdAccount: false,
      };
    }
    return { reached: "form", detail: "already signed in; application form reached", createdAccount: false };
  }

  const signedIn = await signIn(page, credentials);
  if (signedIn.ok) return { reached: "form", detail: signedIn.detail, createdAccount: false };

  if (!options.allowAccountCreation) {
    return { reached: "sign-in", detail: `${signedIn.detail}; account creation not permitted`, createdAccount: false };
  }

  const created = await createAccount(page, credentials);
  return {
    reached: created.ok ? "form" : "blocked",
    detail: created.detail,
    createdAccount: created.ok,
  };
}

async function signIn(page: Page, credentials: AtsCredentials): Promise<{ ok: boolean; detail: string }> {
  // The account page opens in either mode depending on tenant; switch to sign-in
  // when the confirm-password field shows we landed on registration.
  const onCreate = await page.locator(SEL.verifyPassword).first().isVisible().catch(() => false);
  if (onCreate) {
    const switched = await clickIfPresent(page, SEL.signInLink, 5000);
    if (!switched) return { ok: false, detail: "could not switch to the sign-in form" };
  }

  await page.locator(SEL.email).first().fill(credentials.email);
  await page.locator(SEL.password).first().fill(credentials.password);
  await clickIfPresent(page, SEL.signInSubmit, 8000);
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => undefined);

  const stillOnPassword = await page.locator(SEL.password).first().isVisible().catch(() => false);
  if (!stillOnPassword) return { ok: true, detail: "signed in to an existing account" };

  const error = (await visibleText(page, SEL.errorBanner)).trim();
  return { ok: false, detail: error ? `sign-in refused: ${error.slice(0, 200)}` : "sign-in did not complete" };
}

async function createAccount(page: Page, credentials: AtsCredentials): Promise<{ ok: boolean; detail: string }> {
  const onSignIn = await page.locator(SEL.verifyPassword).first().isVisible().catch(() => false);
  if (!onSignIn) {
    const switched = await clickIfPresent(page, SEL.createAccountLink, 5000);
    if (!switched) return { ok: false, detail: "could not reach the create-account form" };
  }

  await page.locator(SEL.email).first().fill(credentials.email);
  await page.locator(SEL.password).first().fill(credentials.password);
  await page.locator(SEL.verifyPassword).first().fill(credentials.password);

  // Workday requires its own terms checkbox on some tenants. It is a plain
  // acknowledgement of the privacy notice, which the campaign already auto-ticks.
  await page
    .locator('[data-automation-id="createAccountCheckbox"]')
    .first()
    .click()
    .catch(() => undefined);

  await clickIfPresent(page, SEL.createAccountSubmit, 8000);
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => undefined);

  const stillOnCreate = await page.locator(SEL.verifyPassword).first().isVisible().catch(() => false);
  if (!stillOnCreate) {
    logger.info("workday account created", { host: new URL(page.url()).hostname });
    return { ok: true, detail: "created a new account on this employer's tenant" };
  }

  const error = (await visibleText(page, SEL.errorBanner)).trim();
  return {
    ok: false,
    detail: error ? `account creation refused: ${error.slice(0, 200)}` : "account creation did not complete",
  };
}

/**
 * Advances the multi-step application wizard by one page.
 *
 * Workday splits an application across My Information, My Experience,
 * Application Questions, Voluntary Disclosures and Review. Each page must be
 * saved before the next one exists, so fields cannot all be collected up front.
 *
 * The advance control is named differently across Workday versions - a live
 * NVIDIA tenant labels it "Save and Continue" under `pageFooterNextButton` and
 * has no `bottom-navigation-next-button` at all - so each known id is tried in
 * turn rather than assuming one.
 */
export async function advanceWorkdayStep(page: Page): Promise<boolean> {
  for (const selector of NEXT_BUTTONS) {
    const advanced = await clickIfPresent(page, selector, 8000);
    if (!advanced) continue;
    await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => undefined);
    return true;
  }
  return false;
}

const NEXT_BUTTONS = [
  '[data-automation-id="pageFooterNextButton"]',
  '[data-automation-id="bottom-navigation-next-button"]',
] as const;

/** Reads the wizard's current step label, used to report progress honestly. */
export async function workdayStepName(page: Page): Promise<string> {
  const text = await visibleText(page, '[data-automation-id="progressBarActiveStep"]');
  return text.trim();
}

export function assertWorkdaySupported(rawUrl: string): void {
  if (!isWorkdayUrl(rawUrl)) {
    throw new AppError("not_workday", `${rawUrl} is not a Workday board`);
  }
}
