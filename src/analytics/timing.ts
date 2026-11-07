import { REPLY_OUTCOMES } from "../followup/stages.js";
import type { ApplicationRow } from "./dataset.js";
import { DAY_MS, daysBetween, distribution, isoWeek, round, type Distribution } from "./stats.js";

/**
 * How fast employers answer and how fast the campaign moves.
 *
 * Times run from submission to the first reply of each kind, dated by the
 * email itself when the reply came through the inbox and by when it was
 * recorded otherwise. Applications still waiting are not in these medians:
 * they are reported as in flight elsewhere, not counted as fast or slow.
 */

type KindTiming = Distribution & { kind: string; excluded: number };

export type ResponseTimes = { firstReply: KindTiming; byKind: KindTiming[] };

function timing(kind: string, values: readonly number[]): KindTiming {
  const valid = values.filter((value) => value >= 0);
  return { kind, ...distribution(valid), excluded: values.length - valid.length };
}

function firstReplyTime(row: ApplicationRow): string | null {
  const times = Object.values(row.firstReplyAt).filter((value): value is string => typeof value === "string");
  return times.length > 0 ? times.sort()[0]! : null;
}

export function responseTimes(cohort: readonly ApplicationRow[]): ResponseTimes {
  const byKind = REPLY_OUTCOMES.map((kind) =>
    timing(
      kind,
      cohort.flatMap((row) => {
        const at = row.firstReplyAt[kind];
        return at && row.submittedAt ? [daysBetween(row.submittedAt, at)] : [];
      }),
    ),
  ).filter((entry) => entry.n > 0 || entry.excluded > 0);
  const first = cohort.flatMap((row) => {
    const at = firstReplyTime(row);
    return at && row.submittedAt ? [daysBetween(row.submittedAt, at)] : [];
  });
  return { firstReply: timing("any reply", first), byKind };
}

type StageHop = Distribution & { from: string; to: string; excluded: number };

export type Velocity = {
  weeks: Array<{ week: string; submitted: number; firstReplies: number }>;
  submittedLast7Days: number;
  submittedLast30Days: number;
  averageSubmittedPerWeek: { weeks: number; value: number };
  stageHops: StageHop[];
};

function earliestOf(row: ApplicationRow, kinds: readonly string[]): string | null {
  const times = kinds.map((kind) => row.firstReplyAt[kind]).filter((value): value is string => typeof value === "string");
  return times.length > 0 ? times.sort()[0]! : null;
}

/**
 * Days between two stages. A zero-length hop is a catch-up entry (two stages
 * recorded together), not a same-day process, and is excluded from the median.
 */
function hop(cohort: readonly ApplicationRow[], from: string, fromKinds: readonly string[] | "submitted", to: string, toKinds: readonly string[]): StageHop {
  const values = cohort.flatMap((row) => {
    const start = fromKinds === "submitted" ? row.submittedAt : earliestOf(row, fromKinds);
    const end = earliestOf(row, toKinds);
    return start && end ? [daysBetween(start, end)] : [];
  });
  const valid = values.filter((value) => value > 0);
  return { from, to, ...distribution(valid), excluded: values.length - valid.length };
}

const WEEKS_SHOWN = 12;

export function velocity(cohort: readonly ApplicationRow[], now: Date): Velocity {
  const weekKeys = Array.from({ length: WEEKS_SHOWN }, (_unused, index) => isoWeek(new Date(now.getTime() - (WEEKS_SHOWN - 1 - index) * 7 * DAY_MS)));
  const uniqueWeeks = [...new Set(weekKeys)];
  const submittedWeeks = cohort.map((row) => (row.submittedAt ? isoWeek(row.submittedAt) : ""));
  const replyWeeks = cohort.map((row) => {
    const at = firstReplyTime(row);
    return at ? isoWeek(at) : "";
  });
  const weeks = uniqueWeeks.map((week) => ({
    week,
    submitted: submittedWeeks.filter((value) => value === week).length,
    firstReplies: replyWeeks.filter((value) => value === week).length,
  }));
  const within = (days: number) =>
    cohort.filter((row) => row.submittedAt && now.getTime() - Date.parse(row.submittedAt) <= days * DAY_MS).length;
  const recentWeeks = weeks.slice(-4);
  return {
    weeks,
    submittedLast7Days: within(7),
    submittedLast30Days: within(30),
    averageSubmittedPerWeek: {
      weeks: recentWeeks.length,
      value: round(recentWeeks.reduce((sum, week) => sum + week.submitted, 0) / Math.max(1, recentWeeks.length), 1),
    },
    stageHops: [
      hop(cohort, "submitted", "submitted", "first reply", REPLY_OUTCOMES),
      hop(cohort, "submitted", "submitted", "screen or assessment", ["recruiter_screen", "assessment"]),
      hop(cohort, "screen or assessment", ["recruiter_screen", "assessment"], "interview", ["interview"]),
      hop(cohort, "interview", ["interview"], "offer", ["offer"]),
    ],
  };
}
