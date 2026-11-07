import type { Db } from "../db/database.js";
import { progressRank, type ProgressOutcome } from "../domain/policies/followup.js";
import { isInFlight, type ApplicationRow } from "./dataset.js";
import { isoWeek, rate, scoreBand, SCORE_BANDS, type Rate } from "./stats.js";

/**
 * The campaign funnel, and conversion through it sliced by every dimension a
 * campaign can change: tier, track, ATS channel, company tier, score band,
 * location, submission mode and week.
 *
 * Stages are cumulative ("ever reached"), so each stage's count includes
 * everything that went further, and a rejection after an interview still
 * counts as an interview.
 */

type FunnelStage = { stage: string; count: number; fromPrevious: Rate | null; fromSubmitted: Rate | null };

export type Funnel = {
  discovered: number;
  evaluated: number;
  accepted: { total: number; byTier: Record<string, number> };
  prepared: number;
  approved: number;
  submitted: number;
  acknowledged: number;
  /** Any reply beyond an automatic acknowledgement, rejections included. */
  replied: number;
  screenOrAssessment: number;
  interview: number;
  offer: number;
  rejected: number;
  ghosted: number;
  withdrawn: number;
  inFlight: number;
  stages: FunnelStage[];
};

type Row = Record<string, unknown>;

function count(db: Db, table: "jobs" | "evaluations", column: string, since: string | null): number {
  // Without a cutoff, COUNT(*) is answered from an index; a WHERE on an unindexed
  // column would walk every row, and job rows carry whole descriptions.
  const row = since
    ? (db.prepare(`SELECT COUNT(*) AS total FROM ${table} WHERE ${column} >= ?`).get(since) as Row | undefined)
    : (db.prepare(`SELECT COUNT(*) AS total FROM ${table}`).get() as Row | undefined);
  return Number(row?.total ?? 0);
}

const reached = (row: ApplicationRow, kind: ProgressOutcome): boolean => row.outcomes.furthestRank >= progressRank(kind);

export function computeFunnel(
  db: Db,
  rows: readonly ApplicationRow[],
  cohort: readonly ApplicationRow[],
  options: { since: string | null; now: Date; ghostAfterDays: number },
): Funnel {
  const { since } = options;
  const discovered = count(db, "jobs", "first_seen_at", since);
  const evaluated = count(db, "evaluations", "evaluated_at", since);
  const tiers = db
    .prepare(
      `SELECT tier, COUNT(*) AS total FROM evaluations
       WHERE decision = 'accept' AND (? IS NULL OR evaluated_at >= ?) GROUP BY tier ORDER BY tier`,
    )
    .all(since, since) as Row[];
  const byTier = Object.fromEntries(tiers.map((row) => [String(row.tier), Number(row.total ?? 0)]));
  const accepted = Object.values(byTier).reduce((sum, value) => sum + value, 0);
  const prepared = rows.filter((row) => !since || row.createdAt >= since);
  const approved = prepared.filter((row) => row.approvedAt !== null || row.status === "approved" || row.status === "submitted");
  const submitted = cohort.length;
  const acknowledged = cohort.filter((row) => reached(row, "acknowledged")).length;
  const screenOrAssessment = cohort.filter((row) => reached(row, "recruiter_screen")).length;
  const interview = cohort.filter((row) => reached(row, "interview")).length;
  const offer = cohort.filter((row) => reached(row, "offer")).length;

  const chain: Array<[string, number]> = [
    ["discovered", discovered],
    ["accepted", accepted],
    ["prepared", prepared.length],
    ["approved", approved.length],
    ["submitted", submitted],
    ["acknowledged", acknowledged],
    ["screen_or_assessment", screenOrAssessment],
    ["interview", interview],
    ["offer", offer],
  ];
  const submittedIndex = chain.findIndex(([stage]) => stage === "submitted");
  const stages = chain.map(([stage, value], index) => ({
    stage,
    count: value,
    fromPrevious: index === 0 ? null : rate(value, chain[index - 1]![1]),
    fromSubmitted: index > submittedIndex ? rate(value, submitted) : null,
  }));

  return {
    discovered,
    evaluated,
    accepted: { total: accepted, byTier },
    prepared: prepared.length,
    approved: approved.length,
    submitted,
    acknowledged,
    replied: cohort.filter((row) => row.outcomes.respondedBeyondAcknowledgement).length,
    screenOrAssessment,
    interview,
    offer,
    rejected: cohort.filter((row) => row.outcomes.reached.has("rejected")).length,
    ghosted: cohort.filter((row) => row.outcomes.terminal === "ghosted").length,
    withdrawn: cohort.filter((row) => row.outcomes.reached.has("withdrawn")).length,
    inFlight: cohort.filter((row) => isInFlight(row, options.now, options.ghostAfterDays)).length,
    stages,
  };
}

