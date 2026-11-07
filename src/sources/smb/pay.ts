import type { CompensationRange } from "../../domain/job.js";
import { parseCompensationFromText } from "../../ranking/compensation.js";

/**
 * Compensation from dedicated ATS pay fields.
 *
 * A field that states its period keeps it; one that does not is recorded with
 * an `unknown` period instead of being assumed annual, so a missing unit can
 * never turn an hourly rate into a salary or vice versa.
 */

const PERIODS: Readonly<Record<string, CompensationRange["period"]>> = {
  year: "year", years: "year", yearly: "year", annual: "year", annually: "year",
  month: "month", months: "month", monthly: "month",
  hour: "hour", hours: "hour", hourly: "hour",
};

/** Maps a published unit ("YEAR", "Per Year", "per_month", "hourly") to a period. */
export function payPeriod(value: unknown): CompensationRange["period"] {
  if (typeof value !== "string") return "unknown";
  const key = value.trim().toLowerCase().replace(/[_-]+/g, " ").replace(/^per\s+/, "");
  return PERIODS[key] ?? "unknown";
}

function amount(value: unknown): number | null {
  const number = typeof value === "number" ? value
    : typeof value === "string" && /^\s*\d+(?:\.\d+)?\s*$/.test(value) ? Number(value) : Number.NaN;
  return Number.isFinite(number) && number > 0 ? number : null;
}

/** Numeric bounds as published; zero or absent bounds mean "not stated". */
export function structuredPay(
  min: unknown,
  max: unknown,
  currency: unknown,
  period: CompensationRange["period"],
  raw: string,
): CompensationRange | null {
  const low = amount(min);
  const high = amount(max);
  const code = typeof currency === "string" ? currency.trim().toUpperCase() : "";
  if ((low === null && high === null) || !/^[A-Z]{3}$/.test(code)) return null;
  if (low !== null && high !== null && low > high) return null;
  return { min: low, max: high, currency: code, period, source: "ats-structured", raw };
}

const EXPLICIT_UNIT = [
  { period: "hour", pattern: /\b(?:per|an|a)\s+hour\b|\/\s*(?:hour|hr|h)\b|\bhourly\b/i },
  { period: "month", pattern: /\b(?:per|a)\s+month\b|\/\s*(?:month|mo)\b|\bmonthly\b/i },
  { period: "year", pattern: /\b(?:per|a)\s+(?:year|annum)\b|\/\s*(?:year|yr|annum)\b|\b(?:annual|annually|yearly)\b/i },
] as const;

/** A free-text pay field such as "$80,000 – $102,000 / year". */
export function textPay(text: unknown, fallbackCurrency = "USD"): CompensationRange | null {
  if (typeof text !== "string" || !text.trim()) return null;
  const raw = text.trim().slice(0, 300);
  // The field is labelled as pay by the ATS, which the parser otherwise needs as context.
  const range = parseCompensationFromText(`salary ${raw}`, fallbackCurrency);
  if (!range) return null;
  const units = EXPLICIT_UNIT.filter((unit) => unit.pattern.test(raw));
  const period = units.length === 1 ? units[0]!.period : "unknown";
  return { ...range, period, source: "ats-structured", raw };
}
