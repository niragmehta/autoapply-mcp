import type { CompensationPolicy } from "../domain/campaign.js";
import type { CompensationRange } from "../domain/job.js";

/**
 * Compensation parsing and comparison.
 *
 * Structured ATS data is preferred; free text is a fallback because postings
 * mix base, total, equity and hourly figures in prose.
 */

const HOURS_PER_YEAR = 2080;
const MONTHS_PER_YEAR = 12;

const MIN_PLAUSIBLE_ANNUAL = 20_000;
const MAX_PLAUSIBLE_ANNUAL = 5_000_000;

const SALARY_CONTEXT = /(salary|compensation|pay range|base pay|base salary|annual|per year|\/yr|total comp|on target earnings|ote)/i;

/**
 * Matches a pay range with the currency written either before the amount
 * ("$220,000 - $280,000") or after it ("224,000 USD - 356,500 USD"). The
 * suffix form is what large US pay-transparency filers publish, and without it
 * the separator never lines up, so such a range parses as no range at all.
 */
const CURRENCY_PREFIX = String.raw`(?:us\$|c\$|cad|usd|cdn|\$)`;
const CURRENCY_SUFFIX = String.raw`(?:usd|cad|cdn|us\$|c\$)`;
const AMOUNT = String.raw`\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?\s*k\b|\d{2,7}(?:\.\d+)?`;

const RANGE_PATTERN = new RegExp(
  String.raw`(?<c1>${CURRENCY_PREFIX})?\s*(?<a>${AMOUNT})(?:\s*(?<s1>${CURRENCY_SUFFIX})\b)?` +
    String.raw`\s*(?:-|–|—|\bto\b|\bthrough\b)\s*` +
    String.raw`(?<c2>${CURRENCY_PREFIX})?\s*(?<b>${AMOUNT})(?:\s*(?<s2>${CURRENCY_SUFFIX})\b)?`,
  "gi",
);

const HOURLY_CONTEXT = /per hour|\/hour|\/hr|hourly|an hour/i;

function parseAmount(token: string): number | null {
  const cleaned = token.replace(/,/g, "").trim().toLowerCase();
  const kMatch = /^(\d+(?:\.\d+)?)\s*k$/.exec(cleaned);
  if (kMatch?.[1]) return Number.parseFloat(kMatch[1]) * 1000;
  const value = Number.parseFloat(cleaned);
  return Number.isFinite(value) ? value : null;
}

function detectCurrency(markers: ReadonlyArray<string | undefined>, window: string, fallback: string): string {
  const joined = `${markers.filter(Boolean).join(" ")} ${window}`.toLowerCase();
  if (/\bcad\b|\bc\$|\bcdn\b|canadian dollar/.test(joined)) return "CAD";
  if (/\busd\b|\bus\$|american dollar/.test(joined)) return "USD";
  if (/[£]|\bgbp\b/.test(joined)) return "GBP";
  if (/[€]|\beur\b/.test(joined)) return "EUR";
  return fallback;
}

function inferPeriod(low: number, high: number, window: string): CompensationRange["period"] {
  if (HOURLY_CONTEXT.test(window)) return "hour";
  if (/per month|\/month|monthly/i.test(window)) return "month";
  if (high <= 400 && low <= 400) return "hour";
  if (high <= 30_000 && /month/i.test(window)) return "month";
  return "year";
}

export function annualize(amount: number, period: CompensationRange["period"]): number {
  if (period === "hour") return amount * HOURS_PER_YEAR;
  if (period === "month") return amount * MONTHS_PER_YEAR;
  return amount;
}

/** Scans free text for the most plausible salary range. */
export function parseCompensationFromText(text: string, fallbackCurrency = "USD"): CompensationRange | null {
  if (!text) return null;
  const candidates: Array<{ range: CompensationRange; score: number }> = [];

  for (const match of text.matchAll(RANGE_PATTERN)) {
    const groups = match.groups;
    if (!groups?.a || !groups?.b) continue;
    const low = parseAmount(groups.a);
    const high = parseAmount(groups.b);
    if (low === null || high === null || high < low) continue;

    const start = Math.max(0, (match.index ?? 0) - 120);
    const window = text.slice(start, (match.index ?? 0) + match[0].length + 120);
    const currency = detectCurrency([groups.c1, groups.c2, groups.s1, groups.s2], window, fallbackCurrency);
    const period = inferPeriod(low, high, window);

    // Small numbers are only credible as pay when the text says so explicitly;
    // otherwise they are years of experience, team sizes or percentages.
    if (high < 1000 && !HOURLY_CONTEXT.test(window)) continue;

    const annualHigh = annualize(high, period);
    if (annualHigh < MIN_PLAUSIBLE_ANNUAL || annualHigh > MAX_PLAUSIBLE_ANNUAL) continue;

    const hasCurrencyMark = Boolean(groups.c1 ?? groups.c2 ?? groups.s1 ?? groups.s2);
    const contextScore = (SALARY_CONTEXT.test(window) ? 2 : 0) + (hasCurrencyMark ? 1 : 0);
    if (contextScore === 0) continue;

    candidates.push({
      range: {
        min: low,
        max: high,
        currency,
        period,
        source: "description-text",
        raw: match[0].replace(/\s+/g, " ").trim(),
      },
      score: contextScore * 1_000_000 + annualHigh,
    });
  }

  if (candidates.length === 0) return null;
  return candidates.sort((a, b) => b.score - a.score)[0]!.range;
}

export function convertCurrency(amount: number, from: string, to: string, fx: Record<string, number>): number | null {
  if (from === to) return amount;
  const fromRate = fx[from.toUpperCase()];
  const toRate = fx[to.toUpperCase()];
  if (!fromRate || !toRate) return null;
  // Rates are expressed as "1 unit of currency = N units of the base currency".
  return (amount * fromRate) / toRate;
}

export type FloorCheck = {
  status: "above" | "below" | "unknown";
  annualizedMax: number | null;
  campaignCurrencyMax: number | null;
  floor: number | null;
  reason: string;
};

/**
 * Compares a posting's compensation with the campaign floor for its country.
 * The top of the published range is used, since that is the number a strong
 * candidate can realistically negotiate toward.
 */
export function checkCompensationFloor(
  range: CompensationRange | null,
  country: string,
  policy: CompensationPolicy,
): FloorCheck {
  const floor = policy.floors[country.toUpperCase()] ?? policy.floors["*"] ?? null;
  if (!range || range.max === null) {
    return { status: "unknown", annualizedMax: null, campaignCurrencyMax: null, floor, reason: "no published compensation" };
  }
  const annualizedMax = annualize(range.max, range.period);
  const converted = convertCurrency(annualizedMax, range.currency, policy.currency, policy.fx);
  if (converted === null) {
    return {
      status: "unknown",
      annualizedMax,
      campaignCurrencyMax: null,
      floor,
      reason: `no FX rate configured for ${range.currency}->${policy.currency}`,
    };
  }
  if (floor === null) {
    return { status: "unknown", annualizedMax, campaignCurrencyMax: converted, floor, reason: `no floor configured for ${country}` };
  }
  return {
    status: converted >= floor ? "above" : "below",
    annualizedMax,
    campaignCurrencyMax: converted,
    floor,
    reason: `${Math.round(converted).toLocaleString()} ${policy.currency} vs floor ${floor.toLocaleString()} ${policy.currency}`,
  };
}
