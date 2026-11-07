import type { Page } from "./types.js";

export const SEL = {
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

/**
 * Controls that only exist once the application wizard is open. The step label
 * is the primary signal - live Salesforce, NVIDIA and Adobe tenants all render
 * it - with the wizard's own navigation and form fields as fallbacks for a
 * tenant that omits the progress bar.
 */
const FORM_EVIDENCE = [
  '[data-automation-id="progressBarActiveStep"]',
  '[data-automation-id="bottom-navigation-next-button"]',
  '[data-automation-id^="formField-"]',
] as const;

/** Workday's notice that a new account must be verified by email before use. */
export const VERIFY_ACCOUNT_TEXT = /verify your (account|email)|email has been sent to you|verification (email|link)/i;

/**
 * Reports whether the page is still showing a sign-in gate.
 *
 * Used to tell "signed in already" apart from "the credential form has not
 * opened yet". Both states lack a password field, so absence alone cannot
 * distinguish them and the provider chooser has to be looked for directly.
 */
export async function atSignInWall(page: Page): Promise<boolean> {
  for (const selector of [SEL.signInWithEmail, SEL.googleSignIn, SEL.email]) {
    const visible = await page.locator(selector).first().isVisible().catch(() => false);
    if (visible) return true;
  }
  return false;
}

/**
 * Reports whether a sign-in or registration submit left the browser at the
 * account gate: either the credential form or the provider chooser.
 *
 * The password field alone is not enough. Some tenants answer both a refused
 * sign-in and a completed registration with the chooser, which has no password
 * field, and reading that absence as success sent the run off to fill the
 * sign-in page as though it were the application.
 */
export async function atCredentialGate(page: Page): Promise<boolean> {
  for (const selector of [SEL.password, SEL.signInWithEmail, SEL.googleSignIn]) {
    const visible = await page.locator(selector).first().isVisible().catch(() => false);
    if (visible) return true;
  }
  return false;
}

/**
 * Reports whether the application wizard is actually on screen.
 *
 * Needed for the same reason as the sign-in wall check, taken one step further:
 * a missing password field and a missing provider chooser still do not prove the
 * form was reached. A closed posting renders a "page does not exist" shell that
 * has neither, so inferring success from those two absences reports a form that
 * was never opened - and postings in this campaign close constantly.
 */
/**
 * Wording of the wizard's first step, which is the account gate rather than the
 * application. Every tenant probed renders the same eight-step progress bar and
 * labels this step "Create Account/Sign In".
 */
const SIGN_IN_STEP_TEXT = /create account|sign ?in|log ?in/i;

export function isSignInStepLabel(text: string): boolean {
  return SIGN_IN_STEP_TEXT.test(text);
}

/**
 * Reports whether a URL is the tenant's standalone login route, which some
 * tenants redirect a registration to instead of opening the wizard. Matched on
 * a whole path segment so a job slug such as "Login-Platform-Engineer" is not.
 */
export function isAccountGateUrl(url: string): boolean {
  try {
    return new URL(url).pathname.split("/").some((segment) => segment.toLowerCase() === "login");
  } catch {
    return false;
  }
}

export async function atApplicationForm(page: Page): Promise<boolean> {
  if (isAccountGateUrl(page.url())) return false;
  // The account gate is step 1 of the wizard, so it renders the progress bar and
  // a pair of `formField-` divs for email and password. Both are in
  // FORM_EVIDENCE, which meant the sign-in box itself was read as the
  // application form: the run then "collected" one field, filled nothing, and
  // blamed the posting for being removed. The step label is what separates them.
  const step = await page
    .locator('[data-automation-id="progressBarActiveStep"]')
    .first()
    .allInnerTexts()
    .catch(() => [] as string[]);
  if (isSignInStepLabel(step.join(" "))) return false;

  for (const selector of FORM_EVIDENCE) {
    const visible = await page.locator(selector).first().isVisible().catch(() => false);
    if (visible) return true;
  }
  return false;
}
