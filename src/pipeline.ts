import type { Campaign } from "./domain/campaign.js";
import type { Evaluation, Job } from "./domain/job.js";
import type { Profile } from "./domain/profile.js";
import { evaluateGates } from "./ranking/gates.js";
import { scoreJob } from "./ranking/score.js";
import { detectInjection } from "./text/untrusted.js";
import { nowIso } from "./util/hash.js";
import type { Db } from "./db/database.js";
import { findDuplicates, saveEvaluation } from "./db/repositories/jobs.js";

/**
 * Evaluation pipeline: gates first, then scoring, then persistence.
 * Kept separate from the tool layer so it can be tested without MCP.
 */

export function evaluateJob(job: Job, campaign: Campaign, profile: Profile, now = new Date()): Evaluation {
  const gate = evaluateGates(job, { campaign, profile, now });
  const injectionFlags = detectInjection(job.descriptionText).map((flag) => `injection:${flag.pattern}`);

  if (!gate.passed) {
    return {
      jobId: job.id,
      decision: "reject",
      gate,
      trackId: null,
      score: 0,
      tier: "none",
      components: [],
      flags: injectionFlags,
      evaluatedAt: nowIso(),
    };
  }

  const scored = scoreJob(job, campaign, profile, now);
  return {
    jobId: job.id,
    decision: scored.tier === "none" ? "review" : "accept",
    gate,
    trackId: scored.trackId,
    score: scored.score,
    tier: scored.tier,
    components: scored.components,
    flags: [...scored.flags, ...injectionFlags],
    evaluatedAt: nowIso(),
  };
}

export type PipelineSummary = {
  evaluated: number;
  accepted: number;
  review: number;
  rejected: number;
  duplicates: number;
  topRejectionRules: Array<{ rule: string; count: number }>;
};

/** Evaluates and stores a batch of jobs, flagging repeats of the same role. */
export function evaluateAndStore(
  db: Db,
  jobs: readonly Job[],
  campaign: Campaign,
  profile: Profile,
  now = new Date(),
): PipelineSummary {
  const ruleCounts = new Map<string, number>();
  let accepted = 0;
  let review = 0;
  let rejected = 0;
  let duplicates = 0;

  for (const job of jobs) {
    const evaluation = evaluateJob(job, campaign, profile, now);
    const dupes = findDuplicates(db, job.fingerprint, job.id);
    if (dupes.length > 0) {
      duplicates += 1;
      evaluation.flags = [...evaluation.flags, `duplicate-role:${dupes.length}`];
    }
    saveEvaluation(db, evaluation);

    if (evaluation.decision === "accept") accepted += 1;
    else if (evaluation.decision === "review") review += 1;
    else {
      rejected += 1;
      const rule = evaluation.gate.rule ?? "unknown";
      ruleCounts.set(rule, (ruleCounts.get(rule) ?? 0) + 1);
    }
  }

  const topRejectionRules = [...ruleCounts.entries()]
    .map(([rule, count]) => ({ rule, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  return { evaluated: jobs.length, accepted, review, rejected, duplicates, topRejectionRules };
}

/** Adds up the summaries of jobs evaluated in separate batches, such as one per board. */
export function mergeSummaries(summaries: readonly PipelineSummary[]): PipelineSummary {
  const ruleCounts = new Map<string, number>();
  for (const summary of summaries) {
    for (const { rule, count } of summary.topRejectionRules) ruleCounts.set(rule, (ruleCounts.get(rule) ?? 0) + count);
  }
  const total = (pick: (summary: PipelineSummary) => number): number => summaries.reduce((sum, summary) => sum + pick(summary), 0);
  return {
    evaluated: total((summary) => summary.evaluated),
    accepted: total((summary) => summary.accepted),
    review: total((summary) => summary.review),
    rejected: total((summary) => summary.rejected),
    duplicates: total((summary) => summary.duplicates),
    topRejectionRules: [...ruleCounts.entries()]
      .map(([rule, count]) => ({ rule, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 10),
  };
}
