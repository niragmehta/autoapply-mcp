import { z } from "zod";
import type { CompensationRange } from "../domain/job.js";
import { analyzeLocation, type LocationHints, type LocationAnalysis } from "../ranking/location.js";
import { normalizeForMatch } from "../text/html.js";
import { logger } from "../util/logger.js";
import { asString } from "./normalize.js";

const ComponentSchema = z.object({
  compensationType: z.unknown().optional(),
  interval: z.unknown().optional(),
  currencyCode: z.unknown().optional(),
  minValue: z.unknown().optional(),
  maxValue: z.unknown().optional(),
});
const TierSchema = z.object({
  // Ashby sends title: null on most postings, which carry a single band.
  title: z.string().nullish(),
  tierSummary: z.string().nullish(),
  components: z.array(ComponentSchema),
});

export type AshbyCompensation = {
  compensationTierSummary?: unknown;
  summaryComponents?: unknown;
  compensationTiers?: unknown;
};

const INTERVAL_MAP: Record<string, CompensationRange["period"]> = {
  "1 year": "year",
  "1 month": "month",
  "1 hour": "hour",
};

function salaryRange(components: unknown, raw: string): CompensationRange | null {
  const parsed = z.array(ComponentSchema).safeParse(components ?? []);
  if (!parsed.success) {
    logger.warn("invalid Ashby compensation components", { raw });
    return null;
  }
  const salary = parsed.data.find((component) => asString(component.compensationType).toLowerCase() === "salary");
  if (!salary) return null;
  const min = typeof salary.minValue === "number" && Number.isFinite(salary.minValue) ? salary.minValue : null;
  const max = typeof salary.maxValue === "number" && Number.isFinite(salary.maxValue) ? salary.maxValue : null;
  if (min === null && max === null) return null;
  return {
    min,
    max,
    currency: (asString(salary.currencyCode, "USD") || "USD").toUpperCase().slice(0, 3),
    period: INTERVAL_MAP[asString(salary.interval).toLowerCase()] ?? "unknown",
    source: "ats-structured",
    raw,
  };
}

function geographicSpecificity(title: string, location: LocationAnalysis): number {
  const text = normalizeForMatch(title);
  if (/\b(?:except|exclud(?:e[ds]?|ing)|outside|other|non|not|but)\b/.test(text)) return 0;
  if (location.country === "US" && /^(?:us|usa|united states)(?: - all locations)?$/.test(text)) return 1;
  if (location.country === "CA" && /^(?:canada|canadian)(?: - all locations)?$/.test(text)) return 1;
  if (analyzeLocation([title]).country !== location.country) return 0;
  if (["bay-area", "us-other", "canada"].includes(location.locationClass)) {
    const place = normalizeForMatch(location.matched);
    // A country signal is not a region; Washington alone does not distinguish the state from DC.
    if (/^(?:us|usa|united states(?: of america)?|canada|canadian|washington)$/.test(place)) return 0;
    if (place.length > 2 && /^[a-z ]+$/.test(place) && ` ${text} `.includes(` ${place} `)) return 3;
  }
  if (location.locationClass === "bay-area" && /\b(?:california|bay area)\b/.test(text)) return 2;
  return 0;
}

/** Do not infer a region from currency or choose the largest of several levels. */
export function ashbyStructuredPay(
  compensation: AshbyCompensation | undefined,
  locations: readonly string[],
  hints: LocationHints,
): CompensationRange | null {
  if (!compensation) return null;
  const summary = salaryRange(compensation.summaryComponents, asString(compensation.compensationTierSummary, "ashby compensation"));
  if (compensation.compensationTiers === undefined) return summary;
  const parsed = z.array(TierSchema).safeParse(compensation.compensationTiers);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    logger.warn("invalid Ashby compensation tiers; retaining published summary", {
      path: issue?.path.join("."), issue: issue?.message,
    });
    return summary;
  }
  if (parsed.data.length === 0) return summary;
  const [only] = parsed.data;
  if (parsed.data.length === 1 && !only!.title) {
    return summary ?? salaryRange(only!.components, only!.tierSummary ?? "ashby compensation");
  }
  const location = analyzeLocation(locations, hints);
  const scored = parsed.data.map((tier) => ({
    tier, specificity: tier.title ? geographicSpecificity(tier.title, location) : 0,
  }));
  const highest = Math.max(...scored.map((entry) => entry.specificity));
  const matches = scored.filter((entry) => entry.specificity > 0 && entry.specificity === highest);
  if (matches.length !== 1) {
    logger.warn("Ashby geographic compensation unresolved; retaining published summary for manual verification", {
      locationClass: location.locationClass, matchingTiers: matches.length,
    });
    return summary;
  }
  const tier = matches[0]!.tier;
  const selected = salaryRange(tier.components, `${tier.title}: ${tier.tierSummary ?? "ashby compensation"}`);
  if (selected) return selected;
  logger.warn("Ashby geographic tier has no usable salary; retaining published summary", { tier: tier.title });
  return summary;
}
