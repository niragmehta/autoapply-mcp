import { logger } from "../../util/logger.js";
import { lengthenedPassword, type AtsCredentials } from "../credentials.js";
import { isWorkdayHost } from "../verificationLinks.js";
import { CLICK_FILTER, clickIfPresent, visibleText } from "./clicks.js";
import { SEL, VERIFY_ACCOUNT_TEXT, atApplicationForm, atCredentialGate } from "./gates.js";
import type { BrowserTab, Page } from "./types.js";

export async function signIn(page: Page, credentials: AtsCredentials): Promise<{ ok: boolean; detail: string }> {
  // After registration some tenants return to the provider chooser, which has
  // to be opened again before the credential form exists.
  const passwordShown = await page.locator(SEL.password).first().isVisible().catch(() => false);
  if (!passwordShown) {
    const chooser = await page.locator(SEL.signInWithEmail).first().isVisible().catch(() => false);
    if (chooser) await clickIfPresent(page, SEL.signInWithEmail, 10_000);
  }

  // The account page opens in either mode depending on tenant; switch to sign-in
  // when the confirm-password field shows we landed on registration.
  const onCreate = await page.locator(SEL.verifyPassword).first().isVisible().catch(() => false);
  if (onCreate) {
    const switched = await clickIfPresent(page, SEL.signInLink, 5000);
    if (!switched) return { ok: false, detail: "could not switch to the sign-in form" };
  }

  const emailField = page.locator(SEL.email).first();
  await emailField.waitFor({ state: "visible", timeout: 10_000 }).catch(() => undefined);
  if (!(await emailField.isVisible().catch(() => false))) {
    return { ok: false, detail: "the sign-in form did not open" };
  }
  await emailField.fill(credentials.email);
  await page.locator(SEL.password).first().fill(credentials.password);
  await clickIfPresent(page, SEL.signInSubmit, 8000);
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => undefined);

  if (!(await atCredentialGate(page))) return { ok: true, detail: "signed in to an existing account" };

  const error = (await visibleText(page, SEL.errorBanner)).trim();
  return { ok: false, detail: error ? `sign-in refused: ${error.slice(0, 200)}` : "sign-in did not complete" };
}

export async function createAccount(
  page: Page,
  stored: AtsCredentials,
  awaitVerificationLink?: (since: Date) => Promise<string | null>,
): Promise<{ ok: boolean; created: boolean; detail: string }> {
  const onSignIn = await page.locator(SEL.verifyPassword).first().isVisible().catch(() => false);
  if (!onSignIn) {
    const switched = await clickIfPresent(page, SEL.createAccountLink, 5000);
    if (!switched) return { ok: false, created: false, detail: "could not reach the create-account form" };
  }

  // A tenant that states a longer minimum than the stored password allows
  // could only ever have been registered with the lengthened one, so an
  // earlier run's account is tried under it before registering again.
  const minimum = await statedPasswordMinimum(page);
  const credentials =
    minimum > stored.password.length ? { ...stored, password: lengthenedPassword(stored.password, minimum) } : stored;
  if (credentials !== stored) {
    const returning = await signInWithLengthenedPassword(page, credentials, awaitVerificationLink);
    if (returning) return returning;
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

  // Registering is what sends the verification email, so it cannot predate this.
  const registeredAt = new Date();
  await clickIfPresent(page, SEL.createAccountSubmit, 8000);
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => undefined);

  const outcome = await awaitRegistrationOutcome(page);
  if (outcome === "form") {
    logger.info("workday account created", { host: new URL(page.url()).hostname });
    return { ok: true, created: true, detail: "created a new account on this employer's tenant" };
  }

  if (outcome === "gate") {
    // Some tenants register the account and then return to Sign In - the
    // credential form or the provider chooser - rather than opening the form.
    const verifyNotice = async () =>
      VERIFY_ACCOUNT_TEXT.test((await page.locator("body").allInnerTexts().catch(() => [] as string[])).join(" "));
    const verificationDetail = `created an account, but the tenant requires email verification first: open the verification email sent to ${credentials.email}, then rerun`;
    const verifyByEmail = async (): Promise<{ ok: boolean; created: boolean; detail: string }> => {
      if (!awaitVerificationLink) return { ok: false, created: true, detail: verificationDetail };
      const verified = await verifyByEmailedLink(page, credentials, awaitVerificationLink, registeredAt);
      if (!verified.ok) return { ok: false, created: true, detail: `${verificationDetail}; ${verified.detail}` };
      logger.info("workday account created", { host: new URL(page.url()).hostname, verifiedByEmail: true });
      return {
        ok: true,
        created: true,
        detail: "created a new account on this employer's tenant, verified it via the emailed link and signed in",
      };
    };
    if (await verifyNotice()) return await verifyByEmail();

    const signedIn = await signIn(page, credentials);
    if (signedIn.ok) {
      logger.info("workday account created", { host: new URL(page.url()).hostname, signedIn: true });
      return { ok: true, created: true, detail: "created a new account on this employer's tenant and signed in with it" };
    }
    if (VERIFY_ACCOUNT_TEXT.test(signedIn.detail) || (await verifyNotice())) {
      return await verifyByEmail();
    }
    return {
      ok: false,
      created: true,
      detail: `created an account, but signing in with it did not complete (${signedIn.detail}); rerun to sign in with the new account`,
    };
  }

  if (outcome === "unknown") {
    return {
      ok: false,
      created: true,
      detail: `submitted the registration for ${credentials.email}, but neither the application form nor the sign-in form appeared afterwards; rerun to sign in with the new account`,
    };
  }

  const error = (await visibleText(page, SEL.errorBanner)).trim();
  return {
    ok: false,
    created: false,
    detail: error ? `account creation refused: ${error.slice(0, 200)}` : "account creation did not complete",
  };
}

