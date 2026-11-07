import { hostname } from "node:os";
import type { ZodType } from "zod";
import type { Workspace } from "../config/load.js";
import type { Db } from "../db/database.js";
import {
  TERMINAL_RUN_STATUSES,
  appendRunLog,
  cancelRequestedAmong,
  finishRun,
  getRun,
  insertRun,
  lastRunLogSeq,
  listRunLogs,
  listRuns,
  markRunStarted,
  markRunsInterrupted,
  requestRunCancel,
  tailRunLogs,
  touchRunHeartbeats,
  updateRunProgress,
  type RunListFilter,
} from "../db/repositories/runs.js";
import { redact } from "../text/redact.js";
import { AppError, toErrorMessage } from "../util/errors.js";
import { newId } from "../util/hash.js";
import { logger } from "../util/logger.js";
import {
  RunCancelledError,
  type CancelResult,
  type RunEvent,
  type RunListener,
  type RunLogLevel,
  type RunLogRecord,
  type RunRecord,
  type RunStatus,
  type TaskContext,
  type TaskExecutor,
  type TaskOptions,
} from "./types.js";
import { abortableSleep, defaultPidAlive, delay, sanitizeData } from "./util.js";
import { freshWorkspace } from "./workspace.js";

/**
 * In-process run queue.
 *
 * Runs are rows in the database, so any process can list them and read their
 * logs, but only the process that enqueued a run executes it. A host is either
 * the dashboard (durable: it stays up between sessions) or the MCP server
 * (runs stop when the client session ends). Cancellation is cooperative:
 * executors check `ctx.signal` between items, so an application half way
 * through a browser submission is always finished and recorded first.
 */

const SHUTDOWN_REASON = "host-shutdown";
const CANCEL_REASON = "cancelled";
const MAX_MESSAGE_LENGTH = 4000;

