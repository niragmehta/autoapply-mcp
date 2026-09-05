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

const RANGE_START = String.raw`(?<c1>${CURRENCY_PREFIX})?\s*(?<a>${AMOUNT})(?:\s*(?<s1>${CURRENCY_SUFFIX})\b)?`;
const RANGE_END = String.raw`(?<c2>${CURRENCY_PREFIX})?\s*(?<b>${AMOUNT})(?:\s*(?<s2>${CURRENCY_SUFFIX})\b)?`;
const RANGE_PATTERN = new RegExp(
  String.raw`${RANGE_START}\s*(?:-|–|—|\bto\b|\bthrough\b|\band\s+up\s+to\b)\s*${RANGE_END}`,
  "gi",
);
const BETWEEN_RANGE_PATTERN = new RegExp(String.raw`\bbetween\s*${RANGE_START}\s+and\s+${RANGE_END}`, "gi");

const PERIOD_UNIT = String.raw`(?:(?:per|a|an|each)\s+(?:hour|month|year)|\/\s*(?:hour|hr|month|mo|year|yr)|hourly|monthly|annually|annual|yearly)`;
const PAY_HEADING_WORD = String.raw`(?:base|salary|compensation|pay|range|rate|for|the|this|role|position|is|of|between|from|expected|will|be|at|a|an|usd|cad|cdn)`;
const PERIOD_AFTER_RANGE = new RegExp(
  String.raw`^\s*(?:(?:USD|CAD|CDN|GBP|EUR|PLN)\s+)?(?:\(\s*)?(?:gross\s+)?(${PERIOD_UNIT})\b`,
  "i",
);
const PERIOD_BEFORE_RANGE = new RegExp(
  String.raw`\b(${PERIOD_UNIT})(?:[\s:()]+${PAY_HEADING_WORD})*[\s:()]*$`,
  "i",
);

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

function inferPeriod(before: string, after: string): CompensationRange["period"] {
  const suffix = PERIOD_AFTER_RANGE.exec(after);
  const heading = PERIOD_BEFORE_RANGE.exec(before);
  // A unit immediately following another amount belongs to that amount, not
  // to the salary range (e.g. "$300 per month" commuter reimbursement).
  const headingFollowsAmount = heading && /\d[\d,.]*\s*$/.test(before.slice(0, heading.index));
  const unit = suffix?.[1] ?? (headingFollowsAmount ? undefined : heading?.[1]) ?? "";
  if (/hour|\bhr\b/i.test(unit)) return "hour";
  if (/month|\bmo\b/i.test(unit)) return "month";
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

  const matches = [...text.matchAll(RANGE_PATTERN), ...text.matchAll(BETWEEN_RANGE_PATTERN)];
  for (const match of matches) {
    const groups = match.groups;
    if (!groups?.a || !groups?.b) continue;
    const low = parseAmount(groups.a);
    const high = parseAmount(groups.b);
    if (low === null || high === null || high < low) continue;

    const start = Math.max(0, (match.index ?? 0) - 120);
    const window = text.slice(start, (match.index ?? 0) + match[0].length + 120);
    const currency = detectCurrency([groups.c1, groups.c2, groups.s1, groups.s2], window, fallbackCurrency);
    const rangeStart = match.index ?? 0;
    const rangeEnd = rangeStart + match[0].length;
    const period = inferPeriod(text.slice(start, rangeStart), text.slice(rangeEnd, rangeEnd + 120));

    // Small numbers are only credible as pay when the text says so explicitly;
    // otherwise they are years of experience, team sizes or percentages.
    if (high < 1000 && period !== "hour") continue;

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
