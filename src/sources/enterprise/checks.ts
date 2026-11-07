import { AppError, toErrorMessage } from "../../util/errors.js";
import type { PostingCheck } from "../types.js";

type Via = PostingCheck["via"];

export function openCheck(detail: string, via: Via): PostingCheck {
  return { status: "open", detail, via };
}

export function closedCheck(detail: string, via: Via): PostingCheck {
  return { status: "closed", detail, via };
}

export function unknownCheck(detail: string, via: Via): PostingCheck {
  return { status: "unknown", detail, via };
}

/** HTTP status carried by an error from `http.ts`, when there was one. */
export function httpStatus(error: unknown): number | null {
  if (!(error instanceof AppError)) return null;
  if (error.code === "not_found") return 404;
  const status = error.details.status;
  return typeof status === "number" ? status : null;
}

/**
 * Turns a failed read of a single-posting endpoint into a check. Only 404 and
 * 410 from an endpoint that addresses exactly one posting mean the posting is
 * gone; anything else (timeouts, throttling, a WAF page) is `unknown`, never a
 * guess either way.
 */
export function checkFromError(error: unknown, via: Via, goneMeansClosed = true): PostingCheck {
  const status = httpStatus(error);
  if (goneMeansClosed && (status === 404 || status === 410)) {
    return closedCheck(`the ATS answered HTTP ${status} for this posting`, via);
  }
  return unknownCheck(`could not read the posting: ${toErrorMessage(error)}`, via);
}

/** A check for a stored job whose board string no longer parses. */
export function unparseableBoardCheck(error: unknown): PostingCheck {
  return unknownCheck(`cannot address the posting: ${toErrorMessage(error)}`, "api");
}

/** Whether an ISO end date has already passed. */
export function hasEnded(isoEnd: string | null, now = Date.now()): boolean {
  if (!isoEnd) return false;
  const end = Date.parse(isoEnd);
  return Number.isFinite(end) && end < now;
}
