import type { Db } from "../../db/database.js";
import { jsonOrDefault } from "../../db/database.js";
import type { DraftAnswer } from "../../domain/job.js";
import { inClause, likePattern } from "./jobs.js";

/** Read models for the dashboard's application table and the needs-human queue. */

export const APPLICATION_SORTS = {
  created: "a.created_at",
  submitted: "a.submitted_at",
  approved: "a.approved_at",
  company: "j.company_name COLLATE NOCASE",
  status: "a.status",
  score: "e.score",
} as const;
export type ApplicationSort = keyof typeof APPLICATION_SORTS;

export type ApplicationListFilter = {
  statuses?: string[];
  q?: string;
  company?: string;
  sort: ApplicationSort;
  dir: "asc" | "desc";
  page: number;
  pageSize: number;
};

export type ApplicationRow = {
  id: string;
  status: string;
  jobId: string;
  company: string;
  title: string;
  ats: string;
  tier: string | null;
  score: number | null;
  /** The stored packet hash; a submit run started from a list binds approval to it. */
  packetHash: string;
  createdAt: string;
  approvedAt: string | null;
  submittedAt: string | null;
  submissionMode: string | null;
  unresolved: number;
  latestOutcome: { status: string; notedAt: string } | null;
};

type Row = Record<string, unknown>;

/** A required question only a person can answer, still blank: what keeps an application from being approved. */
export function isUnresolved(answer: DraftAnswer): boolean {
  return answer.requiresHuman && answer.required && answer.notApplicable !== true && answer.answer.trim().length === 0;
}

const FROM = `FROM applications a
  JOIN jobs j ON j.id = a.job_id
  LEFT JOIN evaluations e ON e.job_id = a.job_id`;

const LATEST_OUTCOME = `(SELECT o.status || '|' || o.noted_at FROM outcomes o WHERE o.application_id = a.id ORDER BY o.noted_at DESC, o.id DESC LIMIT 1)`;

function rowToApplication(row: Row): ApplicationRow {
  const outcome = row.latest_outcome ? String(row.latest_outcome).split("|") : null;
  const answers = jsonOrDefault<DraftAnswer[]>(row.answers_json, []);
  return {
    id: String(row.id),
    status: String(row.status),
    jobId: String(row.job_id),
    company: String(row.company_name),
    title: String(row.title),
    ats: String(row.ats),
    tier: row.tier ? String(row.tier) : null,
    score: row.score === null || row.score === undefined ? null : Number(row.score),
    packetHash: String(row.packet_hash ?? ""),
    createdAt: String(row.created_at),
    approvedAt: row.approved_at ? String(row.approved_at) : null,
    submittedAt: row.submitted_at ? String(row.submitted_at) : null,
    submissionMode: row.submission_mode ? String(row.submission_mode) : null,
    unresolved: answers.filter(isUnresolved).length,
    latestOutcome: outcome && outcome[0] ? { status: outcome[0], notedAt: outcome[1] ?? "" } : null,
  };
}

