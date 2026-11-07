import { AppError } from "../util/errors.js";
import { getAtsCredentials, type AtsCredentials } from "./credentials.js";
import { createAccount, requestVerificationEmail, signIn, verifyByEmailedLink } from "./workday/account.js";
import { clickIfPresent } from "./workday/clicks.js";
import { SEL, VERIFY_ACCOUNT_TEXT, atApplicationForm, atSignInWall } from "./workday/gates.js";
import type { Page } from "./workday/types.js";

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

export const WORKDAY_HOST_PATTERN = /(^|\.)myworkdayjobs\.com$/i;

export function isWorkdayUrl(rawUrl: string): boolean {
  try {
    return WORKDAY_HOST_PATTERN.test(new URL(rawUrl).hostname);
  } catch {
    return false;
  }
}

/**
 * The employer's tenant, which Workday puts first in the hostname: `acme` for
 * `acme.wd5.myworkdayjobs.com`. It tells this employer's emails apart from
 * another's when two runs read one mailbox.
 */
export function workdayTenant(rawUrl: string): string | undefined {
  try {
    const host = new URL(rawUrl).hostname.toLowerCase();
    if (!WORKDAY_HOST_PATTERN.test(host)) return undefined;
    const label = host.split(".")[0] ?? "";
    return /^(?:www|wd\d+|myworkdayjobs)$/.test(label) ? undefined : label;
  } catch {
    return undefined;
  }
}

/**
 * Evidence that the job advert itself has rendered. Workday is a single-page
 * app: the careers shell (header, logo, "Sign In" link) paints immediately
 * while the posting body arrives later. Waiting for one of these before
 * reaching for the Apply button is what separates a slow tenant from a closed
 * posting - Cisco's tenant rendered nothing but its header inside the old
 * budget and was reported as "probably closed" while the posting was live.
 */
const ADVERT_EVIDENCE = [
  SEL.apply,
  '[data-automation-id="jobPostingHeader"]',
  '[data-automation-id="jobPostingDescription"]',
] as const;

/**
 * Longest body text a bare careers shell produces. Cisco's is roughly 60
 * characters ("English | Sign In | Careers | Search for Jobs"); a real advert
 * carries a title, location, requisition id and description and runs to
 * thousands.
 */
const SHELL_TEXT_MAX = 200;

/**
 * Workday's own wording when a requisition has been pulled. Distinguishing this
 * from "the wizard never opened" matters: a dead posting is final and the
 * application should be withdrawn, whereas an unopened wizard is worth retrying.
 */
const DEAD_POSTING_TEXT = /page you are looking for (does ?n[o']?t|doesn't) exist|no longer (available|accepting)|job (posting )?(has been )?(closed|removed)|requisition .*(closed|no longer)/i;

export function isDeadPostingText(text: string): boolean {
  return DEAD_POSTING_TEXT.test(text);
}

export type AdvertState = "advert" | "dead" | "blank";

/**
 * Waits for the advert to paint, ending early on the tenant's not-found page.
 *
 * Element presence alone is not enough: a tenant serves the shell with empty
 * `data-automation-id` containers already in the DOM, so a selector match
 * reports a rendered advert over a blank page. The posting's own text is the
 * reliable signal, so a body no longer than the surrounding chrome counts as
 * not rendered.
 *
 * The three outcomes are genuinely different and must not be collapsed: an
 * advert can be applied to, a dead posting never will be, and a blank page
 * says nothing about whether the posting is open.
 */
async function awaitAdvert(page: Page, timeoutMs: number): Promise<AdvertState> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const paragraphs = await page.locator("body").allInnerTexts().catch(() => [] as string[]);
    const text = paragraphs.join(" ").trim();

    // Checked before the length gate: the not-found page is itself short.
    const errorShown = await page.locator(SEL.errorBanner).first().isVisible().catch(() => false);
    if (errorShown && isDeadPostingText(text)) return "dead";

    if (text.length > SHELL_TEXT_MAX) {
      for (const selector of ADVERT_EVIDENCE) {
        const visible = await page.locator(selector).first().isVisible().catch(() => false);
        if (visible) return "advert";
      }
    }
    await page.waitForTimeout(1000);
  }
  return "blank";
}

