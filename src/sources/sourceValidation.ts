import { z } from "zod";
import { roleFingerprint } from "../domain/fingerprint.js";
import type { CompensationRange, Job } from "../domain/job.js";
import { parseCompensationFromText } from "../ranking/compensation.js";
import { AppError } from "../util/errors.js";
import { normalizeJob } from "./normalize.js";
import type { RawJobInput } from "./normalize.js";
import type { BoardVerification } from "./types.js";

export const nonEmptyText = z.string().trim().min(1);
export const optionalText = z.string().nullish();
export const postingIdentifier = nonEmptyText.regex(/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,199}$/);

export function parseSourcePayload<T>(schema: z.ZodType<T>, value: unknown, source: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const paths = result.error.issues.slice(0, 5).map((issue) => issue.path.join(".") || "root");
    throw new AppError("invalid_source_payload", `${source} payload schema mismatch at ${paths.join(", ")}`);
  }
  return result.data;
}

export function boardToken(value: string, dnsLabel = false): string {
  const pattern = dnsLabel
    ? /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/
    : /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/;
  if (!pattern.test(value)) {
    throw new AppError("invalid_board", "board must be a single public employer token, not a URL or path");
  }
  return dnsLabel ? value.toLowerCase() : value;
}

export function publishedDate(value: string | null | undefined): string | null {
  if (!value?.trim()) return null;
  const candidate = value.trim().replace(/^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) UTC$/, "$1T$2Z");
  const valid = z.iso.date().safeParse(candidate).success
    || z.iso.datetime({ offset: true }).safeParse(candidate).success;
  return valid ? candidate : null;
}

const amount = z.preprocess(
  (value) => value === "" || value === undefined ? null : value,
  z.union([
    z.number().nonnegative(),
    z.string().regex(/^\d+(?:\.\d+)?$/).transform(Number).pipe(z.number().nonnegative()),
  ]).nullable(),
);
const salarySchema = z.object({
  min: amount,
  max: amount,
  currency: z.string().trim().regex(/^[a-zA-Z]{3}$/),
  period: optionalText,
}).refine((value) => value.min === null || value.max === null || value.min <= value.max);

const PERIODS: Readonly<Record<string, CompensationRange["period"]>> = {
  year: "year", yearly: "year", annual: "year", annually: "year", per_year: "year",
  month: "month", monthly: "month", per_month: "month",
  hour: "hour", hourly: "hour", per_hour: "hour",
};

export function publishedSalary(value: unknown): CompensationRange | null {
  const result = salarySchema.safeParse(value);
  if (!result.success || (result.data.min === null && result.data.max === null)) return null;
  const salary = result.data;
  return {
    min: salary.min,
    max: salary.max,
    currency: salary.currency.toUpperCase(),
    period: PERIODS[salary.period?.trim().toLowerCase() ?? ""] ?? "unknown",
    source: "ats-structured",
    raw: JSON.stringify(salary),
  };
}

const BASE_PAY_LABEL = /\b(?:base(?:\s+(?:annual|monthly|hourly))?\s+(?:salary|pay)|(?:fixed\s+)?(?:annual|monthly|hourly)\s+(?:base\s+)?salary|fixed\s+salary|salary(?:\s+range)?|hourly\s+pay)\b/gi;
const NON_BASE_PAY = /\b(?:total\s+compensation|target\s+compensation|on[- ]target|ote|bonus|equity|variable|commission|stock)\b/i;
const PAY_PERIOD_UNIT = String.raw`(?:(?:per|a|an|each)\s+(?:hour|month|year)|\/\s*(?:hour|hr|month|mo|year|yr)|hourly|monthly|annually|annual|yearly)`;
const HEADING_WORD = String.raw`(?:base|salary|compensation|pay|range|rate|for|the|this|role|position|is|of|between|from|expected|will|be|at|a|an|usd|cad|eur|gbp)`;
const PERIOD_HEADING = new RegExp(String.raw`\b${PAY_PERIOD_UNIT}(?:[\s:()]+${HEADING_WORD})*[\s:()]*$`, "i");
const PERIOD_SUFFIX = new RegExp(String.raw`^\s*(?:(?:USD|CAD|GBP|EUR|PLN)\s+)?(?:\(\s*)?(?:gross\s+)?${PAY_PERIOD_UNIT}\b`, "i");

