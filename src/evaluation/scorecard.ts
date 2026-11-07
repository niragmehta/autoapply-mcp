import type { Campaign } from "../domain/campaign.js";
import type { Evaluation, Job } from "../domain/job.js";
import type { Profile } from "../domain/profile.js";
import type { ExperienceAssessment } from "../hygiene/experienceYears.js";
import type { LegitimacyAssessment } from "../hygiene/legitimacy.js";
import { checkCompensationFloor, convertCurrency } from "../ranking/compensation.js";
import type { PostingCheck } from "../sources/types.js";
import type { TrackMatch } from "./archetype.js";
import type { EvidenceTier } from "./evidence.js";
import type { Importance, WeightSource } from "./requirements.js";

/**
 * A 1-5 score with per-dimension evidence, after career-ops' scoring system
 * (MIT).
 *
 * The base comes from the campaign's 0-100 score, mapped so the campaign's
 * own tier thresholds land on the verdict bands:
 *
 *   score >= tierA          -> 4.5-5.0  strong match, apply
 *   tierB <= score < tierA  -> 4.0-4.4  apply
 *   tierC <= score < tierB  -> 3.5-3.9  only with a specific reason
 *   score < tierC           -> 1.0-3.4  do not apply
 *
 * (linear within each band; a gate rejection scores 0 and maps to 1.0). The
 * dimensions then adjust it: requirement coverage moves it by up to +/-0.5,
 * pay under the candidate's minimum costs 0.3, red flags cost up to 0.5, and
 * a role that matches no target track, or a suspicious posting, is capped
 * below the 3.5 line. Culture cannot be read from a posting, so it is always
 * unknown here; the agent researches it.
 */

type DimensionStatus = "supported" | "partial" | "unknown";

type ScoreDimension = {
  dimension: "cvMatch" | "northStar" | "compensation" | "redFlags" | "culture";
  label: string;
  /** 1-5, or null when nothing decision-relevant is known. */
  score: number | null;
  status: DimensionStatus;
  evidence: string[];
  question?: string;
};

export type Verdict = "strong-apply" | "apply" | "apply-with-reason" | "do-not-apply";

export const VERDICT_LABELS: Readonly<Record<Verdict, string>> = {
  "strong-apply": "Strong match - apply",
  apply: "Apply",
  "apply-with-reason": "Only with a specific reason",
  "do-not-apply": "Do not apply",
};

export type Scorecard = {
  globalScore: number;
  baseScore: number;
  score100: number;
  verdict: Verdict;
  verdictLabel: string;
  dimensions: ScoreDimension[];
  confidence: "high" | "medium" | "low";
  confidenceReason: string;
  adjustments: string[];
  verificationPriorities: string[];
};

type ScoredRequirement = { importance: Importance; weightSource: WeightSource; tier: EvidenceTier; text: string };

export type ScorecardInput = {
  job: Job;
  evaluation: Evaluation | null;
  campaign: Campaign;
  profile: Profile;
  requirements: readonly ScoredRequirement[];
  track: TrackMatch;
  legitimacy: LegitimacyAssessment;
  liveness: PostingCheck | null;
  experience: ExperienceAssessment;
};

export function verdictFor(score: number): Verdict {
  if (score >= 4.5) return "strong-apply";
  if (score >= 4.0) return "apply";
  if (score >= 3.5) return "apply-with-reason";
  return "do-not-apply";
}

