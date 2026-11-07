import type { Workspace } from "../config/load.js";
import type { Db } from "../db/database.js";
import type { RunQueue } from "../runner/queue.js";

/** What every API handler can reach. */
export type DashboardContext = {
  readonly queue: RunQueue;
  /** The run queue's own connection; usable even when configuration is invalid. */
  readonly db: Db;
  /** The workspace with current configuration; throws a config AppError when a file is invalid. */
  workspace(): Workspace;
  readonly startedAt: string;
  readonly version: string;
  readonly host: string;
  port(): number;
};