function explicitPayPeriod(context: string, range: CompensationRange): CompensationRange["period"] {
  const normalized = context.replace(/\s+/g, " ");
  const start = normalized.indexOf(range.raw);
  if (start < 0) return "unknown";
  const before = normalized.slice(0, start);
  const heading = PERIOD_HEADING.exec(before);
  const headingBelongsToAmount = heading && /\d[\d,.]*\s*$/.test(before.slice(0, heading.index));
  const after = normalized.slice(start + range.raw.length);
  return (heading && !headingBelongsToAmount) || PERIOD_SUFFIX.test(after) ? range.period : "unknown";
}

function publishedBasePay(description: string, fallbackCurrency: string): CompensationRange | null {
  for (const match of description.matchAll(BASE_PAY_LABEL)) {
    const start = match.index ?? 0;
    const preceding = description.slice(Math.max(0, start - 35), start);
    if (/\b(?:total|target|on[- ]target)\s*$/.test(preceding)) continue;
    const following = description.slice(start, start + 300);
    const nonBase = NON_BASE_PAY.exec(following);
    const context = nonBase ? following.slice(0, nonBase.index) : following;
    const range = parseCompensationFromText(context, fallbackCurrency);
    if (range) return { ...range, period: explicitPayPeriod(context, range) };
  }
  return null;
}

function isoCountry(value: string): string | null {
  if (/^(?:us|usa|united states(?: of america)?)$/i.test(value)) return "US";
  if (/^(?:ca|can|canada)$/i.test(value)) return "CA";
  return /^[a-z]{2}$/i.test(value) ? value.toUpperCase() : null;
}

export function countryName(value: string | null | undefined): string {
  const text = value?.trim() ?? "";
  const code = isoCountry(text);
  return code ? new Intl.DisplayNames(["en"], { type: "region" }).of(code) ?? text : text;
}

export function locationLabel(parts: {
  city?: string | null;
  region?: string | null;
  country?: string | null;
  countryCode?: string | null;
}): string {
  return [...new Set([parts.city, parts.region, countryName(parts.countryCode || parts.country)]
    .map((value) => value?.trim() ?? "").filter(Boolean))].join(", ");
}

function restrictedGeography(job: Job, countryValues: readonly string[]): Job {
  const countries = [...new Set(countryValues.map((value) => value.trim()).filter(Boolean))];
  const restrictions = countries.filter((value) => !/^(?:unknown|worldwide|global|anywhere)$/i.test(value));
  const restrictedText = job.locationClass === "remote-global" && job.locationsRaw.some((value) =>
    value.replace(/\b(?:work\s+from\s+home|remote|worldwide|global|anywhere|wfh|distributed|virtual|job|role|position|fully)\b/gi, "")
      .replace(/[^\p{L}\p{N}]+/gu, "").length > 0);
  if ((!restrictedText && restrictions.length === 0)
    || restrictions.some((value) => ["US", "CA"].includes(isoCountry(value) ?? ""))) {
    return job;
  }
  const codes = [...new Set(restrictions.map(isoCountry).filter((value) => value !== null))];
  // The shared classifier only knows US/Canada. A foreign-only remote role is
  // restricted, not worldwide; matching city/state names cannot override that.
  return {
    ...job,
    country: codes.length === 1 ? codes[0]! : "unknown",
    locationClass: "other",
    fingerprint: roleFingerprint(job.companyName, job.title, "other"),
  };
}

export function normalizePublicJob(input: RawJobInput, capturedAt: string, countries: readonly string[]): Job {
  const job = restrictedGeography(normalizeJob(input, capturedAt), countries);
  return {
    ...job,
    compensation: input.structuredCompensation
      ?? publishedBasePay(job.descriptionText, job.country === "CA" ? "CAD" : "USD"),
  };
}

export function boardVerification(titles: readonly string[], total = titles.length): BoardVerification {
  return {
    ok: titles.length > 0,
    postings: total,
    sampleTitles: titles.slice(0, 3),
    detail: titles.length > 0 ? "board returned published postings" : "board exists but has no published postings",
  };
}
