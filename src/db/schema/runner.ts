import type { SchemaModule } from "../migrate.js";

/**
 * Long-running operations (discovery, preparation, submission runs) and their logs.
 *
 * A run belongs to the process that hosts it (`host_pid` on `host_name`). The
 * dashboard and the MCP server can both host runs against one database, so a
 * host only ever executes its own runs; `heartbeat_at` and the pid let any host
 * tell a live foreign run from one whose process died, and `cancel_requested`
 * lets one host ask another to stop a run between items.
 */
export const runnerSchema: SchemaModule = {
  name: "runner",
  sql: `
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  params_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  progress_done INTEGER NOT NULL DEFAULT 0,
  progress_total INTEGER NOT NULL DEFAULT 0,
  summary_json TEXT,
  error TEXT,
  host_pid INTEGER NOT NULL,
  host_name TEXT NOT NULL,
  heartbeat_at TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_runs_status ON runs(status, created_at);
CREATE INDEX IF NOT EXISTS idx_runs_created ON runs(created_at);

CREATE TABLE IF NOT EXISTS run_logs (
  run_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  ts TEXT NOT NULL,
  level TEXT NOT NULL,
  message TEXT NOT NULL,
  data_json TEXT,
  FOREIGN KEY (run_id) REFERENCES runs(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_run_logs_run_seq ON run_logs(run_id, seq);
`,
};