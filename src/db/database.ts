import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { logger } from "../util/logger.js";

/**
 * SQLite persistence via Node's built-in driver, so the server installs with no
 * native build step.
 */

const SCHEMA = `
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  fingerprint TEXT NOT NULL,
  ats TEXT NOT NULL,
  company_name TEXT NOT NULL,
  company_tier TEXT NOT NULL DEFAULT 'B',
  board TEXT NOT NULL,
  external_id TEXT NOT NULL,
  title TEXT NOT NULL,
  locations_raw TEXT NOT NULL DEFAULT '[]',
  location_class TEXT NOT NULL,
  country TEXT NOT NULL,
  workplace_type TEXT NOT NULL,
  employment_type TEXT NOT NULL DEFAULT 'unknown',
  url TEXT NOT NULL,
  apply_url TEXT NOT NULL,
  description_text TEXT NOT NULL DEFAULT '',
  description_hash TEXT NOT NULL DEFAULT '',
  compensation_json TEXT,
  posted_at TEXT,
  captured_at TEXT NOT NULL,
  first_seen_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_fingerprint ON jobs(fingerprint);
CREATE INDEX IF NOT EXISTS idx_jobs_company ON jobs(company_name);

CREATE TABLE IF NOT EXISTS evaluations (
  job_id TEXT PRIMARY KEY,
  decision TEXT NOT NULL,
  gate_rule TEXT,
  gate_reason TEXT NOT NULL DEFAULT '',
  gate_evidence TEXT NOT NULL DEFAULT '',
  track_id TEXT,
  score REAL NOT NULL DEFAULT 0,
  tier TEXT NOT NULL DEFAULT 'none',
  components_json TEXT NOT NULL DEFAULT '[]',
  flags_json TEXT NOT NULL DEFAULT '[]',
  evaluated_at TEXT NOT NULL,
  FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_eval_decision ON evaluations(decision, score);

CREATE TABLE IF NOT EXISTS applications (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL,
  resume_id TEXT NOT NULL DEFAULT '',
  resume_path TEXT NOT NULL DEFAULT '',
  packet_hash TEXT NOT NULL DEFAULT '',
  cover_letter TEXT NOT NULL DEFAULT '',
  answers_json TEXT NOT NULL DEFAULT '[]',
  blocked_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  approved_at TEXT,
  submitted_at TEXT,
  submission_mode TEXT,
  confirmation_ref TEXT,
  artifact_path TEXT,
  notes TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_app_status ON applications(status);

CREATE TABLE IF NOT EXISTS approvals (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL,
  packet_hash TEXT NOT NULL,
  decision TEXT NOT NULL,
  decided_at TEXT NOT NULL,
  note TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_approval_app ON approvals(application_id);

CREATE TABLE IF NOT EXISTS outcomes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id TEXT NOT NULL,
  status TEXT NOT NULL,
  noted_at TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT ''
);

CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ts TEXT NOT NULL,
  type TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  payload TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_events_type ON events(type, ts);
`;

export type Db = DatabaseSync;

export function openDatabase(path: string): Db {
  if (path !== ":memory:") {
    mkdirSync(dirname(path), { recursive: true });
  }
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL;");
  db.exec("PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  logger.debug("database ready", { path });
  return db;
}

/** SQLite has no boolean type; store flags as integers. */
export function toSqlBool(value: boolean): number {
  return value ? 1 : 0;
}

export function jsonOrDefault<T>(raw: unknown, fallback: T): T {
  if (typeof raw !== "string" || raw.length === 0) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function textOrNull(value: string | null | undefined): string | null {
  return value === undefined || value === null || value === "" ? null : value;
}
