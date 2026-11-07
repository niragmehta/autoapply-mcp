import type { AtsKind } from "../../domain/campaign.js";

/** Default per-board ceilings for enterprise boards; see docs/SOURCES_ENTERPRISE.md. */
export const DEFAULT_MAX_POSTINGS = 500;
export const DEFAULT_MAX_DETAILS = 100;

function envInteger(name: string, fallback: number, minimum: number): number {
  const raw = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(raw) && raw >= minimum ? raw : fallback;
}

/**
 * Most postings one board may return, from `AUTOAPPLY_<ATS>_MAX_POSTINGS`.
 * Enterprise employers publish thousands of unrelated roles, so narrowing with
 * `company.query` is kinder to them than raising this.
 */
export function maxPostings(kind: AtsKind): number {
  return envInteger(`AUTOAPPLY_${kind.toUpperCase()}_MAX_POSTINGS`, DEFAULT_MAX_POSTINGS, 1);
}

/**
 * Most per-posting requests one board may spend filling in descriptions the
 * listing lacks, from `AUTOAPPLY_<ATS>_MAX_DETAILS` (0 turns them off). Postings
 * past the cap keep the listing's own fields.
 */
export function maxDetails(kind: AtsKind): number {
  return envInteger(`AUTOAPPLY_${kind.toUpperCase()}_MAX_DETAILS`, DEFAULT_MAX_DETAILS, 0);
}

/**
 * Per-host spacing for a source that throttles harder than most, as a
 * multiple of the shared `AUTOAPPLY_MIN_INTERVAL_MS` (700ms by default), so
 * setting that to zero in tests still removes every wait.
 */
export function slowerInterval(multiplier: number): number {
  return envInteger("AUTOAPPLY_MIN_INTERVAL_MS", 700, 0) * multiplier;
}