/** Rounds down to one decimal, so a score never crosses into a better band by rounding. */
function floor1(value: number): number {
  return Math.floor(value * 10 + 1e-9) / 10;
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

function clamp(value: number, low: number, high: number): number {
  return Math.min(high, Math.max(low, value));
}

/** Maps the campaign's 0-100 score onto 1-5 so its tier thresholds meet the verdict bands. */
export function scoreToFive(score: number, thresholds: { tierA: number; tierB: number; tierC: number }): number {
  const { tierA, tierB, tierC } = thresholds;
  const span = (high: number, low: number) => Math.max(1, high - low);
  if (score >= tierA) return clamp(4.5 + (0.5 * (score - tierA)) / span(100, tierA), 4.5, 5);
  if (score >= tierB) return 4.0 + (0.5 * (score - tierB)) / span(tierA, tierB);
  if (score >= tierC) return 3.5 + (0.5 * (score - tierC)) / span(tierB, tierC);
  return 1.0 + (2.5 * clamp(score, 0, tierC)) / span(tierC, 0);
}

const IMPORTANCE_WEIGHT: Readonly<Record<Importance, number>> = { required: 3, preferred: 1.5, bonus: 0.75 };
const CREDIT: Readonly<Record<EvidenceTier, number>> = { direct: 1, adjacent: 0.5, none: 0 };

function cvMatch(requirements: readonly ScoredRequirement[]): ScoreDimension {
  if (requirements.length === 0) {
    return { dimension: "cvMatch", label: "CV match", score: null, status: "unknown", evidence: ["no requirement items could be read from the posting"], question: "Read the posting's requirements and judge the match by hand." };
  }
  let total = 0;
  let earned = 0;
  for (const item of requirements) {
    const weight = IMPORTANCE_WEIGHT[item.importance] * (item.weightSource === "estimate" ? 0.5 : 1);
    total += weight;
    earned += weight * CREDIT[item.tier];
  }
  const coverage = total > 0 ? earned / total : 0;
  const required = requirements.filter((item) => item.importance === "required");
  const direct = required.filter((item) => item.tier === "direct").length;
  const missing = required.filter((item) => item.tier === "none");
  const grounded = requirements.filter((item) => item.weightSource !== "estimate").length;
  return {
    dimension: "cvMatch",
    label: "CV match",
    score: round1(1 + 4 * coverage),
    status: grounded >= 3 ? "supported" : "partial",
    evidence: [
      `${Math.round(coverage * 100)}% of requirement weight is evidenced by the profile`,
      `${direct} of ${required.length} required item(s) have direct evidence`,
      ...missing.slice(0, 3).map((item) => `no evidence for required: "${item.text.slice(0, 120)}"`),
    ],
    ...(grounded < 3 ? { question: "The posting states few requirements explicitly; confirm the real bar with the recruiter." } : {}),
  };
}

function northStar(track: TrackMatch): ScoreDimension {
  return {
    dimension: "northStar",
    label: "North Star (target role)",
    score: track.northStar,
    status: track.target || track.northStar === 1 ? "supported" : "partial",
    evidence: [`${track.label}: ${track.reason}`],
  };
}

function compensation(job: Job, campaign: Campaign, profile: Profile): ScoreDimension {
  const label = "Compensation";
  const pay = job.compensation;
  const floor = checkCompensationFloor(pay, job.country, campaign.compensation);
  if (!pay || pay.max === null || floor.annualizedMax === null) {
    return { dimension: "compensation", label, score: null, status: "unknown", evidence: [floor.reason], question: "Research the pay band for this role and level, and cite the sources." };
  }
  const top = convertCurrency(floor.annualizedMax, pay.currency, profile.compensation.currency, campaign.compensation.fx);
  if (top === null) {
    return { dimension: "compensation", label, score: null, status: "unknown", evidence: [`no FX rate for ${pay.currency}->${profile.compensation.currency}`] };
  }
  const { targetTotal, minimumTotal, currency } = profile.compensation;
  const score =
    top >= targetTotal
      ? 5
      : top >= minimumTotal
        ? round1(3 + (2 * (top - minimumTotal)) / Math.max(1, targetTotal - minimumTotal))
        : floor.status === "above"
          ? 2
          : 1;
  return {
    dimension: "compensation",
    label,
    score,
    status: pay.source === "ats-structured" ? "supported" : "partial",
    evidence: [
      `published top of range ${Math.round(top).toLocaleString()} ${currency}/year vs target ${targetTotal.toLocaleString()} and minimum ${minimumTotal.toLocaleString()}`,
      `campaign floor check: ${floor.reason}`,
      `published as: ${pay.raw}`,
    ],
    ...(pay.source === "ats-structured" ? {} : { question: "The range was read from prose; confirm it is base pay for this location." }),
  };
}

function redFlags(input: ScorecardInput): ScoreDimension {
  const evidence: string[] = [];
  let score = 5;
  const gate = input.evaluation?.gate;
  if (gate && !gate.passed) {
    evidence.push(`campaign gate "${gate.rule}": ${gate.reason}`);
    score = 1;
  }
  if (input.liveness?.status === "closed") {
    evidence.push(`posting closed: ${input.liveness.detail}`);
    score = 1;
  }
  if (input.legitimacy.tier === "suspicious") score -= 2;
  if (input.legitimacy.tier === "caution") score -= 1;
  for (const entry of input.legitimacy.signals.filter((item) => item.severity === "medium" || item.severity === "high")) {
    evidence.push(`${entry.id}: ${entry.observation}`);
  }
  const flags = input.evaluation?.flags ?? [];
  if (flags.some((flag) => flag.startsWith("injection:"))) {
    score -= 0.5;
    evidence.push("the description contains instructions aimed at AI tools");
  }
  if (input.experience.overTolerance) {
    score -= 1;
    evidence.push(`asks for ${input.experience.required.minYears}+ years; the candidate has ${input.experience.candidate.years}`);
  }
  if (flags.includes("requires-work-authorization")) {
    score -= 0.5;
    evidence.push("the role needs employer support for work authorization");
  }
  const checked = input.liveness !== null && input.liveness.status !== "unknown";
  return {
    dimension: "redFlags",
    label: "Red flags",
    score: round1(clamp(score, 1, 5)),
    status: checked ? "supported" : "partial",
    evidence: evidence.length > 0 ? evidence : ["no blockers or warnings found by the deterministic checks"],
    ...(checked ? {} : { question: "Confirm the posting is still open (check_liveness)." }),
  };
}

const CULTURE: ScoreDimension = {
  dimension: "culture",
  label: "Culture",
  score: null,
  status: "unknown",
  evidence: ["not readable from the posting alone"],
  question: "Research the team, company stability and interview process with your own tools; cite sources.",
};

function confidenceOf(dimensions: readonly ScoreDimension[], job: Job): { confidence: Scorecard["confidence"]; reason: string } {
  const byName = new Map(dimensions.map((dimension) => [dimension.dimension, dimension]));
  const unknown = dimensions.filter((dimension) => dimension.status === "unknown");
  if ((job.descriptionText ?? "").trim().length < 500) return { confidence: "low", reason: "the posting text is too short to assess" };
  if (byName.get("cvMatch")?.status === "unknown") return { confidence: "low", reason: "CV match could not be established" };
  if (unknown.length >= 2) return { confidence: "low", reason: `${unknown.map((dimension) => dimension.label).join(" and ")} unknown` };
  if (dimensions.some((dimension) => dimension.status !== "supported")) {
    return { confidence: "medium", reason: `${dimensions.filter((dimension) => dimension.status !== "supported").map((dimension) => dimension.label).join(", ")} not fully supported` };
  }
  return { confidence: "high", reason: "every dimension is supported by current evidence" };
}

export function buildScorecard(input: ScorecardInput): Scorecard {
  const thresholds = input.campaign.scoring.thresholds;
  const score100 = input.evaluation?.score ?? 0;
  const rejected = input.evaluation !== null && input.evaluation.decision === "reject";
  const base = rejected ? 1 : scoreToFive(score100, thresholds);
  const dimensions = [
    cvMatch(input.requirements),
    northStar(input.track),
    compensation(input.job, input.campaign, input.profile),
    redFlags(input),
    CULTURE,
  ];
  const get = (name: ScoreDimension["dimension"]) => dimensions.find((dimension) => dimension.dimension === name)!;
  const adjustments = [`base ${floor1(base)} from the campaign score ${score100} (tiers A ${thresholds.tierA}, B ${thresholds.tierB}, C ${thresholds.tierC})`];

  let global = base;
  const cv = get("cvMatch");
  if (cv.score !== null) {
    const delta = (cv.score - 3) * 0.25;
    global += delta;
    adjustments.push(`CV match ${cv.score}: ${delta >= 0 ? "+" : ""}${delta.toFixed(2)}`);
  }
  const pay = get("compensation");
  if (pay.score !== null && pay.score <= 2) {
    global -= 0.3;
    adjustments.push("published pay is under the candidate's minimum: -0.3");
  }
  const flags = get("redFlags");
  if (flags.score !== null && flags.score <= 2) {
    global -= 0.5;
    adjustments.push(`red flags ${flags.score}: -0.5`);
  }
  if (input.track.northStar === 1) {
    global = Math.min(global, 3.4);
    adjustments.push("matches no target track: capped at 3.4");
  }
  if (input.legitimacy.tier === "suspicious") {
    global = Math.min(global, 3.4);
    adjustments.push("posting legitimacy is suspicious: capped at 3.4");
  }
  if (input.liveness?.status === "closed" || rejected) {
    global = 1;
    adjustments.push(rejected ? "rejected by a campaign gate: 1.0" : "posting is closed: 1.0");
  }

  const globalScore = floor1(clamp(global, 1, 5));
  const verdict = verdictFor(globalScore);
  const { confidence, reason } = confidenceOf(dimensions, input.job);
  const priorities = dimensions
    .filter((dimension) => dimension.question)
    .map((dimension) => `${dimension.label}: ${dimension.question}`)
    .slice(0, 3);

  return {
    globalScore,
    baseScore: floor1(base),
    score100,
    verdict,
    verdictLabel: VERDICT_LABELS[verdict],
    dimensions,
    confidence,
    confidenceReason: reason,
    adjustments,
    verificationPriorities: priorities,
  };
}
