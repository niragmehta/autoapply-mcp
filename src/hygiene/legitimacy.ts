import type { Job } from "../domain/job.js";
import { annualize } from "../ranking/compensation.js";
import type { PostingCheck } from "../sources/types.js";
import { snippetAround } from "../text/html.js";
import { detectInjection } from "../text/untrusted.js";
import { daysBetween, parseDateSafe } from "../util/hash.js";
import type { ListingPresence } from "../db/repositories/liveness.js";
import type { RepostCluster } from "./reposts.js";

/**
 * Posting legitimacy: observations about whether a posting is a real, active
 * opening worth the candidate's time.
 *
 * Every signal is an observation with its evidence quoted, never an
 * accusation - each has innocent explanations, and the candidate decides how
 * to weigh them. The tier only summarises: "suspicious" when one high-severity
 * signal or two medium ones are present, "caution" for one medium or two low,
 * "high" (confidence) otherwise. Positive and informational signals never
 * lower the tier. Signal set after career-ops' Block G (MIT).
 */

export type LegitimacySeverity = "positive" | "info" | "low" | "medium" | "high";

export type LegitimacySignal = {
  id: string;
  severity: LegitimacySeverity;
  observation: string;
  evidence: string;
  /** A legitimate explanation worth keeping in mind. */
  context?: string;
};

export type LegitimacyTier = "high" | "caution" | "suspicious";

export type LegitimacyAssessment = { tier: LegitimacyTier; signals: LegitimacySignal[]; summary: string };

export type LegitimacyContext = {
  now?: Date;
  liveness?: PostingCheck | null;
  listing?: ListingPresence | null;
  repost?: RepostCluster | null;
};

/**
 * US jurisdictions whose pay-transparency laws require a pay range in job
 * postings, all in force by late 2025: California, Colorado, Washington,
 * New York, Illinois, Minnesota, Maryland, Hawaii, Vermont, Massachusetts,
 * New Jersey and the District of Columbia. Most exempt small employers, and
 * remote roles are generally covered when they can be done from the state.
 */
const PAY_TRANSPARENCY_JURISDICTIONS = ["CA", "CO", "WA", "NY", "IL", "MN", "MD", "HI", "VT", "MA", "NJ", "DC"] as const;

const STATE_NAMES: ReadonlyArray<readonly [string, RegExp]> = [
  ["DC", /\b(?:washington,?\s*d\.?\s?c\b|district of columbia)/i],
  ["CA", /\b(?:california|san francisco|bay area|los angeles|san diego|san jose|palo alto|mountain view|sunnyvale|santa clara|menlo park|oakland|irvine|cupertino|redwood city|san mateo)\b/i],
  ["CO", /\b(?:colorado|denver|boulder)\b/i],
  ["WA", /\b(?:washington(?!,?\s*d\.?\s?c\b)(?! state of)|seattle|bellevue|redmond|kirkland)\b/i],
  ["NY", /\b(?:new york|nyc|brooklyn|manhattan)\b/i],
  ["IL", /\b(?:illinois|chicago)\b/i],
  ["MN", /\b(?:minnesota|minneapolis|st\.? paul)\b/i],
  ["MD", /\b(?:maryland|baltimore|bethesda)\b/i],
  ["HI", /\b(?:hawaii|honolulu)\b/i],
  ["VT", /\b(?:vermont|burlington,?\s*vt)\b/i],
  ["MA", /\b(?:massachusetts|boston)\b/i],
  ["NJ", /\b(?:new jersey|jersey city|newark|princeton|hoboken)\b/i],
];
const STATE_CODE = new RegExp(String.raw`(?:^|[\s,(/-])(${PAY_TRANSPARENCY_JURISDICTIONS.join("|")})(?=$|[\s,)/-])`);

/** The pay-transparency jurisdiction a US posting's locations fall in, or null. */
export function payTransparencyJurisdiction(job: Pick<Job, "locationsRaw" | "locationClass" | "country">): string | null {
  if (job.country.toUpperCase() !== "US") return null;
  for (const location of job.locationsRaw) {
    const code = STATE_CODE.exec(location)?.[1];
    if (code) return code;
    const named = STATE_NAMES.find(([, pattern]) => pattern.test(location));
    if (named) return named[0];
  }
  if (job.locationClass === "bay-area") return "CA";
  return job.locationClass === "remote-us" ? "remote US, covered where it can be done from a listed state" : null;
}

