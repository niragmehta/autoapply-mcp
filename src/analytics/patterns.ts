import type { Db } from "../db/database.js";
import type { ApplicationRow } from "./dataset.js";
import type { Dimension, GroupStats } from "./funnel.js";
import { DAY_MS, isoWeek, rate, type Rate } from "./stats.js";

/**
 * Where applications are lost: rejections by the stage they ended at, the
 * slices that are rejected most often, and what the gates throw away before
 * an application is ever written.
 */

const STAGE_LABELS = ["before any reply", "after acknowledgement", "after screen", "after assessment", "after interview", "after offer"];

/** Slices smaller than this are not ranked against each other: one rejection in two is not a pattern. */
const PATTERN_MIN_GROUP_N = 5;

export type RejectionPatterns = {
  total: number;
  byStage: Array<{ stage: string; count: number; share: Rate }>;
  highestRejectionRates: Array<{ dimension: Dimension; key: string; rejected: Rate }>;
  gateRules: Array<{ rule: string; count: number; share: Rate }>;
};

type Row = Record<string, unknown>;

const NO_RULE = "score below threshold";

/** Gate rules are taken from the discard analytics rather than counted twice over every evaluation. */
export function rejectionPatterns(
  cohort: readonly ApplicationRow[],
  breakdowns: Record<Dimension, GroupStats[]>,
  discards: DiscardAnalytics,
): RejectionPatterns {
  const rejected = cohort.filter((row) => row.outcomes.reached.has("rejected"));
  const byStage = STAGE_LABELS.map((stage, rank) => {
    const count = rejected.filter((row) => row.outcomes.furthestRank === rank).length;
    return { stage, count, share: rate(count, rejected.length) };
  }).filter((entry) => entry.count > 0);
  const highestRejectionRates = (Object.entries(breakdowns) as Array<[Dimension, GroupStats[]]>)
    .filter(([dimension]) => dimension !== "weekSubmitted")
    .flatMap(([dimension, groups]) =>
      groups
        .filter((group) => group.submitted >= PATTERN_MIN_GROUP_N && group.rejected.count > 0)
        .map((group) => ({ dimension, key: group.key, rejected: group.rejected })),
    )
    .sort((a, b) => (b.rejected.rate ?? 0) - (a.rejected.rate ?? 0) || b.rejected.n - a.rejected.n)
    .slice(0, 8);
  return {
    total: rejected.length,
    byStage,
    highestRejectionRates,
    gateRules: discards.byRule.slice(0, 12).map(({ rule, count, share }) => ({ rule, count, share })),
  };
}

export type DiscardAnalytics = {
  totals: { evaluated: number; accepted: number; review: number; rejected: number };
  byRule: Array<{ rule: string; count: number; share: Rate; examples: string[] }>;
  byAts: Array<{ ats: string; evaluated: number; rejected: Rate }>;
  byWeek: Array<{ week: string; evaluated: number; accepted: number; rejected: number }>;
};

const WEEKS_SHOWN = 12;

function decisionTotals(db: Db, since: string | null): DiscardAnalytics["totals"] {
  const rows = db
    .prepare("SELECT decision, COUNT(*) AS total FROM evaluations WHERE (? IS NULL OR evaluated_at >= ?) GROUP BY decision")
    .all(since, since) as Row[];
  const byDecision = new Map(rows.map((row) => [String(row.decision), Number(row.total ?? 0)]));
  const accepted = byDecision.get("accept") ?? 0;
  const review = byDecision.get("review") ?? 0;
  const rejected = byDecision.get("reject") ?? 0;
  return { evaluated: accepted + review + rejected, accepted, review, rejected };
}

/** Rejections per gate rule, with up to three of the most common reasons each, from one pass. */
function ruleBreakdown(db: Db, since: string | null): Array<{ rule: string; count: number; examples: string[] }> {
  const rows = db
    .prepare(
      `SELECT COALESCE(gate_rule, '${NO_RULE}') AS rule, gate_reason, COUNT(*) AS total FROM evaluations
       WHERE decision = 'reject' AND (? IS NULL OR evaluated_at >= ?)
       GROUP BY rule, gate_reason ORDER BY total DESC`,
    )
    .all(since, since) as Row[];
  const rules = new Map<string, { count: number; examples: string[] }>();
  for (const row of rows) {
    const rule = String(row.rule);
    const reason = String(row.gate_reason ?? "").trim().slice(0, 160);
    const current = rules.get(rule) ?? { count: 0, examples: [] };
    const examples = reason && current.examples.length < 3 && !current.examples.includes(reason) ? [...current.examples, reason] : current.examples;
    rules.set(rule, { count: current.count + Number(row.total ?? 0), examples });
  }
  return [...rules].map(([rule, entry]) => ({ rule, ...entry })).sort((a, b) => b.count - a.count || a.rule.localeCompare(b.rule));
}

function atsBreakdown(db: Db, since: string | null): DiscardAnalytics["byAts"] {
  const rows = db
    .prepare(
      `SELECT j.ats AS ats, e.decision AS decision, COUNT(*) AS total FROM evaluations e JOIN jobs j ON j.id = e.job_id
       WHERE (? IS NULL OR e.evaluated_at >= ?) GROUP BY j.ats, e.decision`,
    )
    .all(since, since) as Row[];
  const byAts = new Map<string, { evaluated: number; rejected: number }>();
  for (const row of rows) {
    const ats = String(row.ats);
    const current = byAts.get(ats) ?? { evaluated: 0, rejected: 0 };
    const total = Number(row.total ?? 0);
    byAts.set(ats, {
      evaluated: current.evaluated + total,
      rejected: current.rejected + (String(row.decision) === "reject" ? total : 0),
    });
  }
  return [...byAts]
    .map(([ats, counts]) => ({ ats, evaluated: counts.evaluated, rejected: rate(counts.rejected, counts.evaluated) }))
    .sort((a, b) => b.evaluated - a.evaluated);
}

function weeklyBreakdown(db: Db, since: string | null, now: Date): DiscardAnalytics["byWeek"] {
  const rows = db
    .prepare(
      `SELECT substr(evaluated_at, 1, 10) AS day, decision, COUNT(*) AS total FROM evaluations
       WHERE (? IS NULL OR evaluated_at >= ?) GROUP BY day, decision`,
    )
    .all(since, since) as Row[];
  const weeks = [...new Set(Array.from({ length: WEEKS_SHOWN }, (_unused, index) => isoWeek(new Date(now.getTime() - (WEEKS_SHOWN - 1 - index) * 7 * DAY_MS))))];
  const counts = new Map(weeks.map((week) => [week, { week, evaluated: 0, accepted: 0, rejected: 0 }]));
  for (const row of rows) {
    const day = String(row.day);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
    const entry = counts.get(isoWeek(`${day}T12:00:00Z`));
    if (!entry) continue;
    const total = Number(row.total ?? 0);
    const decision = String(row.decision);
    counts.set(entry.week, {
      ...entry,
      evaluated: entry.evaluated + total,
      accepted: entry.accepted + (decision === "accept" ? total : 0),
      rejected: entry.rejected + (decision === "reject" ? total : 0),
    });
  }
  return [...counts.values()];
}

export function discardAnalytics(db: Db, since: string | null, now: Date): DiscardAnalytics {
  const totals = decisionTotals(db, since);
  return {
    totals,
    byRule: ruleBreakdown(db, since).map((entry) => ({
      rule: entry.rule,
      count: entry.count,
      share: rate(entry.count, totals.rejected),
      examples: entry.examples,
    })),
    byAts: atsBreakdown(db, since),
    byWeek: weeklyBreakdown(db, since, now),
  };
}
