import type { ZodType } from "zod";
import type { Workspace } from "../config/load.js";
import type { RunLogLevel, RunLogRecord, RunRecord, RunStatus } from "../db/repositories/runs.js";

export type { RunLogLevel, RunLogRecord, RunRecord, RunStatus } from "../db/repositories/runs.js";

/**
 * What an executor receives for one run.
 *
 * `workspace` re-reads profile, campaign and companies whenever one of those
 * files changed on disk, so read it once at the start of each item: an edit
 * made while a long run is going then applies from the next item onward.
 */
export type TaskContext = {
  readonly runId: string;
  readonly workspace: Workspace;
  log(level: RunLogLevel, message: string, data?: unknown): void;
  progress(done: number, total: number): void;
  /** Aborted when the run is cancelled or its host shuts down; check it between items. */
  readonly signal: AbortSignal;
  /** Resolves after `ms`, or rejects with RunCancelledError as soon as the run is cancelled. */
  sleep(ms: number): Promise<void>;
  /** Throws RunCancelledError when the run has been cancelled. */
  throwIfCancelled(): void;
};

/** Runs one task to completion and returns its summary (stored as JSON). */
export type TaskExecutor<P> = (ctx: TaskContext, params: P) => Promise<unknown>;

export type TaskOptions<P> = {
  /** How many runs of this type may execute at once in one host. Defaults to 1. */
  concurrency?: number;
  /** Validates and normalises params at enqueue time, so a bad request fails before it is queued. */
  params?: ZodType<P>;
  /** One line shown in tool and dashboard listings. */
  description?: string;
};

export type RunEvent =
  | { kind: "log"; runId: string; log: RunLogRecord }
  | { kind: "progress"; runId: string; done: number; total: number }
  | { kind: "status"; runId: string; status: RunStatus; run: RunRecord };

export type RunListener = (event: RunEvent) => void;

export type CancelResult = {
  runId: string;
  /** Cancelled outright, abort signalled to a local executor, or flagged for the host that owns the run. */
  outcome: "cancelled" | "signalled" | "requested" | "already_finished";
  status: RunStatus;
};

export class RunCancelledError extends Error {
  constructor(message = "run cancelled") {
    super(message);
    this.name = "RunCancelledError";
  }
}
