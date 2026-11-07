import type { SchemaModule } from "../migrate.js";

/**
 * Liveness verdicts for stored postings, and postings dismissed by hand.
 *
 * Every check is appended rather than overwritten, so a stale verdict can be
 * told from a fresh one and the dashboard can show when a posting closed.
 */
export const hygieneSchema: SchemaModule = {
  name: "hygiene",
  sql: `
CREATE TABLE IF NOT EXISTS liveness_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  job_id TEXT NOT NULL,
  status TEXT NOT NULL,
  via TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '',
  checked_at TEXT NOT NULL,
  FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_liveness_job ON liveness_checks(job_id, checked_at);

-- Listing absence and repost clusters read every posting of one board.
CREATE INDEX IF NOT EXISTS idx_jobs_board ON jobs(ats, board, last_seen_at);

-- Postings the candidate ruled out by hand. Keyed by fingerprint so the same
-- role on a second board, or reposted, stays out of the queue too.
CREATE TABLE IF NOT EXISTS job_dismissals (
  fingerprint TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  dismissed_at TEXT NOT NULL
);
`,
};