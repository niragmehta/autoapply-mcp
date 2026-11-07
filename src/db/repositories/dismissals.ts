import type { Db } from "../database.js";

export type JobDismissal = {
  fingerprint: string;
  jobId: string;
  reason: string;
  dismissedAt: string;
};

export type DismissedJob = JobDismissal & { company: string; title: string; url: string };

type Row = Record<string, unknown>;

const toDismissal = (row: Row): JobDismissal => ({
  fingerprint: String(row.fingerprint),
  jobId: String(row.job_id),
  reason: String(row.reason ?? ""),
  dismissedAt: String(row.dismissed_at),
});

export function getDismissal(db: Db, fingerprint: string): JobDismissal | null {
  const row = db.prepare("SELECT * FROM job_dismissals WHERE fingerprint = ?").get(fingerprint) as Row | undefined;
  return row ? toDismissal(row) : null;
}

export function saveDismissal(db: Db, dismissal: JobDismissal): void {
  db.prepare(
    `INSERT INTO job_dismissals (fingerprint, job_id, reason, dismissed_at) VALUES (?,?,?,?)
     ON CONFLICT(fingerprint) DO UPDATE SET reason = excluded.reason`,
  ).run(dismissal.fingerprint, dismissal.jobId, dismissal.reason, dismissal.dismissedAt);
}

export function deleteDismissal(db: Db, fingerprint: string): boolean {
  return db.prepare("DELETE FROM job_dismissals WHERE fingerprint = ?").run(fingerprint).changes > 0;
}

/** Dismissed postings, newest first, with the job they were dismissed from. */
export function listDismissals(db: Db, limit = 200): DismissedJob[] {
  const rows = db
    .prepare(
      `SELECT d.*, j.company_name, j.title, j.url FROM job_dismissals d
       LEFT JOIN jobs j ON j.id = d.job_id
       ORDER BY d.dismissed_at DESC, d.fingerprint LIMIT ?`,
    )
    .all(limit) as Row[];
  return rows.map((row) => ({
    ...toDismissal(row),
    company: String(row.company_name ?? ""),
    title: String(row.title ?? ""),
    url: String(row.url ?? ""),
  }));
}

export function countDismissals(db: Db): number {
  return Number((db.prepare("SELECT COUNT(*) AS n FROM job_dismissals").get() as Row).n);
}
