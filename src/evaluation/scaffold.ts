import type { Workspace } from "../config/load.js";
import { getEvaluation, getJob } from "../db/repositories/jobs.js";
import type { Evaluation, Job } from "../domain/job.js";
import { rankFacts, selectResume, type RankedFact } from "../drafting/matchReport.js";
import { matchBlacklist, type BlacklistMatch } from "../hygiene/blacklist.js";
import { assessExperience, type ExperienceAssessment } from "../hygiene/experienceYears.js";
import { legitimacyFor } from "../hygiene/postingSignals.js";
import type { LegitimacyAssessment } from "../hygiene/legitimacy.js";
import type { ListingPresence, LivenessRecord } from "../db/repositories/liveness.js";
import type { RepostCluster } from "../hygiene/reposts.js";
import { evaluateJob } from "../pipeline.js";
import { checkCompensationFloor } from "../ranking/compensation.js";
import { detectInjection } from "../text/untrusted.js";
import { AppError } from "../util/errors.js";
import { daysBetween, parseDateSafe } from "../util/hash.js";
import { detectTrack, type TrackMatch } from "./archetype.js";
import { buildEvidenceContext, evidenceFor, type RequirementEvidence } from "./evidence.js";
import { keywordCoverage, type KeywordCoverage } from "./keywords.js";
import { assessLevel, type LevelAssessment } from "./level.js";
import { extractRequirements, type RequirementItem } from "./requirements.js";
import { buildScorecard, type Scorecard } from "./scorecard.js";
import { analyzeSkillGap, type SkillGap } from "./skillGap.js";

/**
 * Everything deterministic about one posting, assembled for the agent that
 * writes the evaluation narrative. The agent adds research and prose; every
 * fact here is computed from the posting and the verified profile, and every
 * claim carries its evidence.
 */

type EvaluatedRequirement = RequirementItem & { evidence: RequirementEvidence };

type InterviewFocus = { requirementId: string; text: string; importance: RequirementItem["importance"]; evidenceTier: string; why: string };

export type EvaluationScaffold = {
  generatedAt: string;
  job: {
    id: string;
    company: string;
    title: string;
    ats: string;
    url: string;
    applyUrl: string;
    locations: string[];
    locationClass: string;
    country: string;
    workplaceType: string;
    employmentType: string;
    postedAt: string | null;
    ageDays: number | null;
    descriptionChars: number;
    injectionFlags: string[];
  };
  evaluation: Pick<Evaluation, "decision" | "score" | "tier" | "trackId" | "flags"> & { gate: Evaluation["gate"] };
  compensation: {
    published: boolean;
    raw: string;
    min: number | null;
    max: number | null;
    currency: string | null;
    period: string | null;
    source: string | null;
    floorCheck: string;
    candidateTarget: number;
    candidateMinimum: number;
    candidateCurrency: string;
  };
  liveness: (LivenessRecord & { ageHours: number }) | null;
  listing: ListingPresence;
  repost: Omit<RepostCluster, "members"> | null;
  legitimacy: LegitimacyAssessment;
  blacklist: BlacklistMatch | null;
  archetype: TrackMatch;
  experience: { requiredYears: number | null; confident: boolean; sentence: string | null; candidateYears: number; candidateBasis: string; gap: number | null; overTolerance: boolean };
  requirements: EvaluatedRequirement[];
  requirementsTruncated: number;
  responsibilities: string[];
  skillGap: SkillGap;
  keywords: KeywordCoverage;
  level: LevelAssessment;
  scorecard: Scorecard;
  interviewFocus: InterviewFocus[];
  relevantFacts: RankedFact[];
  resume: { id: string; label: string };
  /** Hook for the story bank: matched interview stories, filled by that feature. */
  stories: unknown[];
  machineSummary: Record<string, unknown>;
};

type ScaffoldOptions = { now?: Date; resumeText?: string };

const TIER_ORDER: Readonly<Record<string, number>> = { none: 0, adjacent: 1, direct: 2 };
const IMPORTANCE_ORDER: Readonly<Record<string, number>> = { required: 0, preferred: 1, bonus: 2 };

function interviewFocus(requirements: readonly EvaluatedRequirement[]): InterviewFocus[] {
  return requirements
    .filter((item) => item.importance !== "bonus" && item.evidence.tier !== "direct")
    .sort((a, b) => IMPORTANCE_ORDER[a.importance]! - IMPORTANCE_ORDER[b.importance]! || TIER_ORDER[a.evidence.tier]! - TIER_ORDER[b.evidence.tier]!)
    .slice(0, 5)
    .map((item) => ({
      requirementId: item.id,
      text: item.text,
      importance: item.importance,
      evidenceTier: item.evidence.tier,
      why:
        item.evidence.tier === "none"
          ? `${item.importance} by the posting with no profile evidence: expect it to be probed; prepare an honest answer and any adjacent example`
          : `${item.importance} by the posting with only adjacent evidence: prepare a concrete story that bridges the gap`,
    }));
}

function compensationFacts(job: Job, workspace: Workspace): EvaluationScaffold["compensation"] {
  const pay = job.compensation;
  const floor = checkCompensationFloor(pay, job.country, workspace.campaign.compensation);
  return {
    published: pay !== null && pay.max !== null,
    raw: pay?.raw ?? "not published",
    min: pay?.min ?? null,
    max: pay?.max ?? null,
    currency: pay?.currency ?? null,
    period: pay?.period ?? null,
    source: pay?.source ?? null,
    floorCheck: floor.reason,
    candidateTarget: workspace.profile.compensation.targetTotal,
    candidateMinimum: workspace.profile.compensation.minimumTotal,
    candidateCurrency: workspace.profile.compensation.currency,
  };
}

