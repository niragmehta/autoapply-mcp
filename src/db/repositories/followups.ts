import type { Db } from "../database.js";

/** Follow-up reminders per application: when each is due and what the candidate did about it. */

type Row = Record<string, unknown>;

/**
 * Runs `work` in one write transaction: all of it commits or none of it does,
 * and a second process (the dashboard, a scan) waits rather than interleaving.
 * Joins a transaction already open on this connection.
 */
export function withTransaction<T>(db: Db, work: () => T): T {
  if ((db as { isTransaction?: boolean }).isTransaction === true) return work();
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export const FOLLOWUP_KINDS = ["first", "second", "close"] as const;
export type FollowupKind = (typeof FOLLOWUP_KINDS)[number];

export type FollowupRecord = {
  applicationId: string;
  kind: FollowupKind;
  dueAt: string;
  doneAt: string | null;
  snoozedUntil: string | null;
  note: string;
  /** Resolved without being sent: it neither counts as contact nor spaces out the next reminder. */
  skipped: boolean;
};

function rowToFollowup(row: Row): FollowupRecord {
  return {
    applicationId: String(row.application_id),
    kind: String(row.kind) as FollowupKind,
    dueAt: String(row.due_at),
    doneAt: row.done_at ? String(row.done_at) : null,
    snoozedUntil: row.snoozed_until ? String(row.snoozed_until) : null,
    note: String(row.note ?? ""),
    skipped: Number(row.skipped ?? 0) === 1,
  };
}

export function listFollowups(db: Db): FollowupRecord[] {
  const rows = db.prepare("SELECT * FROM followups ORDER BY application_id, due_at").all() as Row[];
  return rows.map(rowToFollowup);
}

export function getFollowup(db: Db, applicationId: string, kind: FollowupKind): FollowupRecord | null {
  const row = db
    .prepare("SELECT * FROM followups WHERE application_id = ? AND kind = ?")
    .get(applicationId, kind) as Row | undefined;
  return row ? rowToFollowup(row) : null;
}

/**
 * Creates the reminder, or moves its due date when the cadence changed. A
 * reminder already done keeps the date it was due, so history stays honest.
 */
export function seedFollowup(db: Db, input: { applicationId: string; kind: FollowupKind; dueAt: string }): void {
  db.prepare(
    `INSERT INTO followups (application_id, kind, due_at) VALUES (?,?,?)
     ON CONFLICT(application_id, kind) DO UPDATE SET due_at = excluded.due_at WHERE followups.done_at IS NULL`,
  ).run(input.applicationId, input.kind, input.dueAt);
}

export function markFollowupDone(
  db: Db,
  input: { applicationId: string; kind: FollowupKind; dueAt: string; doneAt: string; note?: string; skipped?: boolean },
): FollowupRecord {
  db.prepare(
    `INSERT INTO followups (application_id, kind, due_at, done_at, note, skipped) VALUES (?,?,?,?,?,?)
     ON CONFLICT(application_id, kind) DO UPDATE SET done_at = excluded.done_at, snoozed_until = NULL, skipped = excluded.skipped,
       note = CASE WHEN excluded.note = '' THEN followups.note ELSE excluded.note END`,
  ).run(input.applicationId, input.kind, input.dueAt, input.doneAt, input.note ?? "", input.skipped ? 1 : 0);
  return getFollowup(db, input.applicationId, input.kind)!;
}

export function snoozeFollowup(
  db: Db,
  input: { applicationId: string; kind: FollowupKind; dueAt: string; until: string; note?: string },
): FollowupRecord {
  db.prepare(
    `INSERT INTO followups (application_id, kind, due_at, snoozed_until, note) VALUES (?,?,?,?,?)
     ON CONFLICT(application_id, kind) DO UPDATE SET snoozed_until = excluded.snoozed_until, done_at = NULL,
       note = CASE WHEN excluded.note = '' THEN followups.note ELSE excluded.note END`,
  ).run(input.applicationId, input.kind, input.dueAt, input.until, input.note ?? "");
  return getFollowup(db, input.applicationId, input.kind)!;
}

/**
 * Every recorded outcome grouped by application, oldest first. One query for
 * the whole campaign: the cadence, stale closing and analytics all need every
 * application's history at once, and a query per application is ~600 round trips.
 */
export function listOutcomeHistories(db: Db): Map<string, Array<{ status: string; notedAt: string; detail: string }>> {
  const rows = db
    .prepare("SELECT application_id, status, noted_at, detail FROM outcomes ORDER BY noted_at ASC, id ASC")
    .all() as Row[];
  const histories = new Map<string, Array<{ status: string; notedAt: string; detail: string }>>();
  for (const row of rows) {
    const key = String(row.application_id);
    const entry = { status: String(row.status), notedAt: String(row.noted_at), detail: String(row.detail ?? "") };
    histories.set(key, [...(histories.get(key) ?? []), entry]);
  }
  return histories;
}
