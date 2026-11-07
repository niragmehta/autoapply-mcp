import type { CompensationRange } from "../../domain/job.js";

function amount(value: unknown): number | null {
  const number = typeof value === "number" ? value : typeof value === "string" && value.trim() ? Number(value) : Number.NaN;
  return Number.isFinite(number) && number >= 0 ? number : null;
}

/**
 * A pay range the ATS publishes in structured fields. Returns null rather than
 * a half-trusted figure: no amounts, an unknown currency, or a minimum above
 * the maximum all mean the description text decides instead.
 */
export function structuredPay(input: {
  min: unknown;
  max: unknown;
  currency: unknown;
  period: CompensationRange["period"];
  raw: string;
}): CompensationRange | null {
  const min = amount(input.min);
  const max = amount(input.max);
  if ((min === null && max === null) || (min === 0 && max === 0)) return null;
  if (min !== null && max !== null && min > max) return null;
  const currency = typeof input.currency === "string" ? input.currency.trim().toUpperCase() : "";
  if (!/^[A-Z]{3}$/.test(currency)) return null;
  return { min, max, currency, period: input.period, source: "ats-structured", raw: input.raw };
}

/** Maps a pay-period label ("YEAR", "Hourly", "per month") onto the schema's periods. */
export function payPeriod(label: unknown): CompensationRange["period"] {
  const text = typeof label === "string" ? label.trim().toLowerCase() : "";
  if (/^(?:year|yearly|annual|annually|yr|salary|salaried|sa)$/.test(text)) return "year";
  if (/^(?:hour|hourly|hr|per hour)$/.test(text)) return "hour";
  if (/^(?:month|monthly|mo|per month)$/.test(text)) return "month";
  return "unknown";
}
