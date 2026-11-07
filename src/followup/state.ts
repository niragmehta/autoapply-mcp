import type { Db } from "../db/database.js";
import { listFollowups, listOutcomeHistories, type FollowupKind, type FollowupRecord } from "../db/repositories/followups.js";
import { listMatchedReplies } from "../db/repositories/inbox.js";
import type { FollowUpPolicy } from "../domain/policies/followup.js";
import { summarizeOutcomes, type OutcomeSummary } from "./stages.js";

/**
 * Everything the cadence and stale closing need to know about each submitted
 * application, read in four queries for the whole campaign.
 */

export type SubmittedApplication = {
  applicationId: string;
  submittedAt: string;
  company: string;
  title: string;
  url: string;
};

export type FollowUpState = {
  application: SubmittedApplication;
  outcomes: OutcomeSummary;
  /** A reply other than an acknowledgement arrived and is recorded or awaiting review. */
  pendingReply: boolean;
  followups: ReadonlyMap<FollowupKind, FollowupRecord>;
};

type Row = Record<string, unknown>;

const NOT_A_REPLY = new Set(["acknowledged", "noise"]);

export function loadSubmittedApplications(db: Db): SubmittedApplication[] {
  const rows = db
    .prepare(
      `SELECT a.id, a.submitted_at, j.company_name, j.title, j.url FROM applications a JOIN jobs j ON j.id = a.job_id
       WHERE a.status = 'submitted' AND a.submitted_at IS NOT NULL ORDER BY a.submitted_at ASC`,
    )
    .all() as Row[];
  return rows.map((row) => ({
    applicationId: String(row.id),
    submittedAt: String(row.submitted_at),
    company: String(row.company_name),
    title: String(row.title),
    url: String(row.url ?? ""),
  }));
}

export function loadFollowUpStates(db: Db): FollowUpState[] {
  const histories = listOutcomeHistories(db);
  const replies = listMatchedReplies(db);
  const followups = new Map<string, Map<FollowupKind, FollowupRecord>>();
  for (const record of listFollowups(db)) {
    const byKind = followups.get(record.applicationId) ?? new Map<FollowupKind, FollowupRecord>();
    followups.set(record.applicationId, new Map([...byKind, [record.kind, record]]));
  }
  return loadSubmittedApplications(db).map((application) => ({
    application,
    outcomes: summarizeOutcomes(histories.get(application.applicationId) ?? []),
    pendingReply: replies.some(
      (reply) =>
        reply.applicationId === application.applicationId &&
        !NOT_A_REPLY.has(reply.classification) &&
        reply.receivedAt >= application.submittedAt,
    ),
    followups: followups.get(application.applicationId) ?? new Map(),
  }));
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** After a follow-up is sent, at least this long passes before silence closes the application. */
export const CLOSE_GRACE_DAYS = 7;

export function addDays(iso: string, days: number): Date {
  return new Date(Date.parse(iso) + days * DAY_MS);
}

export function daysBetween(fromIso: string, to: Date): number {
  return (to.getTime() - Date.parse(fromIso)) / DAY_MS;
}

/** The latest moment the candidate reached out: submission, or the last follow-up actually sent. */
export function lastContactAt(state: FollowUpState): string {
  const sent = [...state.followups.values()]
    .filter((record) => !record.skipped)
    .map((record) => record.doneAt)
    .filter((value): value is string => value !== null);
  return [state.application.submittedAt, ...sent].sort().at(-1)!;
}

/**
 * When each reminder falls due. The second is never before the first, and a
 * follow-up done late pushes the next one back by the same gap, so two
 * messages never go out days apart.
 */
export function scheduleFor(state: FollowUpState, policy: FollowUpPolicy): Record<FollowupKind, Date> {
  const submitted = state.application.submittedAt;
  const firstDays = policy.firstAfterDays;
  const secondDays = Math.max(policy.secondAfterDays, firstDays + 1);
  const ghostDays = Math.max(policy.ghostAfterDays, secondDays + 1);
  const firstRecord = state.followups.get("first");
  const firstDone = firstRecord && !firstRecord.skipped ? firstRecord.doneAt : null;
  const first = addDays(submitted, firstDays);
  const secondPlanned = addDays(submitted, secondDays);
  const second = firstDone ? new Date(Math.max(secondPlanned.getTime(), addDays(firstDone, secondDays - firstDays).getTime())) : secondPlanned;
  const closePlanned = addDays(submitted, ghostDays);
  const lastContact = lastContactAt(state);
  const close =
    lastContact === submitted ? closePlanned : new Date(Math.max(closePlanned.getTime(), addDays(lastContact, CLOSE_GRACE_DAYS).getTime()));
  return { first, second, close };
}

/** Why an application is out of the follow-up cadence, or null when it is in it. */
export function cadenceExclusion(state: FollowUpState): string | null {
  if (state.outcomes.terminal) return `closed as ${state.outcomes.terminal}`;
  if (state.outcomes.respondedBeyondAcknowledgement) return `employer replied (${state.outcomes.furthestStage ?? "rejected"})`;
  if (state.pendingReply) return "a reply is awaiting review";
  return null;
}

/** Any snooze still running on the application's reminders. */
export function activeSnooze(state: FollowUpState, now: Date): string | null {
  const until = [...state.followups.values()]
    .map((record) => record.snoozedUntil)
    .filter((value): value is string => value !== null && Date.parse(value) > now.getTime())
    .sort()
    .at(-1);
  return until ?? null;
}