function experienceFacts(assessment: ExperienceAssessment): EvaluationScaffold["experience"] {
  return {
    requiredYears: assessment.required.minYears,
    confident: assessment.required.confident,
    sentence: assessment.required.sentence,
    candidateYears: assessment.candidate.years,
    candidateBasis: assessment.candidate.detail,
    gap: assessment.gap,
    overTolerance: assessment.overTolerance,
  };
}

/** Builds the deterministic scaffold for a stored posting. Reads only the database; no network. */
export function buildEvaluationScaffold(workspace: Workspace, jobId: string, options: ScaffoldOptions = {}): EvaluationScaffold {
  const job = getJob(workspace.db, jobId);
  if (!job) throw new AppError("job_not_found", `no job stored with id ${jobId}`);
  const now = options.now ?? new Date();
  const { campaign, profile } = workspace;

  // Re-evaluated against the current configuration, so a report never quotes
  // a gate or score the campaign has since changed.
  const fresh = evaluateJob(job, campaign, profile, now);
  const stored = getEvaluation(workspace.db, job.id);
  const evaluation: Evaluation = { ...fresh, flags: [...new Set([...fresh.flags, ...(stored?.flags ?? []).filter((flag) => flag.startsWith("duplicate-role"))])] };

  const experience = assessExperience(job, campaign, profile, now);
  const parsed = extractRequirements(job.descriptionText);
  const evidenceContext = buildEvidenceContext(profile, job, {
    candidateYears: experience.candidate.years,
    toleranceYears: experience.toleranceYears,
  });
  const requirements: EvaluatedRequirement[] = parsed.items.map((item) => ({ ...item, evidence: evidenceFor(item, evidenceContext) }));
  const legitimacy = legitimacyFor(workspace, job, now);
  const track = detectTrack(job, campaign);
  const level = assessLevel(job, campaign, experience);
  const scorecard = buildScorecard({
    job,
    evaluation,
    campaign,
    profile,
    requirements: requirements.map((item) => ({ importance: item.importance, weightSource: item.weightSource, tier: item.evidence.tier, text: item.text })),
    track,
    legitimacy,
    liveness: legitimacy.liveness,
    experience,
  });
  const skillGap = analyzeSkillGap(job.descriptionText, parsed.items, profile, job.companyName);
  const keywords = keywordCoverage({
    title: job.title,
    jdText: job.descriptionText,
    requirements: parsed.items,
    responsibilities: parsed.responsibilities,
    profile,
    campaign,
    companyName: job.companyName,
    ...(options.resumeText ? { resumeText: options.resumeText } : {}),
  });
  const posted = parseDateSafe(job.postedAt);
  const livenessRecord = legitimacy.liveness;
  const resume = selectResume(profile, evaluation.trackId ?? track.trackId);
  const { liveness: _liveness, listing, repost, ...legitimacyOnly } = legitimacy;
  const required = requirements.filter((item) => item.importance === "required");

  return {
    generatedAt: now.toISOString(),
    job: {
      id: job.id,
      company: job.companyName,
      title: job.title,
      ats: job.ats,
      url: job.url,
      applyUrl: job.applyUrl,
      locations: job.locationsRaw,
      locationClass: job.locationClass,
      country: job.country,
      workplaceType: job.workplaceType,
      employmentType: job.employmentType,
      postedAt: job.postedAt,
      ageDays: posted ? Math.round(daysBetween(posted, now)) : null,
      descriptionChars: job.descriptionText.length,
      injectionFlags: detectInjection(job.descriptionText).map((flag) => flag.pattern),
    },
    evaluation: {
      decision: evaluation.decision,
      score: evaluation.score,
      tier: evaluation.tier,
      trackId: evaluation.trackId,
      flags: evaluation.flags,
      gate: evaluation.gate,
    },
    compensation: compensationFacts(job, workspace),
    liveness: livenessRecord
      ? { ...livenessRecord, ageHours: Math.round(((now.getTime() - Date.parse(livenessRecord.checkedAt)) / 3_600_000) * 10) / 10 }
      : null,
    listing,
    repost: repost ? (({ members: _members, ...rest }) => rest)(repost) : null,
    legitimacy: legitimacyOnly,
    blacklist: matchBlacklist(job, campaign.hygiene.blacklist),
    archetype: track,
    experience: experienceFacts(experience),
    requirements,
    requirementsTruncated: parsed.truncated,
    responsibilities: parsed.responsibilities,
    skillGap,
    keywords,
    level,
    scorecard,
    interviewFocus: interviewFocus(requirements),
    relevantFacts: rankFacts(profile.facts, job, 6),
    resume: { id: resume.id, label: resume.label },
    stories: [],
    machineSummary: {
      jobId: job.id,
      company: job.companyName,
      title: job.title,
      score: scorecard.globalScore,
      verdict: scorecard.verdict,
      confidence: scorecard.confidence,
      campaignScore: evaluation.score,
      decision: evaluation.decision,
      archetype: track.target ? track.label : null,
      legitimacy: legitimacy.tier,
      liveness: livenessRecord?.status ?? "unchecked",
      requiredDirect: `${required.filter((item) => item.evidence.tier === "direct").length}/${required.length}`,
      requiredGaps: required.filter((item) => item.evidence.tier === "none").map((item) => item.text.slice(0, 100)).slice(0, 3),
      skillGaps: skillGap.gap.map((entry) => entry.term).slice(0, 8),
      keywordCoverage: keywords.coveragePercent,
      yearsRequired: experience.required.minYears,
      candidateYears: experience.candidate.years,
      level: level.fit,
      compensation: scorecard.dimensions.find((dimension) => dimension.dimension === "compensation")?.status ?? "unknown",
      blacklisted: matchBlacklist(job, campaign.hygiene.blacklist) !== null,
    },
  };
}
