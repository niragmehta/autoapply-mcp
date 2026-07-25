import type { SubmissionPolicy } from "../domain/campaign.js";
import { AppError } from "../util/errors.js";

/**
 * Destination allowlist.
 *
 * Submissions may only go to hosts the campaign explicitly trusts, which stops
 * a redirect or a doctored posting from pointing the automation somewhere else.
 */

export type AllowlistResult = { allowed: boolean; host: string; reason: string };

export function checkUrlAllowed(rawUrl: string, policy: SubmissionPolicy): AllowlistResult {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return { allowed: false, host: "", reason: `not a valid URL: ${rawUrl}` };
  }
  if (parsed.protocol !== "https:") {
    return { allowed: false, host: parsed.host, reason: "only https destinations are allowed" };
  }
  const host = parsed.host.toLowerCase();
  const allowed = policy.allowedAtsDomains.some(
    (domain) => host === domain.toLowerCase() || host.endsWith(`.${domain.toLowerCase()}`),
  );
  return {
    allowed,
    host,
    reason: allowed ? "host is on the allowlist" : `host "${host}" is not in submission.allowedAtsDomains`,
  };
}

export function assertUrlAllowed(rawUrl: string, policy: SubmissionPolicy): void {
  const result = checkUrlAllowed(rawUrl, policy);
  if (!result.allowed) {
    throw new AppError("destination_not_allowed", result.reason, { url: rawUrl, host: result.host });
  }
}

/** Blocks navigation that leaves the allowlisted host mid-flow. */
export function isSameAllowedSite(fromUrl: string, toUrl: string, policy: SubmissionPolicy): boolean {
  return checkUrlAllowed(toUrl, policy).allowed && checkUrlAllowed(fromUrl, policy).allowed;
}
