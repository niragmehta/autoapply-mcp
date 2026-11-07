import type { Workspace } from "../config/load.js";
import { AppError } from "../util/errors.js";
import { calibrate, type Calibration } from "./calibration.js";
import { loadApplicationRows, submittedCohort } from "./dataset.js";
import { computeFunnel, conversionBreakdowns, type Dimension, type Funnel, type GroupStats } from "./funnel.js";
import { discardAnalytics, rejectionPatterns, type DiscardAnalytics, type RejectionPatterns } from "./patterns.js";
import { skillGaps, type SkillGapReport } from "./skillGaps.js";
import { responseTimes, velocity, type ResponseTimes, type Velocity } from "./timing.js";

/**
 * The after-apply picture in one call: the funnel, conversion by every
 * campaign lever, how fast replies come, where applications are lost, whether
 * the score predicts outcomes, and which skills target postings keep asking
 * for. Read-only.
 */

type CampaignAnalytics = {
  generatedAt: string;
  since: string | null;
  notes: string[];
  funnel: Funnel;
  conversion: Record<Dimension, GroupStats[]>;
  responseTimes: ResponseTimes;
  velocity: Velocity;
  rejectionPatterns: RejectionPatterns;
  calibration: Calibration;
  skillGaps: SkillGapReport;
  discards: DiscardAnalytics;
};

type AnalyticsOptions = {
  /** ISO date or timestamp; only activity on or after it is counted. */
  since?: string;
  now?: Date;
  maxSkillPostings?: number;
};

export function normalizeSince(since: string | undefined): string | null {
  if (since === undefined || since.trim() === "") return null;
  const trimmed = since.trim();
  const parsed = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? `${trimmed}T00:00:00Z` : trimmed);
  if (!Number.isFinite(parsed)) throw new AppError("invalid_since", `since must be a date such as 2026-10-01 (got "${trimmed.slice(0, 40)}")`);
  return new Date(parsed).toISOString();
}

export function campaignAnalytics(workspace: Workspace, options: AnalyticsOptions = {}): CampaignAnalytics {
  const since = normalizeSince(options.since);
  const now = options.now ?? new Date();
  const ghostAfterDays = workspace.campaign.followUps.ghostAfterDays;
  const rows = loadApplicationRows(workspace.db);
  const cohort = submittedCohort(rows, since);
  const conversion = conversionBreakdowns(cohort, now, ghostAfterDays);
  const withReplies = cohort.filter((row) => row.outcomes.responded || row.outcomes.terminal !== null).length;
  const discards = discardAnalytics(workspace.db, since, now);
  const notes = [
    "Every rate is {n, count, rate} with rate = count / n. A rate over a handful of applications is an anecdote, not a pattern.",
    "Stages are cumulative: an application rejected after an interview counts as having reached the interview.",
    "replied = any reply beyond an automatic acknowledgement, rejections included; advanced = reached a screen, assessment or later.",
    "Tier, track and score are each posting's current evaluation, which changes if the campaign is re-scored.",
    `${withReplies} of ${cohort.length} submitted applications have any recorded outcome. Rates undercount until replies are recorded (scan_inbox, classify_reply, record_outcome).`,
  ];
  return {
    generatedAt: now.toISOString(),
    since,
    notes,
    funnel: computeFunnel(workspace.db, rows, cohort, { since, now, ghostAfterDays }),
    conversion,
    responseTimes: responseTimes(cohort),
    velocity: velocity(cohort, now),
    rejectionPatterns: rejectionPatterns(cohort, conversion, discards),
    calibration: calibrate(cohort, now, ghostAfterDays),
    skillGaps: skillGaps(workspace.db, workspace.profile, { since, now, maxPostings: options.maxSkillPostings }),
    discards,
  };
}