export type WorkdayEntryResult = {
  reached: "form" | "sign-in" | "blocked";
  detail: string;
  createdAccount: boolean;
};

export type WorkdayEntryOptions = {
  allowAccountCreation: boolean;
  /**
   * Waits for the link Workday emails to verify a new or unverified account,
   * resolving to null once the run's wait budget is spent. `since` is when the
   * email was requested, so an older email is not mistaken for it. Without it,
   * an account awaiting verification ends the walk with instructions for a
   * person, as it always has.
   */
  awaitVerificationLink?: (since: Date) => Promise<string | null>;
};

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
  options: WorkdayEntryOptions,
): Promise<WorkdayEntryResult> {
  const credentials: AtsCredentials = getAtsCredentials(profileEmail);

  // The advert has to be on screen before the Apply button can be reached for.
  // Without this the run raced the single-page app and blamed the posting.
  const advert = await awaitAdvert(page, 45_000);

  // A pulled requisition renders the tenant's not-found page, which has neither
  // an Apply button nor a sign-in form. Naming it here stops the caller from
  // retrying a posting that will never come back.
  if (advert === "dead") {
    return {
      reached: "blocked",
      detail: "the posting no longer exists; Workday served its not-found page",
      createdAccount: false,
    };
  }

  await clickIfPresent(page, SEL.apply, 15_000);
  // The modal offers "Autofill with Resume" and "Apply Manually". Manual is the
  // honest path: resume autofill silently invents field values from parsed text.
  await clickIfPresent(page, SEL.applyManually, 8000);
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);

  // Newer tenants gate the credential form behind a provider chooser offering
  // "Sign in with Google" or "Sign in with email". That page carries no email or
  // password field at all, so the form has to be opened before it can be found.
  // Measured at ~8s to paint on Workday's own tenant, so 6s lost the race.
  await clickIfPresent(page, SEL.signInWithEmail, 20_000);

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
    if (!(await atApplicationForm(page))) {
      return {
        reached: "blocked",
        detail: advert === "advert"
          ? "no application form on screen and no sign-in gate; the posting is probably closed or the wizard never opened"
          : "the job advert never rendered within 45s; the tenant is slow or is refusing this session, so whether the posting is open is unknown",
        createdAccount: false,
      };
    }
    return { reached: "form", detail: "already signed in; application form reached", createdAccount: false };
  }

  const signedIn = await signIn(page, credentials);
  if (signedIn.ok) return { reached: "form", detail: signedIn.detail, createdAccount: false };

  // An account that exists but was never verified refuses sign-in until its
  // email link is opened, and registering again cannot get past that.
  if (VERIFY_ACCOUNT_TEXT.test(signedIn.detail)) {
    const unverified = `an account for ${credentials.email} exists on this tenant but is not verified yet: open the verification email sent to ${credentials.email}, then rerun`;
    if (!options.awaitVerificationLink) return { reached: "sign-in", detail: unverified, createdAccount: false };
    // Taken before the click, so the email it triggers cannot predate it.
    const requestedAt = new Date();
    if (!(await requestVerificationEmail(page, credentials.email))) {
      return {
        reached: "sign-in",
        detail: `${unverified}; no Resend Account Verification control was found to request a fresh email`,
        createdAccount: false,
      };
    }
    const verified = await verifyByEmailedLink(page, credentials, options.awaitVerificationLink, requestedAt);
    return {
      reached: verified.ok ? "form" : "sign-in",
      detail: verified.ok ? "verified the existing account via the emailed link and signed in" : `${unverified}; ${verified.detail}`,
      createdAccount: false,
    };
  }

  if (!options.allowAccountCreation) {
    return { reached: "sign-in", detail: `${signedIn.detail}; account creation not permitted`, createdAccount: false };
  }

  const created = await createAccount(page, credentials, options.awaitVerificationLink);
  return {
    reached: created.ok ? "form" : created.created ? "sign-in" : "blocked",
    detail: created.detail,
    createdAccount: created.created,
  };
}
