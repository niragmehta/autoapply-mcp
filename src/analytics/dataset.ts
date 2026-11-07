import type { Db } from "../db/database.js";
import { listOutcomeHistories } from "../db/repositories/followups.js";
import { isReplyOutcome, summarizeOutcomes, type OutcomeEntry, type OutcomeSummary } from "../followup/stages.js";
import { daysBetween } from "./stats.js";

/**
 * One row per application with everything the analytics slice by: the
 * posting, its current evaluation, and the outcome history.
 *
 * Tier, track and score are the posting's evaluation as stored now. A
 * posting re-evaluated after the campaign changed carries its new score, not
 * the one it had when the application went out.
 */

export type ApplicationRow = {
  applicationId: string;
  status: string;
  createdAt: string;
  approvedAt: string | null;
  submittedAt: string | null;
  submissionMode: string;
  company: string;
  title: string;
  ats: string;
  companyTier: string;
  locationClass: string;
  url: string;
  tier: string;
  trackId: string;
  score: number | null;
  history: OutcomeEntry[];
  outcomes: OutcomeSummary;
  /** Earliest time each reply kind is known to have arrived: the email's date when it came from the inbox. */
  firstReplyAt: Partial<Record<string, string>>;
};

type Row = Record<string, unknown>;

function inboxReplyTimes(db: Db): Map<string, Map<string, string>> {
  const rows = db
    .prepare(
      `SELECT matched_application_id, classification, MIN(received_at) AS first_at FROM inbox_messages
       WHERE status = 'recorded' AND matched_application_id IS NOT NULL
       GROUP BY matched_application_id, classification`,
    )
    .all() as Row[];
  const times = new Map<string, Map<string, string>>();
  for (const row of rows) {
    const key = String(row.matched_application_id);
    times.set(key, new Map([...(times.get(key) ?? []), [String(row.classification), String(row.first_at)]]));
  }
  return times;
}

function earliest(a: string | undefined, b: string | undefined): string | undefined {
  if (!a) return b;
  if (!b) return a;
  return a < b ? a : b;
}

export function loadApplicationRows(db: Db): ApplicationRow[] {
  const rows = db
    .prepare(
      `SELECT a.id, a.status, a.created_at, a.approved_at, a.submitted_at, a.submission_mode,
              j.company_name, j.title, j.ats, j.company_tier, j.location_class, j.url,
              e.tier, e.track_id, e.score
       FROM applications a JOIN jobs j ON j.id = a.job_id LEFT JOIN evaluations e ON e.job_id = a.job_id`,
    )
    .all() as Row[];
  const histories = listOutcomeHistories(db);
  const replies = inboxReplyTimes(db);
  return rows.map((row) => {
    const applicationId = String(row.id);
    const history = (histories.get(applicationId) ?? []).map((entry) => ({ status: entry.status, notedAt: entry.notedAt }));
    const outcomes = summarizeOutcomes(history);
    const fromInbox = replies.get(applicationId) ?? new Map<string, string>();
    const firstReplyAt: Partial<Record<string, string>> = {};
    for (const kind of new Set([...Object.keys(outcomes.firstAt), ...fromInbox.keys()])) {
      if (!isReplyOutcome(kind)) continue;
      const time = earliest(outcomes.firstAt[kind as keyof typeof outcomes.firstAt], fromInbox.get(kind));
      if (time) firstReplyAt[kind] = time;
    }
    return {
      applicationId,
      status: String(row.status),
      createdAt: String(row.created_at),
      approvedAt: row.approved_at ? String(row.approved_at) : null,
      submittedAt: row.submitted_at ? String(row.submitted_at) : null,
      submissionMode: row.submission_mode ? String(row.submission_mode) : "unrecorded",
      company: String(row.company_name),
      title: String(row.title),
      ats: String(row.ats),
      companyTier: String(row.company_tier ?? "B"),
      locationClass: String(row.location_class ?? "unknown"),
      url: String(row.url ?? ""),
      tier: row.tier ? String(row.tier) : "unevaluated",
      trackId: row.track_id ? String(row.track_id) : "none",
      score: row.score === null || row.score === undefined ? null : Number(row.score),
      history,
      outcomes,
      firstReplyAt,
    };
  });
}

/** Submitted applications, optionally only those submitted on or after `since`. */
export function submittedCohort(rows: readonly ApplicationRow[], since: string | null): ApplicationRow[] {
  return rows.filter((row) => row.status === "submitted" && row.submittedAt !== null && (!since || row.submittedAt >= since));
}

/** Still waiting: no reply, not closed, and younger than the ghosting horizon. */
export function isInFlight(row: ApplicationRow, now: Date, ghostAfterDays: number): boolean {
  if (!row.submittedAt || row.outcomes.responded || row.outcomes.terminal) return false;
  return daysBetween(row.submittedAt, now.toISOString()) < ghostAfterDays;
}