export type GroupStats = {
  key: string;
  submitted: number;
  replied: Rate;
  advanced: Rate;
  interviewed: Rate;
  offered: Rate;
  rejected: Rate;
  /** Submitted recently and not yet heard from: not a failure yet. */
  inFlight: number;
};

const DIMENSIONS = {
  tier: (row: ApplicationRow) => row.tier,
  track: (row: ApplicationRow) => row.trackId,
  ats: (row: ApplicationRow) => row.ats,
  companyTier: (row: ApplicationRow) => row.companyTier,
  scoreBand: (row: ApplicationRow) => scoreBand(row.score),
  locationClass: (row: ApplicationRow) => row.locationClass,
  submissionMode: (row: ApplicationRow) => row.submissionMode,
  weekSubmitted: (row: ApplicationRow) => (row.submittedAt ? isoWeek(row.submittedAt) : "unknown"),
} as const;

export type Dimension = keyof typeof DIMENSIONS;

function groupStats(key: string, rows: readonly ApplicationRow[], now: Date, ghostAfterDays: number): GroupStats {
  const n = rows.length;
  return {
    key,
    submitted: n,
    replied: rate(rows.filter((row) => row.outcomes.respondedBeyondAcknowledgement).length, n),
    advanced: rate(rows.filter((row) => reached(row, "recruiter_screen")).length, n),
    interviewed: rate(rows.filter((row) => reached(row, "interview")).length, n),
    offered: rate(rows.filter((row) => reached(row, "offer")).length, n),
    rejected: rate(rows.filter((row) => row.outcomes.reached.has("rejected")).length, n),
    inFlight: rows.filter((row) => isInFlight(row, now, ghostAfterDays)).length,
  };
}

function orderGroups(dimension: Dimension, groups: GroupStats[]): GroupStats[] {
  if (dimension === "weekSubmitted") return groups.sort((a, b) => a.key.localeCompare(b.key));
  if (dimension === "scoreBand") {
    const order: readonly string[] = [...SCORE_BANDS, "unscored"];
    return groups.sort((a, b) => order.indexOf(a.key) - order.indexOf(b.key));
  }
  return groups.sort((a, b) => b.submitted - a.submitted || a.key.localeCompare(b.key));
}

function conversionBy(
  dimension: Dimension,
  cohort: readonly ApplicationRow[],
  now: Date,
  ghostAfterDays: number,
): GroupStats[] {
  const keyOf = DIMENSIONS[dimension];
  const grouped = new Map<string, ApplicationRow[]>();
  for (const row of cohort) {
    const key = keyOf(row);
    grouped.set(key, [...(grouped.get(key) ?? []), row]);
  }
  return orderGroups(
    dimension,
    [...grouped].map(([key, rows]) => groupStats(key, rows, now, ghostAfterDays)),
  );
}

export function conversionBreakdowns(
  cohort: readonly ApplicationRow[],
  now: Date,
  ghostAfterDays: number,
): Record<Dimension, GroupStats[]> {
  const dimensions = Object.keys(DIMENSIONS) as Dimension[];
  return Object.fromEntries(dimensions.map((dimension) => [dimension, conversionBy(dimension, cohort, now, ghostAfterDays)])) as Record<
    Dimension,
    GroupStats[]
  >;
}
