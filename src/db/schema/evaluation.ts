import type { SchemaModule } from "../migrate.js";

/**
 * Saved deep evaluations. The deterministic scaffold and the agent's narrative
 * are stored separately, so a report can always show which statements the
 * server computed and which the agent wrote.
 */
export const evaluationSchema: SchemaModule = {
  name: "evaluation",
  sql: `
CREATE TABLE IF NOT EXISTS evaluation_reports (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  score REAL,
  verdict TEXT NOT NULL,
  scaffold_json TEXT NOT NULL DEFAULT '{}',
  narrative_json TEXT NOT NULL DEFAULT '{}',
  unverified_json TEXT NOT NULL DEFAULT '[]',
  markdown_path TEXT NOT NULL DEFAULT '',
  FOREIGN KEY (job_id) REFERENCES jobs(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_reports_job ON evaluation_reports(job_id, created_at);
`,
};