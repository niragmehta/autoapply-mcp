import type { Profile } from "../domain/profile.js";

/**
 * Figures and dates in prose, for every fact check that refuses a number the
 * candidate's own record does not hold.
 *
 * A magnitude is part of its figure, so "50k" and "50 thousand" are one value
 * (after career-ops' fact gate, https://github.com/career-ops-hq/career-ops,
 * MIT). A number glued to letters (EC2, P99, K8s, IPv6, 2FA) is an
 * identifier, not a claim. Each feature decides how figures must match; this
 * module only reads them.
 */

type FigureKind = "percent" | "money" | "plain";

export type Figure = {
  /** As written, currency and suffix included ("$1.2M", "40%", "300+"). */
  raw: string;
  index: number;
  /** The full value: "1.2M" is 1200000. */
  value: number;
  /** The number as written before any magnitude: "1.2M" is 1.2. */
  mantissa: number;
  /** Whether a magnitude ("k", "million") scaled the number. */
  scaled: boolean;
  kind: FigureKind;
};

const FIGURE =
  /(?<![\p{L}\p{N}.,$€£])(?<currency>(?:US|CA|AU|C|A)?[$€£]\s?|(?:USD|CAD|EUR|GBP|AUD)\s)?(?<int>\d{1,3}(?:,\d{3})+|\d+)(?:\.(?<frac>\d+))?(?:st|nd|rd|th)?(?<percent>\s?(?:%|percent\b|per\s?cent\b|pct\b))?(?:\s?(?<magnitude>thousand|million|billion)\b|(?<suffix>bn|mm|k|m|b|ms|secs?|mins?|hrs?|h|x|gb|tb|mb|kb|pb|ghz|qps|rps|tps)(?![\p{L}\p{N}]))?\+?(?![\p{L}\p{N}])/giu;

const MAGNITUDES: Readonly<Record<string, number>> = { thousand: 1e3, million: 1e6, billion: 1e9, k: 1e3, m: 1e6, mm: 1e6, b: 1e9, bn: 1e9 };

/** "40-50%" and "40 to 50 percent": the first figure is a percentage too. */
const RANGE_JOIN = /^\s*(?:-|\u2013|\u2014|to)\s*$/i;

/** Every figure in `text`: counts, percentages, money, "N+", ordinals and figures with a unit or magnitude. */
export function extractFigures(text: string): Figure[] {
  const found = [...text.matchAll(FIGURE)].map((match) => {
    const groups = match.groups ?? {};
    const scale = MAGNITUDES[(groups.magnitude ?? groups.suffix ?? "").toLowerCase()] ?? 1;
    const mantissa = Number(`${(groups.int ?? "0").replace(/,/g, "")}${groups.frac ? `.${groups.frac}` : ""}`);
    const kind: FigureKind = groups.percent ? "percent" : groups.currency ? "money" : "plain";
    const index = match.index ?? 0;
    return { raw: match[0].trim(), index, end: index + match[0].length, value: mantissa * scale, mantissa, scaled: scale !== 1, kind };
  });
  return found.map(({ end, ...figure }, position) => {
    const next = found[position + 1];
    const range = figure.kind === "plain" && next?.kind === "percent" && RANGE_JOIN.test(text.slice(end, next.index));
    return range ? { ...figure, kind: "percent" as const } : figure;
  });
}

function canonical(value: number): string {
  return Number.isInteger(value) ? String(value) : String(Number(value.toFixed(6)));
}

/**
 * The spellings a figure can be compared by: "40%" for a percentage, so a
 * percentage only ever meets a percentage; otherwise the number, and its full
 * value when a magnitude scaled it ("1.2M" is "1.2" and "1200000").
 */
export function figureForms(figure: Figure): string[] {
  if (figure.kind === "percent") return [`${canonical(figure.mantissa)}%`];
  return figure.scaled ? [canonical(figure.mantissa), canonical(figure.value)] : [canonical(figure.value)];
}

/** Equal within floating-point noise. */
export function sameValue(left: number, right: number): boolean {
  return Math.abs(left - right) <= 1e-9 * Math.max(1, Math.abs(right));
}