const AGENCY = /\b(?:on behalf of (?:our|a|my) client|our client(?:,| is| has| seeks| are| in)|my client(?:,| is)|(?:a|our) client of ours|we are (?:a|an) (?:staffing|recruiting|recruitment|talent) (?:agency|firm|partner)|(?:staffing|recruitment) agency)\b/i;
const CONTRACT = /\b(?:c2c|corp[- ]to[- ]corp|w-?2 contract|contract[- ]to[- ]hire|fixed[- ]term|\d{1,2}[- ]month (?:contract|assignment|engagement)|temporary (?:role|position|assignment)|1099|independent contractor|contract (?:role|position|assignment|opportunity))\b/i;
const COMMISSION_ONLY = /\b(?:commission[- ]only|100\s?% commission|straight commission|no base salary|unpaid until)\b/i;
const CANDIDATE_FEES =
  /\b(?:(?:training|onboarding|registration|application|processing|background[- ]check|starter[- ]kit|equipment|certification) fees?|refundable deposit|(?:pay|purchase|buy)\b[^.\n]{0,40}\b(?:training|starter kit|equipment|certification|uniform)\b[^.\n]{0,30}\b(?:before|upfront|up front|to start|to begin))\b/i;
const FEE_DENIAL = /\b(?:never|not|no|won't|will not|don't|do not|doesn't|does not|without|free of)\b/i;
const AI_SCREENING =
  /\b(?:ai|artificial intelligence|automated|algorithmic)[- ](?:screening|assessment|interview|decision|scoring|ranking)s?\b|\buses? (?:ai|artificial intelligence|automated (?:tools|systems|employment decision tools?))\b[^.\n]{0,80}\b(?:screen|review|evaluat|assess|rank)|\bautomated employment decision tools?\b/i;
const SPECIFICITY = /\b(?:python|java|go(?:lang)?|rust|typescript|javascript|kubernetes|docker|aws|gcp|azure|sql|react|terraform|linux|spark|kafka|c\+\+|c#|ruby|scala|swift|kotlin|pytorch|tensorflow|graphql|postgres(?:ql)?)\b/i;

function signal(id: string, severity: LegitimacySeverity, observation: string, evidence: string, context?: string): LegitimacySignal {
  return { id, severity, observation, evidence: evidence.slice(0, 300), ...(context ? { context } : {}) };
}

function quote(text: string, pattern: RegExp): string | null {
  const match = pattern.exec(text);
  return match ? snippetAround(text, match[0], 80) || match[0] : null;
}

function freshnessSignals(job: Job, now: Date): LegitimacySignal[] {
  const posted = parseDateSafe(job.postedAt);
  if (!posted) return [signal("no-posting-date", "info", "The posting publishes no date", "postedAt is empty")];
  const age = Math.round(daysBetween(posted, now));
  if (age > 60) {
    return [signal("stale-posting", "medium", `Posted ${age} days ago`, job.postedAt ?? "", "Senior, niche and evergreen roles legitimately stay open for months.")];
  }
  if (age <= 14) return [signal("fresh-posting", "positive", `Posted ${age} day(s) ago`, job.postedAt ?? "")];
  return [];
}

function livenessSignals(context: LegitimacyContext): LegitimacySignal[] {
  const found: LegitimacySignal[] = [];
  const liveness = context.liveness;
  if (liveness?.status === "closed") found.push(signal("liveness-closed", "high", "The posting is no longer taking applications", liveness.detail));
  if (liveness?.status === "open") found.push(signal("liveness-open", "positive", "The posting is live", liveness.detail));
  if (liveness?.status === "unknown") found.push(signal("liveness-unknown", "info", "Liveness could not be confirmed", liveness.detail));
  if (context.listing?.status === "absent") {
    found.push(signal("absent-from-listing", "medium", "The board's latest listing no longer includes the posting", context.listing.detail, "Boards sometimes hide a posting briefly while it is edited."));
  }
  const repost = context.repost;
  if (repost?.reposted) {
    found.push(
      signal(
        "repost-cluster",
        "medium",
        `The same role was posted ${repost.postings} times, first seen on ${repost.distinctDates} different dates`,
        `${repost.sampleTitle}: ${repost.earliestSeenAt.slice(0, 10)} to ${repost.latestSeenAt.slice(0, 10)}`,
        "Hard-to-fill and evergreen roles are reposted to stay near the top of job boards.",
      ),
    );
  }
  return found;
}

function paySignals(job: Job): LegitimacySignal[] {
  const pay = job.compensation;
  if (pay && pay.min !== null && pay.max !== null && pay.min > 0) {
    const low = annualize(pay.min, pay.period);
    const high = annualize(pay.max, pay.period);
    if (low !== null && high !== null && (high / low >= 2 || high - low >= 150_000)) {
      return [signal("wide-pay-range", "low", `The pay range is wide (${pay.min.toLocaleString()} to ${pay.max.toLocaleString()} ${pay.currency})`, pay.raw, "Several levels or locations folded into one range read the same way.")];
    }
    return [signal("pay-published", "positive", "The posting publishes pay", pay.raw)];
  }
  const jurisdiction = payTransparencyJurisdiction(job);
  if ((!pay || pay.max === null) && jurisdiction) {
    return [signal("pay-missing-in-transparency-jurisdiction", "low", `No pay range, though the posting is in a pay-transparency jurisdiction (${jurisdiction})`, job.locationsRaw.join(" | "), "Small employers are exempt in most of these jurisdictions.")];
  }
  return [];
}

function textSignals(job: Job): LegitimacySignal[] {
  const text = job.descriptionText ?? "";
  const found: LegitimacySignal[] = [];
  const agency = quote(text, AGENCY);
  if (agency) found.push(signal("staffing-agency", "medium", "Posted by an intermediary on behalf of an unnamed client", agency, "Agencies fill real roles; ask which employer it is before applying."));
  const contract = quote(text, CONTRACT) ?? (/\b(?:contract|temporary|temp|freelance)\b/i.test(job.employmentType) ? job.employmentType : null);
  if (contract) found.push(signal("contract-terms", "info", "Contract, fixed-term or contractor terms", contract));
  const commission = quote(text, COMMISSION_ONLY);
  if (commission) found.push(signal("commission-only", "medium", "Pay appears to be commission only", commission));
  const feeMatch = CANDIDATE_FEES.exec(text);
  if (feeMatch) {
    const sentence = snippetAround(text, feeMatch[0], 60);
    if (!FEE_DENIAL.test(sentence)) {
      found.push(signal("candidate-paid-fees", "high", "The candidate is asked to pay a fee or buy equipment - a common scam pattern", sentence || feeMatch[0]));
    }
  }
  const ai = quote(text, AI_SCREENING);
  if (ai) found.push(signal("ai-screening-disclosed", "info", "The employer discloses AI or automated screening", ai));
  const injections = detectInjection(text);
  if (injections.length > 0) {
    found.push(signal("embedded-instructions", "low", "The description contains instructions aimed at AI tools", injections.map((flag) => flag.match).join(" | "), "Some employers plant these to detect automated applications."));
  }
  const length = text.trim().length;
  if (length < 500) {
    found.push(signal("very-short-description", "medium", `The description is very short (${length} characters)`, text.slice(0, 200)));
  } else if (length < 1500 && !SPECIFICITY.test(text)) {
    found.push(signal("vague-description", "low", "The description names no specific technology or tool", `${length} characters`, "Early-stage companies often write short, general postings."));
  }
  return found;
}

const TIER_SUMMARY: Readonly<Record<LegitimacyTier, string>> = {
  high: "High confidence: nothing observed suggests this is not a real, active opening.",
  caution: "Proceed with caution: mixed signals worth checking before investing much time.",
  suspicious: "Suspicious: a strong or repeated ghost-job or scam indicator; verify the opening before applying.",
};

/** A closed posting is not evidence of a scam; it simply can no longer be applied to, so the summary says that instead. */
const CLOSED_SUMMARY = "Closed: the posting no longer takes applications, so there is nothing to apply to.";

export function legitimacyTier(signals: readonly LegitimacySignal[]): LegitimacyTier {
  const count = (severity: LegitimacySeverity) => signals.filter((entry) => entry.severity === severity).length;
  if (count("high") > 0 || count("medium") >= 2) return "suspicious";
  if (count("medium") === 1 || count("low") >= 2) return "caution";
  return "high";
}

/** Assesses one posting from its own text plus the liveness, listing and repost context supplied. */
export function assessLegitimacy(job: Job, context: LegitimacyContext = {}): LegitimacyAssessment {
  const now = context.now ?? new Date();
  const signals = [...livenessSignals(context), ...freshnessSignals(job, now), ...paySignals(job), ...textSignals(job)];
  const tier = legitimacyTier(signals);
  const closed = signals.some((entry) => entry.id === "liveness-closed");
  return { tier, signals, summary: closed ? CLOSED_SUMMARY : TIER_SUMMARY[tier] };
}
