import type { Campaign, Track } from "../domain/campaign.js";
import type { Evidence, Job, ScoreComponent } from "../domain/job.js";
import type { Profile } from "../domain/profile.js";
import { normalizeForMatch, snippetAround } from "../text/html.js";
import { daysBetween, parseDateSafe } from "../util/hash.js";
import { checkCompensationFloor } from "./compensation.js";
import { detectSeniority } from "./gates.js";

/**
 * Evidence-based scoring.
 *
 * Every component reports the quote that earned it, so a ranking can be
 * defended and a bad match can be traced to the rule that produced it.
 */

const SKILL_LEVEL_WEIGHT: Record<string, number> = { expert: 3, strong: 2, working: 1, familiar: 0.5 };

const SPONSORSHIP_POSITIVE = [
  "visa sponsorship",
  "will sponsor",
  "we sponsor",
  "sponsorship available",
  "immigration support",
  "relocation assistance",
  "relocation support",
  "work permit support",
];

type Term = { term: string; weight: number; aliases: readonly string[] };

type TermMatch = { matchedWeight: number; totalWeight: number; evidence: Evidence[] };

function buildPattern(term: string): RegExp {
  const escaped = term.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Multi-word and symbol-bearing terms match as substrings; single words need
  // boundaries so "go" does not match "going".
  return /^[a-z0-9+#.]+$/.test(term.toLowerCase())
    ? new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i")
    : new RegExp(escaped, "i");
}

function matchTerms(haystack: string, original: string, terms: readonly Term[]): TermMatch {
  const evidence: Evidence[] = [];
  let matchedWeight = 0;
  let totalWeight = 0;

  for (const entry of terms) {
    totalWeight += entry.weight;
    const variants = [entry.term, ...entry.aliases];
    const hit = variants.find((variant) => buildPattern(variant).test(haystack));
    if (!hit) continue;
    matchedWeight += entry.weight;
    if (evidence.length < 12) {
      evidence.push({ term: entry.term, quote: snippetAround(original, hit) || hit });
    }
  }
  return { matchedWeight, totalWeight, evidence };
}

/**
 * Saturating coverage that does not depend on how many keywords a track
 * defines, so tracks with large keyword sets are not penalized against
 * narrower ones. The constants set how quickly matches saturate: with
 * DOMAIN_SATURATION at 3, six weight units of matches scores 0.67 and twelve
 * scores 0.80.
 */
const DOMAIN_SATURATION = 3;
const STACK_SATURATION = 4;

function saturatingRatio(matched: number, saturation: number): number {
  if (matched <= 0) return 0;
  return matched / (matched + saturation);
}

function trackTerms(track: Track): Term[] {
  return track.keywords.map((keyword) => ({
    term: keyword.term,
    weight: keyword.weight,
    aliases: keyword.aliases,
  }));
}

function profileTerms(profile: Profile): Term[] {
  return profile.skills.map((skill) => ({
    term: skill.name,
    weight: SKILL_LEVEL_WEIGHT[skill.level] ?? 1,
    aliases: skill.aliases,
  }));
}

function scoreRole(job: Job, track: Track, domainRatio: number): { ratio: number; evidence: Evidence[]; rationale: string } {
  const title = normalizeForMatch(job.title);
  const matches = track.titleIncludes.filter((needle) => title.includes(needle.toLowerCase()));
  if (matches.length > 0) {
    return {
      ratio: Math.min(1, 0.7 + 0.15 * matches.length),
      evidence: matches.slice(0, 4).map((term) => ({ term, quote: job.title })),
      rationale: `title matches ${matches.length} target phrase(s)`,
    };
  }
  const fallback = domainRatio >= 0.5 ? 0.35 : 0.1;
  return { ratio: fallback, evidence: [], rationale: "no target title phrase; scored from description alignment only" };
}

function scoreSeniority(job: Job): { ratio: number; rationale: string } {
  const level = detectSeniority(job.title);
  const table: Record<string, number> = {
    senior: 1,
    staff: 1,
    principal: 0.95,
    unspecified: 0.7,
    mid: 0.5,
  };
  return { ratio: table[level] ?? 0.4, rationale: `detected seniority "${level}"` };
}

function scoreCompensation(job: Job, campaign: Campaign): { ratio: number; rationale: string; flags: string[] } {
  const check = checkCompensationFloor(job.compensation, job.country, campaign.compensation);
  // Text-parsed pay is less trustworthy than structured ATS fields: postings
  // often quote several location zones in one description.
  const sourceFlags = job.compensation?.source === "description-text" ? ["compensation-parsed-from-text"] : [];
  if (check.status === "above") {
    return { ratio: 1, rationale: `published compensation clears the floor (${check.reason})`, flags: sourceFlags };
  }
  if (check.status === "below") {
    return {
      ratio: 0,
      rationale: `published compensation is below the floor (${check.reason})`,
      flags: ["compensation-below-floor", ...sourceFlags],
    };
  }
  const tierBonus = job.companyTier === "A" ? 0.6 : 0.45;
  return {
    ratio: tierBonus,
    rationale: "compensation not published; scored on company tier and flagged for verification",
    flags: ["compensation-unverified"],
  };
}

function scoreWorkAuthorization(job: Job, profile: Profile): { ratio: number; rationale: string; flags: string[] } {
  const country = job.country.toUpperCase();
  if (profile.workAuthorization.authorizedIn.map((code) => code.toUpperCase()).includes(country)) {
    return { ratio: 1, rationale: `candidate is already authorized to work in ${country}`, flags: [] };
  }
  const description = job.descriptionText.toLowerCase();
  const positive = SPONSORSHIP_POSITIVE.find((phrase) => description.includes(phrase));
  if (positive) {
    return { ratio: 0.8, rationale: `posting mentions "${positive}"`, flags: ["requires-work-authorization"] };
  }
  if (country === "UNKNOWN") {
    return { ratio: 0.5, rationale: "country could not be determined", flags: ["location-unverified"] };
  }
  return {
    ratio: 0.4,
    rationale: `employer support for work authorization in ${country} is unconfirmed`,
    flags: ["requires-work-authorization"],
  };
}

function scoreFreshness(job: Job, now: Date): { ratio: number; rationale: string } {
  const posted = parseDateSafe(job.postedAt);
  if (!posted) return { ratio: 0.5, rationale: "no posting date published" };
  const age = daysBetween(posted, now);
  const ratio = age <= 7 ? 1 : age <= 14 ? 0.85 : age <= 30 ? 0.6 : age <= 45 ? 0.4 : 0.2;
  return { ratio, rationale: `posted ${Math.round(age)} day(s) ago` };
}

export type ScoreResult = {
  trackId: string | null;
  score: number;
  tier: "A" | "B" | "C" | "none";
  components: ScoreComponent[];
  flags: string[];
};

function component(dimension: string, weight: number, ratio: number, rationale: string, evidence: Evidence[] = []): ScoreComponent {
  return { dimension, weight, earned: Math.round(weight * ratio * 100) / 100, rationale, evidence };
}

/** Scores a job against every track and keeps the best-fitting one. */
export function scoreJob(job: Job, campaign: Campaign, profile: Profile, now = new Date()): ScoreResult {
  const weights = campaign.scoring.weights;
  const haystack = normalizeForMatch(`${job.title}\n${job.descriptionText}`);
  const original = `${job.title}\n${job.descriptionText}`;

  const stack = matchTerms(haystack, original, profileTerms(profile));
  const stackRatio = saturatingRatio(stack.matchedWeight, STACK_SATURATION);

  const seniority = scoreSeniority(job);
  const compensation = scoreCompensation(job, campaign);
  const authorization = scoreWorkAuthorization(job, profile);
  const freshness = scoreFreshness(job, now);

  const scored = campaign.tracks.map((track) => {
    const domain = matchTerms(haystack, original, trackTerms(track));
    const domainRatio = saturatingRatio(domain.matchedWeight, DOMAIN_SATURATION);
    const role = scoreRole(job, track, domainRatio);
    const excluded = track.titleExcludes.some((needle) => normalizeForMatch(job.title).includes(needle.toLowerCase()));

    const components: ScoreComponent[] = [
      component("roleAlignment", weights.roleAlignment, excluded ? 0 : role.ratio, role.rationale, role.evidence),
      component("domainAlignment", weights.domainAlignment, domainRatio, `matched ${domain.evidence.length} domain keyword(s)`, domain.evidence),
      component("stackAlignment", weights.stackAlignment, stackRatio, `matched ${stack.evidence.length} profile skill(s)`, stack.evidence),
      component("seniority", weights.seniority, seniority.ratio, seniority.rationale),
      component("compensation", weights.compensation, compensation.ratio, compensation.rationale),
      component("workAuthorization", weights.workAuthorization, authorization.ratio, authorization.rationale),
      component("freshness", weights.freshness, freshness.ratio, freshness.rationale),
    ];
    const total = components.reduce((sum, item) => sum + item.earned, 0);
    return { track, components, total: Math.round(total * 10) / 10 };
  });

  const best = scored.reduce((a, b) => (b.total > a.total ? b : a));
  const thresholds = campaign.scoring.thresholds;
  const tier =
    best.total >= thresholds.tierA ? "A" : best.total >= thresholds.tierB ? "B" : best.total >= thresholds.tierC ? "C" : "none";

  return {
    trackId: best.track.id,
    score: best.total,
    tier,
    components: best.components,
    flags: [...new Set([...compensation.flags, ...authorization.flags])],
  };
}
