import type { Db } from "../database.js";
import { jsonOrDefault, textOrNull } from "../database.js";
import type { Application, DraftAnswer } from "../../domain/job.js";
import { nowIso } from "../../util/hash.js";

/** Application lifecycle storage: draft, approval, submission, outcome. */

type Row = Record<string, unknown>;

function rowToApplication(row: Row): Application {
  return {
    id: String(row.id),
    jobId: String(row.job_id),
    status: String(row.status) as Application["status"],
    resumeId: String(row.resume_id ?? ""),
    resumePath: String(row.resume_path ?? ""),
    packetHash: String(row.packet_hash ?? ""),
    coverLetter: String(row.cover_letter ?? ""),
    answers: jsonOrDefault<DraftAnswer[]>(row.answers_json, []),
    blockedQuestions: jsonOrDefault<string[]>(row.blocked_json, []),
    createdAt: String(row.created_at),
    approvedAt: row.approved_at ? String(row.approved_at) : null,
    submittedAt: row.submitted_at ? String(row.submitted_at) : null,
    submissionMode: row.submission_mode ? String(row.submission_mode) : null,
    confirmationRef: row.confirmation_ref ? String(row.confirmation_ref) : null,
    artifactPath: row.artifact_path ? String(row.artifact_path) : null,
    notes: String(row.notes ?? ""),
  };
}

export function saveApplication(db: Db, application: Application): void {
  db.prepare(`
    INSERT INTO applications (
      id, job_id, status, resume_id, resume_path, packet_hash, cover_letter,
      answers_json, blocked_json, created_at, approved_at, submitted_at,
      submission_mode, confirmation_ref, artifact_path, notes
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(job_id) DO UPDATE SET
      status = excluded.status,
      resume_id = excluded.resume_id,
      resume_path = excluded.resume_path,
      packet_hash = excluded.packet_hash,
      cover_letter = excluded.cover_letter,
      answers_json = excluded.answers_json,
      blocked_json = excluded.blocked_json,
      approved_at = excluded.approved_at,
      submitted_at = excluded.submitted_at,
      submission_mode = excluded.submission_mode,
      confirmation_ref = excluded.confirmation_ref,
      artifact_path = excluded.artifact_path,
      notes = excluded.notes
  `).run(
    application.id,
    application.jobId,
    application.status,
    application.resumeId,
    application.resumePath,
    application.packetHash,
    application.coverLetter,
    JSON.stringify(application.answers),
    JSON.stringify(application.blockedQuestions),
    application.createdAt,
    textOrNull(application.approvedAt),
    textOrNull(application.submittedAt),
    textOrNull(application.submissionMode),
    textOrNull(application.confirmationRef),
    textOrNull(application.artifactPath),
    application.notes,
  );
}

export function getApplication(db: Db, id: string): Application | null {
  const row = db.prepare("SELECT * FROM applications WHERE id = ?").get(id) as Row | undefined;
  return row ? rowToApplication(row) : null;
}

export function getApplicationByJob(db: Db, jobId: string): Application | null {
  const row = db.prepare("SELECT * FROM applications WHERE job_id = ?").get(jobId) as Row | undefined;
  return row ? rowToApplication(row) : null;
}

export function listApplications(db: Db, status?: string, limit = 200): Application[] {
  const rows = status
    ? (db.prepare("SELECT * FROM applications WHERE status = ? ORDER BY created_at DESC LIMIT ?").all(status, limit) as Row[])
    : (db.prepare("SELECT * FROM applications ORDER BY created_at DESC LIMIT ?").all(limit) as Row[]);
  return rows.map(rowToApplication);
}

export function countSubmittedSince(db: Db, isoTimestamp: string): number {
  const row = db
    .prepare("SELECT COUNT(*) AS total FROM applications WHERE submitted_at IS NOT NULL AND submitted_at >= ?")
    .get(isoTimestamp) as Row | undefined;
  return Number(row?.total ?? 0);
}

export function lastSubmissionAt(db: Db): string | null {
  const row = db
    .prepare("SELECT submitted_at FROM applications WHERE submitted_at IS NOT NULL ORDER BY submitted_at DESC LIMIT 1")
    .get() as Row | undefined;
  return row?.submitted_at ? String(row.submitted_at) : null;
}

export function recordApproval(
  db: Db,
  input: { id: string; applicationId: string; packetHash: string; decision: string; note: string },
): void {
  db.prepare(
    "INSERT INTO approvals (id, application_id, packet_hash, decision, decided_at, note) VALUES (?,?,?,?,?,?)",
  ).run(input.id, input.applicationId, input.packetHash, input.decision, nowIso(), input.note);
}

export type ApprovalRecord = {
  id: string;
  applicationId: string;
  packetHash: string;
  decision: string;
  decidedAt: string;
  note: string;
};

/** Latest approval decision for an application, used as the submission gate. */
export function latestApproval(db: Db, applicationId: string): ApprovalRecord | null {
  const row = db
    .prepare("SELECT * FROM approvals WHERE application_id = ? ORDER BY decided_at DESC LIMIT 1")
    .get(applicationId) as Row | undefined;
  if (!row) return null;
  return {
    id: String(row.id),
    applicationId: String(row.application_id),
    packetHash: String(row.packet_hash),
    decision: String(row.decision),
    decidedAt: String(row.decided_at),
    note: String(row.note ?? ""),
  };
}

export function recordOutcome(db: Db, applicationId: string, status: string, detail: string): void {
  db.prepare("INSERT INTO outcomes (application_id, status, noted_at, detail) VALUES (?,?,?,?)").run(
    applicationId,
    status,
    nowIso(),
    detail,
  );
}

export function listOutcomes(db: Db, applicationId: string): Array<{ status: string; notedAt: string; detail: string }> {
  const rows = db
    .prepare("SELECT status, noted_at, detail FROM outcomes WHERE application_id = ? ORDER BY noted_at ASC")
    .all(applicationId) as Row[];
  return rows.map((row) => ({
    status: String(row.status),
    notedAt: String(row.noted_at),
    detail: String(row.detail ?? ""),
  }));
}