/**
 * The longest password minimum the page states, or 0 when it states none.
 * Red Hat lists "A minimum of 14 characters" among its password requirements.
 */
const PASSWORD_MINIMUM_TEXT = /\b(?:minimum(?: of)?|at least)\s+(\d{1,2})\s+characters?\b/gi;

async function statedPasswordMinimum(page: Page): Promise<number> {
  const text = (await page.locator("body").allInnerTexts().catch(() => [] as string[])).join(" ");
  return Math.max(0, ...[...text.matchAll(PASSWORD_MINIMUM_TEXT)].map((match) => Number(match[1])));
}

/**
 * Signs in with the lengthened password from the create-account form, for a
 * tenant an earlier run already registered on. Returns undefined, back on the
 * create-account form, when there is no such account to use.
 */
async function signInWithLengthenedPassword(
  page: Page,
  credentials: AtsCredentials,
  awaitVerificationLink?: (since: Date) => Promise<string | null>,
): Promise<{ ok: boolean; created: boolean; detail: string } | undefined> {
  if (!(await clickIfPresent(page, SEL.signInLink, 5000))) return undefined;
  const returning = await signIn(page, credentials);
  if (returning.ok) {
    return { ok: true, created: false, detail: "signed in with the lengthened password this tenant requires" };
  }
  if (VERIFY_ACCOUNT_TEXT.test(returning.detail) && awaitVerificationLink) {
    const requestedAt = new Date();
    if (await requestVerificationEmail(page, credentials.email)) {
      const verified = await verifyByEmailedLink(page, credentials, awaitVerificationLink, requestedAt);
      return {
        ok: verified.ok,
        created: false,
        detail: verified.ok
          ? "verified the existing account via the emailed link and signed in with the lengthened password"
          : `an account for ${credentials.email} exists on this tenant but is not verified yet; ${verified.detail}`,
      };
    }
  }
  if (!(await clickIfPresent(page, SEL.createAccountLink, 5000))) {
    return { ok: false, created: false, detail: "could not return to the create-account form" };
  }
  return undefined;
}

/**
 * The control an unverified account's sign-in refusal offers: "Resend Account
 * Verification". Its markup has not been captured from a live tenant, so the
 * overlay Workday lays over its buttons, the control's own automation id and
 * finally its wording are tried in turn. The wording deliberately leaves out
 * the banner's own "request a verification email", which is not a control.
 */