export type RunQueueOptions = {
  db: Db;
  /** Workspace given to executors; defaults to the shared workspace with fresh configuration. */
  workspace?: () => Workspace;
  hostPid?: number;
  hostName?: string;
  /** How often this host records it is alive and looks for cancel requests from other processes. */
  heartbeatMs?: number;
  /** A run whose host has not recorded a heartbeat for this long is treated as orphaned. */
  staleAfterMs?: number;
  isPidAlive?: (pid: number) => boolean;
  now?: () => Date;
  /** How executors wait (pacing, retries). Tests substitute an instant one. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
};

export type TaskInfo = { type: string; description: string; concurrency: number };

type RegisteredTask = {
  type: string;
  executor: TaskExecutor<unknown>;
  concurrency: number;
  params: ZodType<unknown> | undefined;
  description: string;
};

type ActiveRun = { id: string; type: string; controller: AbortController; done: Promise<void> };

function isTerminal(status: RunStatus): boolean {
  return TERMINAL_RUN_STATUSES.includes(status);
}

export class RunQueue {
  readonly hostPid: number;
  readonly hostName: string;
  /** The queue's own connection, used for run bookkeeping only. */
  readonly db: Db;
  private readonly workspaceProvider: () => Workspace;
  private readonly heartbeatMs: number;
  private readonly staleAfterMs: number;
  private readonly pidAlive: (pid: number) => boolean;
  private readonly now: () => Date;
  private readonly sleeper: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly tasks = new Map<string, RegisteredTask>();
  private readonly pending: string[] = [];
  private readonly active = new Map<string, ActiveRun>();
  private readonly listeners = new Map<string, Set<RunListener>>();
  private readonly seqs = new Map<string, number>();
  private readonly waiters = new Map<string, Array<(run: RunRecord) => void>>();
  private idleWaiters: Array<() => void> = [];
  private timer: NodeJS.Timeout | null = null;
  private stopping = false;

  constructor(options: RunQueueOptions) {
    this.db = options.db;
    this.workspaceProvider = options.workspace ?? freshWorkspace;
    this.hostPid = options.hostPid ?? process.pid;
    this.hostName = options.hostName ?? hostname();
    this.heartbeatMs = options.heartbeatMs ?? 15_000;
    this.staleAfterMs = options.staleAfterMs ?? 120_000;
    this.pidAlive = options.isPidAlive ?? defaultPidAlive;
    this.now = options.now ?? (() => new Date());
    this.sleeper = options.sleep ?? abortableSleep;
  }

  /**
   * Adds a run type. Other features register their own (liveness checks, inbox
   * sweeps, harvests) the same way the built-in discovery, prepare and submit
   * tasks are registered.
   */
  registerTask<P>(type: string, executor: TaskExecutor<P>, options: TaskOptions<P> = {}): void {
    if (!/^[a-z][a-z0-9_-]{0,39}$/.test(type)) {
      throw new AppError("invalid_task_type", `task type "${type}" must be lowercase letters, digits, "-" or "_"`);
    }
    if (this.tasks.has(type)) throw new AppError("task_type_exists", `a task named "${type}" is already registered`);
    this.tasks.set(type, {
      type,
      executor: executor as TaskExecutor<unknown>,
      concurrency: Math.max(1, Math.floor(options.concurrency ?? 1)),
      params: options.params as ZodType<unknown> | undefined,
      description: options.description ?? "",
    });
  }

  hasTask(type: string): boolean {
    return this.tasks.has(type);
  }

  taskTypes(): TaskInfo[] {
    return [...this.tasks.values()].map((task) => ({
      type: task.type,
      description: task.description,
      concurrency: task.concurrency,
    }));
  }

  /** Validates params, records the run as queued and starts it when a slot is free. Returns the run id. */
  enqueue(type: string, params: unknown = {}): string {
    if (this.stopping) throw new AppError("queue_stopping", "this host is shutting down and accepts no new runs");
    const task = this.tasks.get(type);
    if (!task) {
      const known = [...this.tasks.keys()].join(", ") || "none";
      throw new AppError("unknown_run_type", `no run type "${type}"; available: ${known}`);
    }
    const parsed = this.parseParams(task, params);
    const id = newId("run");
    insertRun(this.db, { id, type, params: parsed, createdAt: this.stamp(), hostPid: this.hostPid, hostName: this.hostName });
    this.pending.push(id);
    this.emitStatus(id);
    this.pump();
    return id;
  }

  /**
   * Cancels a run. A queued run is cancelled at once; a running one stops at
   * its next item boundary; a run hosted by another live process is flagged
   * and stopped by that process within one heartbeat.
   */
  cancel(id: string): CancelResult {
    const run = getRun(this.db, id);
    if (!run) throw new AppError("run_not_found", `no run ${id}`);
    if (isTerminal(run.status)) return { runId: id, outcome: "already_finished", status: run.status };

    const pendingIndex = this.pending.indexOf(id);
    if (pendingIndex >= 0) {
      this.pending.splice(pendingIndex, 1);
      finishRun(this.db, id, { status: "cancelled", finishedAt: this.stamp(), error: null });
      this.log(id, "warn", "Cancelled before it started.");
      this.settle(id);
      return { runId: id, outcome: "cancelled", status: "cancelled" };
    }

    const active = this.active.get(id);
    if (active) {
      if (!active.controller.signal.aborted) {
        this.log(id, "warn", "Cancel requested; stopping after the current item.");
        active.controller.abort(CANCEL_REASON);
      }
      return { runId: id, outcome: "signalled", status: "running" };
    }

    if (this.isOrphan(run)) {
      finishRun(this.db, id, {
        status: "cancelled",
        finishedAt: this.stamp(),
        error: "cancelled after its host process had already stopped",
      });
      this.log(id, "warn", "Cancelled; the process that hosted this run had already stopped.");
      this.settle(id);
      return { runId: id, outcome: "cancelled", status: "cancelled" };
    }

    requestRunCancel(this.db, id);
    return { runId: id, outcome: "requested", status: run.status };
  }

  /** Live events for one run, or for every run with "*". Returns an unsubscribe function. */
  subscribe(target: string, listener: RunListener): () => void {
    const set = this.listeners.get(target) ?? new Set<RunListener>();
    set.add(listener);
    this.listeners.set(target, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) this.listeners.delete(target);
    };
  }

  get(id: string): RunRecord | null {
    return getRun(this.db, id);
  }

  list(filter: RunListFilter = {}): RunRecord[] {
    return listRuns(this.db, filter);
  }

  logs(id: string, options: { afterSeq?: number; limit?: number } = {}): RunLogRecord[] {
    return listRunLogs(this.db, id, options);
  }

  /** The newest `limit` log lines, oldest first. */
  tail(id: string, limit = 200): RunLogRecord[] {
    return tailRunLogs(this.db, id, limit);
  }

  /** Whether this process is the one executing (or about to execute) the run. */
  isLocal(id: string): boolean {
    return this.active.has(id) || this.pending.includes(id);
  }

  activeRunIds(): string[] {
    return [...this.active.keys(), ...this.pending];
  }

  /** Resolves with the run once it reaches a final status. */
  wait(id: string, pollMs = 1000): Promise<RunRecord> {
    const run = getRun(this.db, id);
    if (!run) return Promise.reject(new AppError("run_not_found", `no run ${id}`));
    if (isTerminal(run.status)) return Promise.resolve(run);
    if (this.isLocal(id)) {
      return new Promise((resolve) => {
        this.waiters.set(id, [...(this.waiters.get(id) ?? []), resolve]);
      });
    }
    return new Promise((resolve) => {
      const timer = setInterval(() => {
        const current = getRun(this.db, id);
        if (!current || isTerminal(current.status)) {
          clearInterval(timer);
          resolve(current ?? run);
        }
      }, pollMs);
      timer.unref?.();
    });
  }

  /** Resolves when nothing is queued or running in this host. */
  whenIdle(): Promise<void> {
    if (this.active.size === 0 && this.pending.length === 0) return Promise.resolve();
    return new Promise((resolve) => {
      this.idleWaiters = [...this.idleWaiters, resolve];
    });
  }

  /**
   * Marks runs whose host died as interrupted: same machine with a dead pid,
   * or no heartbeat for staleAfterMs. Runs of a live host are left alone.
   */
  recover(): RunRecord[] {
    const now = this.now().getTime();
    const open = listRuns(this.db, { statuses: ["queued", "running"], limit: 1000 });
    const orphaned = open.filter((run) => !this.isLocal(run.id) && this.isOrphan(run, now));
    if (orphaned.length === 0) return [];
    const at = this.stamp();
    for (const run of orphaned) {
      markRunsInterrupted(this.db, [run.id], at, `host process ${run.hostPid} on ${run.hostName} stopped before the run finished`);
      this.log(run.id, "warn", "Marked interrupted: the process hosting this run is no longer running.");
      this.settle(run.id);
    }
    return orphaned.map((run) => getRun(this.db, run.id) ?? run);
  }

  /** Starts the heartbeat: liveness stamps, cross-process cancel requests and periodic recovery. */
  start(): void {
    if (this.timer || this.stopping) return;
    this.timer = setInterval(() => this.tick(), this.heartbeatMs);
    this.timer.unref?.();
  }

  /**
   * Stops accepting runs, interrupts queued ones and asks running ones to stop
   * after their current item, waiting up to `waitMs` before marking whatever is
   * still executing as interrupted.
   */
  async shutdown(waitMs = 10_000): Promise<void> {
    this.stopping = true;
    this.stopTimer();
    const at = this.stamp();
    for (const id of this.pending.splice(0)) {
      markRunsInterrupted(this.db, [id], at, "host shut down before the run started");
      this.log(id, "warn", "Interrupted: the host shut down before this run started.");
      this.settle(id);
    }
    for (const entry of this.active.values()) {
      if (!entry.controller.signal.aborted) {
        this.log(entry.id, "warn", "Host shutting down; stopping after the current item.");
        entry.controller.abort(SHUTDOWN_REASON);
      }
    }
    const running = [...this.active.values()].map((entry) => entry.done);
    if (running.length > 0) await Promise.race([Promise.allSettled(running), delay(waitMs)]);
    this.forceInterrupt();
  }

  /** Marks every run still executing here as interrupted, for a host that must exit now. */
  forceInterrupt(): void {
    const ids = [...this.active.keys()];
    if (ids.length === 0) return;
    markRunsInterrupted(this.db, ids, this.stamp(), "host exited while the run was still executing");
    for (const id of ids) {
      this.active.delete(id);
      this.settle(id);
    }
  }

  private stopTimer(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private tick(): void {
    try {
      const mine = this.activeRunIds();
      touchRunHeartbeats(this.db, mine, this.stamp());
      for (const id of cancelRequestedAmong(this.db, mine)) this.cancel(id);
      this.recover();
    } catch (error) {
      logger.warn("run queue heartbeat failed", { error: toErrorMessage(error) });
    }
  }

  private parseParams(task: RegisteredTask, params: unknown): unknown {
    if (!task.params) return params ?? {};
    const result = task.params.safeParse(params ?? {});
    if (result.success) return result.data;
    const issues = result.error.issues
      .slice(0, 8)
      .map((issue) => `${issue.path.join(".") || "params"}: ${issue.message}`);
    throw new AppError("invalid_run_params", `invalid params for a ${task.type} run: ${issues.join("; ")}`, { issues });
  }

  private isOrphan(run: RunRecord, now = this.now().getTime()): boolean {
    if (run.hostName === this.hostName && run.hostPid === this.hostPid) return !this.isLocal(run.id);
    if (run.hostName === this.hostName && !this.pidAlive(run.hostPid)) return true;
    const last = Date.parse(run.heartbeatAt ?? run.startedAt ?? run.createdAt);
    return Number.isFinite(last) && now - last > this.staleAfterMs;
  }

  private runningOf(type: string): number {
    return [...this.active.values()].filter((entry) => entry.type === type).length;
  }

  private pump(): void {
    if (this.stopping) return;
    for (const id of [...this.pending]) {
      const run = getRun(this.db, id);
      if (!run || run.status !== "queued") {
        this.pending.splice(this.pending.indexOf(id), 1);
        continue;
      }
      const task = this.tasks.get(run.type);
      if (!task || this.runningOf(run.type) >= task.concurrency) continue;
      this.pending.splice(this.pending.indexOf(id), 1);
      this.launch(run, task);
    }
  }

  private launch(run: RunRecord, task: RegisteredTask): void {
    const controller = new AbortController();
    markRunStarted(this.db, run.id, this.stamp());
    const entry: ActiveRun = { id: run.id, type: run.type, controller, done: Promise.resolve() };
    this.active.set(run.id, entry);
    this.emitStatus(run.id);
    this.log(run.id, "info", `Started ${run.type} run.`);
    entry.done = this.execute(run, task, controller);
  }

  private async execute(run: RunRecord, task: RegisteredTask, controller: AbortController): Promise<void> {
    const ctx = this.contextFor(run.id, controller.signal);
    let status: RunStatus = "succeeded";
    let summary: unknown = null;
    let error: string | null = null;
    try {
      // Executor code never runs inside enqueue(): callers get the id back first.
      await Promise.resolve();
      summary = (await task.executor(ctx, run.params)) ?? null;
      if (controller.signal.aborted) status = this.abortedStatus(controller.signal);
    } catch (thrown) {
      if (controller.signal.aborted || thrown instanceof RunCancelledError) {
        status = this.abortedStatus(controller.signal);
      } else {
        status = "failed";
        error = redact(toErrorMessage(thrown)).slice(0, MAX_MESSAGE_LENGTH);
      }
    }
    if (status === "interrupted") error = "host shut down before the run finished";
    // Recorded even after forceInterrupt(): an executor that finishes late still reports what really happened.
    this.recordFinish(run.id, status, summary, error);
    this.active.delete(run.id);
    this.log(run.id, status === "failed" ? "error" : status === "succeeded" ? "info" : "warn", this.finalLine(status, error));
    this.settle(run.id);
    this.pump();
  }

  private recordFinish(id: string, status: RunStatus, summary: unknown, error: string | null): void {
    const finishedAt = this.stamp();
    try {
      finishRun(this.db, id, { status, finishedAt, summary: sanitizeData(summary), error });
    } catch (thrown) {
      logger.error("could not record run result", { runId: id, error: toErrorMessage(thrown) });
      try {
        finishRun(this.db, id, { status, finishedAt, summary: null, error: error ?? "result could not be stored" });
      } catch {
        // The heartbeat-based recovery will mark it interrupted.
      }
    }
  }

  private finalLine(status: RunStatus, error: string | null): string {
    switch (status) {
      case "succeeded":
        return "Run finished.";
      case "cancelled":
        return "Run cancelled.";
      case "interrupted":
        return "Run interrupted: the host shut down.";
      default:
        return `Run failed: ${error ?? "unknown error"}`;
    }
  }

  private abortedStatus(signal: AbortSignal): RunStatus {
    return signal.reason === SHUTDOWN_REASON ? "interrupted" : "cancelled";
  }

  private contextFor(runId: string, signal: AbortSignal): TaskContext {
    const workspace = this.workspaceProvider;
    return {
      runId,
      signal,
      get workspace() {
        return workspace();
      },
      log: (level, message, data) => this.log(runId, level, message, data),
      progress: (done, total) => this.progress(runId, done, total),
      sleep: (ms) => this.sleeper(ms, signal),
      throwIfCancelled: () => {
        if (signal.aborted) throw new RunCancelledError();
      },
    };
  }

  private log(runId: string, level: RunLogLevel, message: string, data?: unknown): void {
    const record: RunLogRecord = {
      runId,
      seq: this.nextSeq(runId),
      ts: this.stamp(),
      level,
      message: redact(message).slice(0, MAX_MESSAGE_LENGTH),
      data: sanitizeData(data),
    };
    try {
      appendRunLog(this.db, record);
    } catch (error) {
      logger.warn("run log line not stored", { runId, error: toErrorMessage(error) });
    }
    this.emit({ kind: "log", runId, log: record });
  }

  private nextSeq(runId: string): number {
    const next = (this.seqs.get(runId) ?? lastRunLogSeq(this.db, runId)) + 1;
    this.seqs.set(runId, next);
    return next;
  }

  private progress(runId: string, done: number, total: number): void {
    const safeDone = Math.max(0, Math.floor(Number.isFinite(done) ? done : 0));
    const safeTotal = Math.max(safeDone, Math.floor(Number.isFinite(total) ? total : 0));
    try {
      updateRunProgress(this.db, runId, safeDone, safeTotal);
    } catch (error) {
      logger.warn("run progress not stored", { runId, error: toErrorMessage(error) });
    }
    this.emit({ kind: "progress", runId, done: safeDone, total: safeTotal });
  }

  private emitStatus(id: string): void {
    const run = getRun(this.db, id);
    if (run) this.emit({ kind: "status", runId: id, status: run.status, run });
  }

  private emit(event: RunEvent): void {
    for (const key of [event.runId, "*"]) {
      for (const listener of [...(this.listeners.get(key) ?? [])]) {
        try {
          listener(event);
        } catch (error) {
          logger.warn("run listener failed", { runId: event.runId, error: toErrorMessage(error) });
        }
      }
    }
  }

  private settle(id: string): void {
    this.emitStatus(id);
    this.seqs.delete(id);
    const run = getRun(this.db, id);
    const waiting = this.waiters.get(id) ?? [];
    this.waiters.delete(id);
    if (run) for (const resolve of waiting) resolve(run);
    if (this.active.size === 0 && this.pending.length === 0) {
      const idle = this.idleWaiters;
      this.idleWaiters = [];
      for (const resolve of idle) resolve();
    }
  }

  private stamp(): string {
    return this.now().toISOString();
  }
}
