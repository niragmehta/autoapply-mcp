import type { Db } from "../database.js";
import { jsonOrDefault } from "../database.js";

/** Storage for orchestrated runs and their append-only logs. */

export const RUN_STATUSES = ["queued", "running", "succeeded", "failed", "cancelled", "interrupted"] as const;
export type RunStatus = (typeof RUN_STATUSES)[number];

/** Statuses a run never leaves. */
export const TERMINAL_RUN_STATUSES: readonly RunStatus[] = ["succeeded", "failed", "cancelled", "interrupted"];

export const RUN_LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type RunLogLevel = (typeof RUN_LOG_LEVELS)[number];

export type RunRecord = {
  id: string;
  type: string;
  params: unknown;
  status: RunStatus;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  progressDone: number;
  progressTotal: number;
  summary: unknown;
  error: string | null;
  hostPid: number;
  hostName: string;
  heartbeatAt: string | null;
  cancelRequested: boolean;
};

export type RunLogRecord = {
  runId: string;
  seq: number;
  ts: string;
  level: RunLogLevel;
  message: string;
  data: unknown;
};

type Row = Record<string, unknown>;

function textOrNullOf(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function rowToRun(row: Row): RunRecord {
  return {
    id: String(row.id),
    type: String(row.type),
    params: jsonOrDefault<unknown>(row.params_json, {}),
    status: String(row.status) as RunStatus,
    createdAt: String(row.created_at),
    startedAt: textOrNullOf(row.started_at),
    finishedAt: textOrNullOf(row.finished_at),
    progressDone: Number(row.progress_done ?? 0),
    progressTotal: Number(row.progress_total ?? 0),
    summary: jsonOrDefault<unknown>(row.summary_json, null),
    error: textOrNullOf(row.error),
    hostPid: Number(row.host_pid ?? 0),
    hostName: String(row.host_name ?? ""),
    heartbeatAt: textOrNullOf(row.heartbeat_at),
    cancelRequested: Number(row.cancel_requested ?? 0) === 1,
  };
}

function rowToLog(row: Row): RunLogRecord {
  return {
    runId: String(row.run_id),
    seq: Number(row.seq),
    ts: String(row.ts),
    level: String(row.level) as RunLogLevel,
    message: String(row.message),
    data: jsonOrDefault<unknown>(row.data_json, null),
  };
}

export type NewRun = {
  id: string;
  type: string;
  params: unknown;
  createdAt: string;
  hostPid: number;
  hostName: string;
};

export function insertRun(db: Db, run: NewRun): void {
  db.prepare(
    `INSERT INTO runs (id, type, params_json, status, created_at, host_pid, host_name, heartbeat_at)
     VALUES (?, ?, ?, 'queued', ?, ?, ?, ?)`,
  ).run(run.id, run.type, JSON.stringify(run.params ?? {}), run.createdAt, run.hostPid, run.hostName, run.createdAt);
}

export function getRun(db: Db, id: string): RunRecord | null {
  const row = db.prepare("SELECT * FROM runs WHERE id = ?").get(id) as Row | undefined;
  return row ? rowToRun(row) : null;
}

export type RunListFilter = {
  statuses?: readonly RunStatus[];
  type?: string;
  limit?: number;
  /** Only runs created strictly before this timestamp, for paging back through history. */
  before?: string;
};

export function listRuns(db: Db, filter: RunListFilter = {}): RunRecord[] {
  const clauses: string[] = [];
  const values: Array<string | number> = [];
  if (filter.statuses && filter.statuses.length > 0) {
    clauses.push(`status IN (${filter.statuses.map(() => "?").join(", ")})`);
    values.push(...filter.statuses);
  }
  if (filter.type) {
    clauses.push("type = ?");
    values.push(filter.type);
  }
  if (filter.before) {
    clauses.push("created_at < ?");
    values.push(filter.before);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 1000);
  const rows = db
    .prepare(`SELECT * FROM runs ${where} ORDER BY created_at DESC, id DESC LIMIT ?`)
    .all(...values, limit) as Row[];
  return rows.map(rowToRun);
}

/** Run counts per status, for status summaries. */
export function runCountsByStatus(db: Db): Record<RunStatus, number> {
  const counts = Object.fromEntries(RUN_STATUSES.map((status) => [status, 0])) as Record<RunStatus, number>;
  const rows = db.prepare("SELECT status, COUNT(*) AS total FROM runs GROUP BY status").all() as Row[];
  for (const row of rows) {
    const status = String(row.status) as RunStatus;
    if (status in counts) counts[status] = Number(row.total ?? 0);
  }
  return counts;
}

export function markRunStarted(db: Db, id: string, at: string): void {
  db.prepare("UPDATE runs SET status = 'running', started_at = ?, heartbeat_at = ? WHERE id = ?").run(at, at, id);
}

export function updateRunProgress(db: Db, id: string, done: number, total: number): void {
  db.prepare("UPDATE runs SET progress_done = ?, progress_total = ? WHERE id = ?").run(done, total, id);
}

export type RunFinish = {
  status: RunStatus;
  finishedAt: string;
  summary?: unknown;
  error?: string | null;
};

export function finishRun(db: Db, id: string, finish: RunFinish): void {
  db.prepare("UPDATE runs SET status = ?, finished_at = ?, summary_json = ?, error = ? WHERE id = ?").run(
    finish.status,
    finish.finishedAt,
    finish.summary === undefined || finish.summary === null ? null : JSON.stringify(finish.summary),
    finish.error ?? null,
    id,
  );
}

/** Marks runs that will never progress (their host is gone) as interrupted. */
export function markRunsInterrupted(db: Db, ids: readonly string[], at: string, reason: string): void {
  const statement = db.prepare(
    "UPDATE runs SET status = 'interrupted', finished_at = ?, error = ? WHERE id = ? AND status IN ('queued', 'running')",
  );
  for (const id of ids) statement.run(at, reason, id);
}

export function touchRunHeartbeats(db: Db, ids: readonly string[], at: string): void {
  const statement = db.prepare("UPDATE runs SET heartbeat_at = ? WHERE id = ?");
  for (const id of ids) statement.run(at, id);
}

/** Flags an unfinished run for cancellation by whichever process hosts it. Returns whether a run was flagged. */
export function requestRunCancel(db: Db, id: string): boolean {
  const result = db
    .prepare("UPDATE runs SET cancel_requested = 1 WHERE id = ? AND status IN ('queued', 'running')")
    .run(id);
  return Number(result.changes) > 0;
}

/** The subset of `ids` someone asked to cancel. */
export function cancelRequestedAmong(db: Db, ids: readonly string[]): string[] {
  if (ids.length === 0) return [];
  const rows = db
    .prepare(`SELECT id FROM runs WHERE cancel_requested = 1 AND id IN (${ids.map(() => "?").join(", ")})`)
    .all(...ids) as Row[];
  return rows.map((row) => String(row.id));
}

export function appendRunLog(db: Db, log: RunLogRecord): void {
  db.prepare("INSERT INTO run_logs (run_id, seq, ts, level, message, data_json) VALUES (?, ?, ?, ?, ?, ?)").run(
    log.runId,
    log.seq,
    log.ts,
    log.level,
    log.message,
    log.data === undefined || log.data === null ? null : JSON.stringify(log.data),
  );
}

/** The highest log sequence number recorded for a run, or 0. */
export function lastRunLogSeq(db: Db, runId: string): number {
  const row = db.prepare("SELECT MAX(seq) AS seq FROM run_logs WHERE run_id = ?").get(runId) as Row | undefined;
  return Number(row?.seq ?? 0);
}

export function listRunLogs(db: Db, runId: string, options: { afterSeq?: number; limit?: number } = {}): RunLogRecord[] {
  const limit = Math.min(Math.max(options.limit ?? 500, 1), 5000);
  const rows = db
    .prepare("SELECT * FROM run_logs WHERE run_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?")
    .all(runId, options.afterSeq ?? 0, limit) as Row[];
  return rows.map(rowToLog);
}

/** The newest `limit` log lines of a run, in ascending order. */
export function tailRunLogs(db: Db, runId: string, limit = 200): RunLogRecord[] {
  const rows = db
    .prepare("SELECT * FROM run_logs WHERE run_id = ? ORDER BY seq DESC LIMIT ?")
    .all(runId, Math.min(Math.max(limit, 1), 5000)) as Row[];
  return rows.map(rowToLog).reverse();
}
