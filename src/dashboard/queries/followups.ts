import type { Db } from "../../db/database.js";

/**
 * Follow-ups already handled, newest first: the ones you sent and the ones
 * you skipped. The cadence service lists only what is still pending; this
 * shows what was decided, so a skipped reminder never reads as a sent one.
 */

type Row = Record<string, unknown>;

export type HandledFollowUp = {
  applicationId: string;
  company: string;
  title: string;
  kind: string;
  handledAt: string;
  /** Resolved without being sent: not counted as contact. */
  skipped: boolean;
  note: string;
};

export function handledFollowUps(db: Db, options: { sinceDays?: number; limit?: number } = {}): HandledFollowUp[] {
  const since = new Date(Date.now() - (options.sinceDays ?? 30) * 86_400_000).toISOString();
  const limit = Math.min(Math.max(options.limit ?? 30, 1), 200);
  const rows = db
    .prepare(
      `SELECT f.application_id, f.kind, f.done_at, f.skipped, f.note, j.company_name, j.title
       FROM followups f
       JOIN applications a ON a.id = f.application_id
       JOIN jobs j ON j.id = a.job_id
       WHERE f.done_at IS NOT NULL AND f.done_at >= ?
       ORDER BY f.done_at DESC, f.application_id
       LIMIT ?`,
    )
    .all(since, limit) as Row[];
  return rows.map((row) => ({
    applicationId: String(row.application_id),
    company: String(row.company_name),
    title: String(row.title),
    kind: String(row.kind),
    handledAt: String(row.done_at),
    skipped: Number(row.skipped ?? 0) === 1,
    note: String(row.note ?? ""),
  }));
}
