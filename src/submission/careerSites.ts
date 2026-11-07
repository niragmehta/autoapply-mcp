import { join } from "node:path";
import type { BrowserRunResult } from "./browser/types.js";
import { walkAmazon } from "./sites/amazon.js";
import { walkGoogle } from "./sites/google.js";
import { result } from "./sites/helpers.js";
import { walkMeta } from "./sites/meta.js";
import type { CareerSite, CareerSiteRun } from "./sites/types.js";

/**
 * Employers' own career sites: Google, Meta, Amazon and Apple.
 *
 * None of them takes an application from an anonymous visitor, and each
 * blocks sign-in from an automated browser. So the candidate signs in once, by
 * hand, in an ordinary Chrome window using a dedicated profile directory, and
 * runs here reuse that profile's session. Nothing in this module signs in,
 * creates an account or answers a challenge: a session that has lapsed ends
 * the run with a request to sign in again.
 */

export function careerSiteFor(url: string): CareerSite | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  if ((host === "www.google.com" || host === "google.com") && parsed.pathname.startsWith("/about/careers/")) return "google";
  if (host === "www.metacareers.com" || host === "metacareers.com") return "meta";
  if (host === "www.amazon.jobs" || host === "amazon.jobs" || host === "account.amazon.jobs") return "amazon";
  if (host === "jobs.apple.com") return "apple";
  return null;
}

/** The signed-in browser profile: AUTOAPPLY_BROWSER_PROFILE, else `<home>/browser-profiles/careers`. */
export function careerProfileDir(home: string): string {
  const configured = process.env.AUTOAPPLY_BROWSER_PROFILE?.trim();
  return configured ? configured : join(home, "browser-profiles", "careers");
}

/**
 * The installed Chrome by default: a profile signed in by hand in Chrome keeps
 * its cookies readable only to the same browser build. `chromium` selects
 * Playwright's bundled browser instead.
 */
export function careerBrowserChannel(): string | undefined {
  const configured = process.env.AUTOAPPLY_BROWSER_CHANNEL?.trim().toLowerCase();
  if (configured === "chromium") return undefined;
  return configured || "chrome";
}

/** Walks one employer career-site application in the signed-in profile. */
export async function runCareerSiteApplication(run: CareerSiteRun): Promise<BrowserRunResult> {
  switch (run.site) {
    case "google":
      return walkGoogle(run);
    case "meta":
      return walkMeta(run);
    case "amazon":
      return walkAmazon(run);
    default:
      return result("aborted", `${run.site} career-site applications are not automated yet`, run.page);
  }
}
