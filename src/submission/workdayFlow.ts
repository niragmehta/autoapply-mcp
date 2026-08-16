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
};
type Locator = {
  first: () => Locator;
  count: () => Promise<number>;
  click: (options?: unknown) => Promise<void>;
  fill: (value: string, options?: unknown) => Promise<void>;
  isVisible: () => Promise<boolean>;
  waitFor: (options?: unknown) => Promise<void>;
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

const CLICK_FILTER = '[data-automation-id="click_filter"]';

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

  const onAccountPage = await page.locator(SEL.password).first().isVisible().catch(() => false);
  if (!onAccountPage) {
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
 */
export async function advanceWorkdayStep(page: Page): Promise<boolean> {
  const advanced = await clickIfPresent(page, '[data-automation-id="bottom-navigation-next-button"]', 8000);
  if (!advanced) return false;
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => undefined);
  return true;
}

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