/** ISO dates keep only their year: a month number is no evidence for a "2x" claim. */
export function yearsOnly(text: string): string {
  return text.replace(/\b(\d{4})-\d{1,2}(?:-\d{1,2})?\b/g, "$1");
}

const MONTH = "jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?";

const DATE_AND_TIME_PATTERNS: readonly RegExp[] = [
  new RegExp(String.raw`\b(?:${MONTH})\.?\s+\d{1,2}(?:st|nd|rd|th)?\b(?:,?\s+\d{4}\b)?`, "gi"),
  new RegExp(String.raw`\b\d{1,2}(?:st|nd|rd|th)?\s+(?:of\s+)?(?:${MONTH})\b\.?(?:,?\s+\d{4}\b)?`, "gi"),
  /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g,
  /\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/g,
  /\b\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)(?![a-z])/gi,
  /\b\d{1,2}:\d{2}\b/g,
];

/**
 * Removes calendar dates and clock times. "Our call on November 12 at 3pm"
 * states logistics, not an achievement to verify.
 */
export function withoutDatesAndTimes(text: string): string {
  return DATE_AND_TIME_PATTERNS.reduce((current, pattern) => current.replace(pattern, " "), text);
}

const ISO_TIMESTAMP = /\b\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/g;
const CLOCK_TIME = /\b\d{1,2}:\d{2}(?::\d{2})?\b/g;

/**
 * Removes only machine-written dates and clock times (ISO dates, timestamps,
 * "09:45"), leaving prose such as "4.2/5" or "November 12" alone. For corpora
 * that carry generated timestamps, whose digits must not count as evidence.
 */
export function withoutTimestamps(text: string): string {
  return text.replace(ISO_TIMESTAMP, " ").replace(CLOCK_TIME, " ");
}

const MONTH_KEYS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const SEASONS: Readonly<Record<string, string>> = { spring: "spring", summer: "summer", fall: "fall", autumn: "fall", winter: "winter" };
const DATE = new RegExp(String.raw`\b(?<month>${MONTH}|spring|summer|fall|autumn|winter)\.?\s+(?:\d{1,2},?\s+)?(?<year>(?:19|20)\d{2})\b`, "gi");

type DateClaim = { raw: string; key: string };

/** Month-year and season-year dates, keyed as "feb 2021" or "summer 2019". */
export function extractDates(text: string): DateClaim[] {
  return [...text.matchAll(DATE)].map((match) => {
    const word = (match.groups?.month ?? "").toLowerCase();
    const period = SEASONS[word] ?? word.slice(0, 3);
    return { raw: match[0], key: `${period} ${match.groups?.year ?? ""}` };
  });
}

/** "2021-02" (the profile's date format) as a date key. */
export function isoMonthKey(value: string): string | null {
  const match = /^(\d{4})-(\d{2})/.exec(value.trim());
  if (!match) return null;
  const month = MONTH_KEYS[Number(match[2]) - 1];
  return month ? `${month} ${match[1]}` : null;
}

/** A labelled piece of verified text that figures may be checked against. */
export type EvidenceText = { source: string; text: string };

/**
 * The profile text that counts as evidence for a figure: facts, roles,
 * education, skills and the headline, with ISO dates cut to their year.
 * Compensation, contact details and form answers are excluded: a salary
 * target or a phone number is not an achievement.
 */
export function profileFigureEvidence(profile: Profile): EvidenceText[] {
  const entries: EvidenceText[] = [
    ...profile.facts.map((fact) => ({
      source: `fact:${fact.id}`,
      text: [fact.statement, ...fact.metrics, fact.evidence ?? ""].join("\n"),
    })),
    ...profile.experience.map((role) => ({
      source: `experience:${role.company}`,
      text: [role.title, role.company, role.location, role.start, role.end, ...role.highlights].join("\n"),
    })),
    ...profile.education.map((entry) => ({
      source: `education:${entry.institution}`,
      text: [entry.credential, entry.field, entry.institution, entry.start, entry.end].join("\n"),
    })),
    { source: "skills", text: profile.skills.flatMap((skill) => [skill.name, ...skill.aliases]).join("\n") },
    { source: "headline", text: profile.identity.headline },
  ];
  return entries.map((entry) => ({ ...entry, text: yearsOnly(entry.text) }));
}
