import { publishedDate } from "../sourceValidation.js";

const NAIVE_DATETIME = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?$/;

/**
 * Normalizes a published date to an absolute ISO-8601 instant, or null.
 *
 * Several boards publish datetimes with no offset ("2026-08-06T00:00:00");
 * those are read as UTC rather than the machine's local time, so the same
 * posting gets the same age everywhere. Anything unparseable stays null: a
 * missing date is better than a fabricated one.
 */
export function absoluteDate(value: unknown): string | null {
  if (typeof value === "number") return epochDate(value);
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (!text) return null;
  const candidate = NAIVE_DATETIME.test(text) ? `${text.replace(" ", "T")}Z` : text;
  const valid = publishedDate(candidate) ?? rfc2822(candidate);
  if (!valid) return null;
  const date = new Date(valid);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function epochDate(value: number): string | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  const date = new Date(value < 100_000_000_000 ? value * 1000 : value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** RSS dates such as "Thu, 01 Oct 2026 10:01:45 +0200". */
function rfc2822(value: string): string | null {
  if (!/^[A-Z][a-z]{2}, \d{1,2} [A-Z][a-z]{2} \d{4} \d{2}:\d{2}(?::\d{2})? (?:[+-]\d{4}|GMT|UTC|Z)$/.test(value)) return null;
  return Number.isNaN(Date.parse(value)) ? null : value;
}

/** The earlier of two dates; a repost must not hide an earlier publication. */
export function earliestDate(...values: Array<string | null | undefined>): string | null {
  const dates = values.filter((value): value is string => typeof value === "string" && value.length > 0);
  if (dates.length === 0) return null;
  return dates.reduce((earliest, value) => (Date.parse(value) < Date.parse(earliest) ? value : earliest));
}