const RESEND_VERIFICATION = [
  `${CLICK_FILTER}[aria-label*="resend" i]`,
  '[data-automation-id*="resend" i]',
  "text=/resend (?:account )?verification|resend (?:the )?verification email/i",
] as const;

/** A dialog some tenants open to ask which address the email should go to. */
const DIALOG = ':is([role="dialog"], [role="alertdialog"], [aria-modal="true"])';
const RESEND_DIALOG_EMAIL = `${DIALOG} :is(input[type="email"], input[data-automation-id*="email" i], input[name*="email" i], input[aria-label*="email" i])`;
const RESEND_DIALOG_CONFIRM = [
  `${DIALOG} ${CLICK_FILTER}:is([aria-label*="send" i], [aria-label*="submit" i], [aria-label*="verif" i], [aria-label*="continue" i], [aria-label="ok" i])`,
  ...["Send", "Submit", "Verify", "Continue", "OK"].map((word) => `${DIALOG} :is(button, [role="button"]):has-text("${word}")`),
];

/**
 * Asks the tenant to send the verification email again, answering the dialog
 * that sometimes asks where to send it. Returns false when no resend control
 * could be clicked: waiting on an email nobody asked for only burns the budget.
 */
export async function requestVerificationEmail(page: Page, email: string): Promise<boolean> {
  // Counted first, so a dialog the click opens is told apart from any address
  // field already on screen.
  const addressFields = page.locator(RESEND_DIALOG_EMAIL);
  const before = await addressFields.count().catch(() => 0);
  let requested = false;
  for (const selector of RESEND_VERIFICATION) {
    requested = await clickIfPresent(page, selector, 3000);
    if (requested) break;
  }
  if (!requested) return false;

  const after = await addressFields.count().catch(() => 0);
  if (after > before) {
    await addressFields.nth(after - 1).fill(email).catch(() => undefined);
    for (const selector of RESEND_DIALOG_CONFIRM) {
      if (await clickIfPresent(page, selector, 2000)) break;
    }
  }
  logger.info("workday verification email requested", { host: hostOf(page.url()) });
  return true;
}

/**
 * Verifies the account through the link Workday emailed, then signs in.
 *
 * The link opens in a second tab of the same browser context, so the
 * application tab keeps its place at the sign-in gate and shares any session
 * the verification page sets.
 */
export async function verifyByEmailedLink(
  page: Page,
  credentials: AtsCredentials,
  awaitLink: (since: Date) => Promise<string | null>,
  since: Date,
): Promise<{ ok: true } | { ok: false; detail: string }> {
  const link = await awaitLink(since).catch((error: unknown) => {
    logger.warn("workday verification email unavailable", { detail: String(error) });
    return null;
  });
  if (!link) {
    const waited = Math.max(0, Math.round((Date.now() - since.getTime()) / 1000));
    return { ok: false, detail: `no verification email arrived within ${waited}s` };
  }
  const opened = await openVerificationLink(page, link);
  if (opened === "failed") return { ok: false, detail: "the emailed verification link could not be opened" };
  const signedIn = await signInAfterVerification(page, credentials);
  if (!signedIn.ok) {
    const pageSaid = opened === "refused" ? "; the verification page reported a problem with the link" : "";
    return {
      ok: false,
      detail: `opened the emailed verification link, but signing in afterwards did not complete (${signedIn.detail})${pageSaid}`,
    };
  }
  logger.info("workday account verified by email", { host: hostOf(link), page: opened });
  return { ok: true };
}

/** What a verification page says once its own request has settled. */
const LINK_ACCEPTED_TEXT = /\b(?:verified|activated|success(?:ful(?:ly)?)?)\b/i;
const LINK_REFUSED_TEXT = /\b(?:expired|invalid|not (?:been |yet )?verified|could not|unable to)\b/i;
/** One-second reads of the verification page before taking it as settled. */
const LINK_SETTLE_POLLS = 10;

