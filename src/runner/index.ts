import { resolvePaths } from "../config/paths.js";
import { openDatabase } from "../db/database.js";
import { RunQueue, type RunQueueOptions } from "./queue.js";
import { registerBuiltinTasks } from "./tasks/index.js";

export { freshWorkspace } from "./workspace.js";

/**
 * The process-wide run queue.
 *
 * Hosted by whichever process creates it first: the dashboard CLI (durable) or
 * the MCP server, where runs live only as long as the client session that
 * started them. It keeps its own database connection so run bookkeeping works
 * even while configuration files are invalid or being edited.
 */

let instance: RunQueue | null = null;

export function createRunQueue(options: Partial<RunQueueOptions> = {}): RunQueue {
  const queue = new RunQueue({ db: options.db ?? openDatabase(resolvePaths().database), ...options });
  registerBuiltinTasks(queue);
  return queue;
}

/** Returns the shared queue, creating, recovering and starting it on first use. */
export function getRunQueue(): RunQueue {
  if (instance) return instance;
  const queue = createRunQueue();
  queue.recover();
  queue.start();
  instance = queue;
  return queue;
}

/** Replaces the shared queue (a host that built its own, or a test). */
export function setRunQueue(queue: RunQueue | null): void {
  instance = queue;
}