export function listApplicationRows(db: Db, filter: ApplicationListFilter): { total: number; rows: ApplicationRow[] } {
  const clauses: string[] = [];
  const values: Array<string | number> = [];
  if (filter.statuses && filter.statuses.length > 0) {
    clauses.push(inClause("a.status", filter.statuses));
    values.push(...filter.statuses);
  }
  if (filter.q && filter.q.trim().length > 0) {
    const pattern = likePattern(filter.q.trim());
    clauses.push("(j.title LIKE ? ESCAPE '\\' OR j.company_name LIKE ? ESCAPE '\\' OR a.id = ?)");
    values.push(pattern, pattern, filter.q.trim());
  }
  if (filter.company) {
    clauses.push("j.company_name = ? COLLATE NOCASE");
    values.push(filter.company);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const total = db.prepare(`SELECT COUNT(*) AS total ${FROM} ${where}`).get(...values) as Row | undefined;
  const order = `${APPLICATION_SORTS[filter.sort]} ${filter.dir === "asc" ? "ASC" : "DESC"} NULLS LAST, a.id ASC`;
  const rows = db
    .prepare(
      `SELECT a.id, a.status, a.job_id, a.created_at, a.approved_at, a.submitted_at, a.submission_mode, a.answers_json, a.packet_hash,
              j.company_name, j.title, j.ats, e.tier, e.score, ${LATEST_OUTCOME} AS latest_outcome
       ${FROM} ${where}
       ORDER BY ${order}
       LIMIT ? OFFSET ?`,
    )
    .all(...values, filter.pageSize, (filter.page - 1) * filter.pageSize) as Row[];
  return { total: Number(total?.total ?? 0), rows: rows.map(rowToApplication) };
}

export type HeldApplication = {
  id: string;
  company: string;
  title: string;
  jobId: string;
  notes: string;
  artifactPath: string | null;
  answers: DraftAnswer[];
};

/** Every application waiting on a person, newest first. */
export function listHeldApplications(db: Db, limit = 1000): HeldApplication[] {
  const rows = db
    .prepare(
      `SELECT a.id, a.job_id, a.notes, a.artifact_path, a.answers_json, j.company_name, j.title
       FROM applications a JOIN jobs j ON j.id = a.job_id
       WHERE a.status = 'needs_human'
       ORDER BY a.created_at DESC LIMIT ?`,
    )
    .all(limit) as Row[];
  return rows.map((row) => ({
    id: String(row.id),
    company: String(row.company_name),
    title: String(row.title),
    jobId: String(row.job_id),
    notes: String(row.notes ?? ""),
    artifactPath: row.artifact_path ? String(row.artifact_path) : null,
    answers: jsonOrDefault<DraftAnswer[]>(row.answers_json, []),
  }));
}

/**
 * Answers a person already gave to a question with this label elsewhere,
 * most frequent first: the likely answer when the same question recurs.
 */
export function previousHumanAnswers(db: Db, labels: ReadonlySet<string>): Map<string, string[]> {
  const counts = new Map<string, Map<string, number>>();
  const rows = db.prepare("SELECT answers_json FROM applications WHERE answers_json LIKE '%\"human\"%'").all() as Row[];
  for (const row of rows) {
    for (const answer of jsonOrDefault<DraftAnswer[]>(row.answers_json, [])) {
      const key = answer.label.trim().toLowerCase();
      if (!labels.has(key) || answer.source !== "human" || answer.answer.trim().length === 0) continue;
      const values = counts.get(key) ?? new Map<string, number>();
      values.set(answer.answer, (values.get(answer.answer) ?? 0) + 1);
      counts.set(key, values);
    }
  }
  return new Map(
    [...counts.entries()].map(([key, values]) => [
      key,
      [...values.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([value]) => value),
    ]),
  );
}

export type EventRow = { id: number; ts: string; type: string; subject: string; payload: unknown };

export function listEventRows(db: Db, filter: { type?: string; subjects?: string[]; before?: number; limit: number }): EventRow[] {
  const clauses: string[] = [];
  const values: Array<string | number> = [];
  if (filter.type) {
    clauses.push("type = ?");
    values.push(filter.type);
  }
  if (filter.subjects && filter.subjects.length > 0) {
    clauses.push(inClause("subject", filter.subjects));
    values.push(...filter.subjects);
  }
  if (filter.before !== undefined) {
    clauses.push("id < ?");
    values.push(filter.before);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db.prepare(`SELECT * FROM events ${where} ORDER BY id DESC LIMIT ?`).all(...values, filter.limit) as Row[];
  return rows.map((row) => ({
    id: Number(row.id),
    ts: String(row.ts),
    type: String(row.type),
    subject: String(row.subject),
    payload: jsonOrDefault<unknown>(row.payload, {}),
  }));
}