/**
 * Opens the emailed link in a second tab and reports what the page said.
 *
 * The wording is read but not required: the sign-in that follows is what
 * proves the account was verified. Only https links on Workday's own hosts are
 * followed, whatever supplied them.
 */
async function openVerificationLink(page: Page, link: string): Promise<"failed" | "confirmed" | "refused" | "unclear"> {
  const host = hostOf(link);
  if (!isOpenableLink(link)) {
    logger.warn("workday verification link refused: not an https Workday link", { host });
    return "failed";
  }
  const context = page.context?.();
  if (!context) return "failed";
  let tab: BrowserTab | undefined;
  try {
    tab = await context.newPage();
    await tab.goto(link, { waitUntil: "domcontentloaded", timeout: 30_000 });
    await tab.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
    const outcome = await readLinkPage(tab);
    logger.info("workday verification link opened", { host, outcome });
    return outcome;
  } catch (error) {
    // A navigation error quotes the URL, and the URL carries the token.
    logger.warn("workday verification link failed to open", {
      host,
      detail: String(error).replace(/https?:\/\/\S+/g, "[link]").slice(0, 200),
    });
    return "failed";
  } finally {
    await tab?.close().catch(() => undefined);
  }
}

async function readLinkPage(tab: BrowserTab): Promise<"confirmed" | "refused" | "unclear"> {
  for (let poll = 0; poll < LINK_SETTLE_POLLS; poll += 1) {
    const text = (await tab.locator("body").allInnerTexts().catch(() => [] as string[])).join(" ");
    if (LINK_REFUSED_TEXT.test(text)) return "refused";
    if (LINK_ACCEPTED_TEXT.test(text)) return "confirmed";
    await tab.waitForTimeout(1000);
  }
  return "unclear";
}

function isOpenableLink(link: string): boolean {
  try {
    const url = new URL(link);
    return url.protocol === "https:" && !url.username && !url.password && isWorkdayHost(url.hostname);
  } catch {
    return false;
  }
}

function hostOf(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname;
  } catch {
    return "";
  }
}

/**
 * Signs in on the application tab once the account is verified.
 *
 * That tab was left at the sign-in gate. Should it have moved on, reloading
 * the step brings back the gate - or the form itself, if the link signed this
 * browser in - and failing both, the walk in from the advert is replayed.
 */
async function signInAfterVerification(
  page: Page,
  credentials: AtsCredentials,
): Promise<{ ok: boolean; detail: string }> {
  if (!(await atCredentialGate(page))) {
    await page.reload({ waitUntil: "domcontentloaded" }).catch(() => undefined);
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
    if (await atApplicationForm(page)) return { ok: true, detail: "already signed in after verification" };
    if (!(await atCredentialGate(page))) {
      await clickIfPresent(page, SEL.apply, 10_000);
      await clickIfPresent(page, SEL.applyManually, 8000);
      await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
    }
  }
  return await signIn(page, credentials);
}

/** Polls allowed for a registration submit to settle, 1.5s apart. */
const REGISTRATION_SETTLE_POLLS = 12;

/**
 * Waits for a registration submit to land somewhere recognisable.
 *
 * Palo Alto Networks paints nothing but the wizard's sign-in step for several
 * seconds after registering, then shows the provider chooser. Judging the page
 * at once read that blank interval as the open application form.
 */
async function awaitRegistrationOutcome(page: Page): Promise<"form" | "gate" | "create" | "unknown"> {
  for (let poll = 0; poll < REGISTRATION_SETTLE_POLLS; poll += 1) {
    const onCreate = await page.locator(SEL.verifyPassword).first().isVisible().catch(() => false);
    if (onCreate) {
      const refused = await page.locator(SEL.errorBanner).first().isVisible().catch(() => false);
      if (refused) return "create";
    } else {
      if (await atCredentialGate(page)) return "gate";
      if (await atApplicationForm(page)) return "form";
    }
    await page.waitForTimeout(1500);
  }
  const stillOnCreate = await page.locator(SEL.verifyPassword).first().isVisible().catch(() => false);
  return stillOnCreate ? "create" : "unknown";
}
