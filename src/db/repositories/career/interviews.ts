import type { Db } from "../../database.js";
import type {
  Interview,
  Interviewer,
  InterviewSession,
  InterviewStage,
  InterviewStatus,
  SessionKind,
} from "../../../career/types.js";
import { limitOf, numberOrNull, text, textOrNull, type Row } from "./rows.js";

/** Storage for scheduled interviews and their plan, practice, debrief and red-flag sessions. */

function interviewersOf(raw: unknown): Interviewer[] {
  if (typeof raw !== "string" || raw.length === 0) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
      .map((entry) => ({ name: text(entry.name), role: text(entry.role) }));
  } catch {
    return [];
  }
}

function rowToInterview(row: Row): Interview {
  return {
    id: text(row.id),
    applicationId: text(row.application_id),
    stage: text(row.stage) as InterviewStage,
    scheduledAt: textOrNull(row.scheduled_at),
    durationMinutes: numberOrNull(row.duration_minutes),
    format: text(row.format),
    locationOrLink: text(row.location_or_link),
    interviewers: interviewersOf(row.interviewers_json),
    status: text(row.status) as InterviewStatus,
    notes: text(row.notes),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  };
}

/** Inserts an interview, or replaces every field but `created_at` of an existing one. */
export function saveInterviewRecord(db: Db, interview: Interview): void {
  db.prepare(`
    INSERT INTO interviews (
      id, application_id, stage, scheduled_at, duration_minutes, format, location_or_link,
      interviewers_json, status, notes, created_at, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      stage = excluded.stage,
      scheduled_at = excluded.scheduled_at,
      duration_minutes = excluded.duration_minutes,
      format = excluded.format,
      location_or_link = excluded.location_or_link,
      interviewers_json = excluded.interviewers_json,
      status = excluded.status,
      notes = excluded.notes,
      updated_at = excluded.updated_at
  `).run(
    interview.id,
    interview.applicationId,
    interview.stage,
    interview.scheduledAt,
    interview.durationMinutes,
    interview.format,
    interview.locationOrLink,
    JSON.stringify(interview.interviewers),
    interview.status,
    interview.notes,
    interview.createdAt,
    interview.updatedAt,
  );
}

export function getInterview(db: Db, id: string): Interview | null {
  const row = db.prepare("SELECT * FROM interviews WHERE id = ?").get(id) as Row | undefined;
  return row ? rowToInterview(row) : null;
}

export type InterviewFilter = {
  applicationId?: string;
  status?: InterviewStatus;
  /** Only interviews scheduled at or after this ISO instant. */
  from?: string;
  /** With `from`, also keep interviews that have no time yet. */
  includeUnscheduled?: boolean;
  limit?: number;
};

/** Interviews in schedule order; unscheduled ones last. */
export function listInterviewRecords(db: Db, filter: InterviewFilter = {}): Interview[] {
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (filter.applicationId) {
    clauses.push("application_id = ?");
    params.push(filter.applicationId);
  }
  if (filter.status) {
    clauses.push("status = ?");
    params.push(filter.status);
  }
  if (filter.from) {
    clauses.push(filter.includeUnscheduled ? "(scheduled_at >= ? OR scheduled_at IS NULL)" : "scheduled_at >= ?");
    params.push(filter.from);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db
    .prepare(`SELECT * FROM interviews ${where} ORDER BY scheduled_at IS NULL, scheduled_at ASC, created_at ASC LIMIT ?`)
    .all(...params, limitOf(filter.limit, 200)) as Row[];
  return rows.map(rowToInterview);
}

function rowToSession(row: Row): InterviewSession {
  return {
    id: text(row.id),
    interviewId: textOrNull(row.interview_id),
    applicationId: text(row.application_id),
    kind: text(row.kind) as SessionKind,
    content: text(row.content),
    createdAt: text(row.created_at),
  };
}

export function insertSessionRecord(db: Db, session: InterviewSession): void {
  db.prepare(
    "INSERT INTO interview_sessions (id, interview_id, application_id, kind, content, created_at) VALUES (?,?,?,?,?,?)",
  ).run(session.id, session.interviewId, session.applicationId, session.kind, session.content, session.createdAt);
}

export type SessionFilter = { applicationId?: string; interviewId?: string; kind?: SessionKind; limit?: number };

/** Sessions newest first. */
export function listSessionRecords(db: Db, filter: SessionFilter = {}): InterviewSession[] {
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (filter.applicationId) {
    clauses.push("application_id = ?");
    params.push(filter.applicationId);
  }
  if (filter.interviewId) {
    clauses.push("interview_id = ?");
    params.push(filter.interviewId);
  }
  if (filter.kind) {
    clauses.push("kind = ?");
    params.push(filter.kind);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db
    .prepare(`SELECT * FROM interview_sessions ${where} ORDER BY created_at DESC, id DESC LIMIT ?`)
    .all(...params, limitOf(filter.limit, 50)) as Row[];
  return rows.map(rowToSession);
}
