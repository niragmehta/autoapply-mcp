import { AppError, toErrorMessage } from "../../util/errors.js";
import type { PostingCheck } from "../types.js";

/**
 * Liveness results for SMB postings.
 *
 * Only an explicit answer from the ATS closes a posting: a 404/410 for the
 * posting itself, a non-open status, or a complete board listing that no
 * longer contains it. Everything else — timeouts, 5xx, redirects off the ATS,
 * unreadable payloads — is `unknown`, never `closed`.
 */

const GONE_STATUSES = new Set([404, 410]);

export function isGone(error: unknown): boolean {
  if (!(error instanceof AppError)) return false;
  if (error.code === "not_found") return true;
  return error.code === "http_error" && GONE_STATUSES.has(Number(error.details.status));
}

export function openCheck(detail: string, via: PostingCheck["via"] = "api"): PostingCheck {
  return { status: "open", detail, via };
}

export function closedCheck(detail: string, via: PostingCheck["via"] = "api"): PostingCheck {
  return { status: "closed", detail, via };
}

export function unknownCheck(detail: string, via: PostingCheck["via"] = "api"): PostingCheck {
  return { status: "unknown", detail, via };
}

/** Maps a failed posting request: gone means closed, anything else is unknown. */
export function checkFromError(error: unknown, via: PostingCheck["via"] = "api"): PostingCheck {
  if (isGone(error)) return closedCheck("the ATS no longer serves this posting", via);
  return unknownCheck(`posting could not be read: ${toErrorMessage(error)}`, via);
}

/** Runs a check, turning any thrown error into a closed-or-unknown result. */
export async function safeCheck(run: () => Promise<PostingCheck>, via: PostingCheck["via"] = "api"): Promise<PostingCheck> {
  try {
    return await run();
  } catch (error) {
    return checkFromError(error, via);
  }
}

/** Checks presence in a complete board listing, which is authoritative for closure. */
export function listingCheck(found: boolean, ats: string): PostingCheck {
  return found
    ? openCheck(`${ats} board still lists this posting`)
    : closedCheck(`${ats} board no longer lists this posting`);
}
