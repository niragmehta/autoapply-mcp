/**
 * Date readers for the formats enterprise ATS publish. Every reader returns an
 * absolute ISO instant or null; none guesses. Date-only values are pinned to
 * UTC midnight so the same posting reads the same on every machine.
 */

const MONTHS: Readonly<Record<string, number>> = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12,
};

function utcDay(year: number, month: number, day: number): string | null {
  if (!Number.isInteger(year) || year < 1990 || year > 2100) return null;
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCDate() === day ? date.toISOString() : null;
}

function monthNumber(name: string): number | null {
  return MONTHS[name.slice(0, 4).toLowerCase()] ?? MONTHS[name.slice(0, 3).toLowerCase()] ?? null;
}

/**
 * ISO-8601 date or date-time to an instant. Accepts offsets written without a
 * colon ("+0000"), which Oracle and Phenom emit and `Date.parse` rejects.
 */
export function isoInstant(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text);
  if (dateOnly) return utcDay(Number(dateOnly[1]), Number(dateOnly[2]), Number(dateOnly[3]));
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text)) return null;
  const normalized = text.replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
  const millis = Date.parse(/(?:Z|[+-]\d{2}:\d{2})$/i.test(normalized) ? normalized : `${normalized}Z`);
  return Number.isFinite(millis) ? new Date(millis).toISOString() : null;
}

/** US month-first dates: "11/6/2026", and two-digit years ("7/3/25") as 20YY. */
export function usDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(value.trim());
  if (!match) return null;
  const year = Number(match[3]);
  return utcDay(year < 100 ? 2000 + year : year, Number(match[1]), Number(match[2]));
}

/**
 * Dates that spell the month: "Oct 16, 2026", "16-Oct-2026", "16 October 2026"
 * and Java's `Date.toString()` form "Fri Nov 06 02:01:00 UTC 2026".
 */
export function namedMonthDate(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  const java = /^[A-Za-z]{3} ([A-Za-z]{3}) (\d{1,2}) (\d{2}):(\d{2}):(\d{2}) (?:UTC|GMT) (\d{4})$/.exec(text);
  if (java) {
    const month = monthNumber(java[1]!);
    const day = month ? utcDay(Number(java[6]), month, Number(java[2])) : null;
    if (!day) return null;
    const time = (Number(java[3]) * 3600 + Number(java[4]) * 60 + Number(java[5])) * 1000;
    return new Date(Date.parse(day) + time).toISOString();
  }
  const monthFirst = /^([A-Za-z]{3,9})\.? (\d{1,2}),? (\d{4})$/.exec(text);
  if (monthFirst) {
    const month = monthNumber(monthFirst[1]!);
    return month ? utcDay(Number(monthFirst[3]), month, Number(monthFirst[2])) : null;
  }
  const dayFirst = /^(\d{1,2})[- ]([A-Za-z]{3,9})\.?[- ](\d{4})$/.exec(text);
  if (dayFirst) {
    const month = monthNumber(dayFirst[2]!);
    return month ? utcDay(Number(dayFirst[3]), month, Number(dayFirst[1])) : null;
  }
  return null;
}

/** Epoch seconds (Eightfold's timestamps) to an instant. */
export function epochSeconds(value: unknown): string | null {
  const seconds = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  const date = new Date(seconds * 1000);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

/** First reader that understands the value, for sources mixing formats. */
export function anyDate(value: unknown): string | null {
  return isoInstant(value) ?? usDate(value) ?? namedMonthDate(value);
}
