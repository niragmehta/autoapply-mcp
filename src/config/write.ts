import { copyFileSync, existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { AppError } from "../util/errors.js";

/**
 * Atomic edits to the candidate's JSON configuration files.
 *
 * profile.json and campaign.json are hand-edited as well as written by tools,
 * the dashboard and the run queue. A process dying mid-write would leave a
 * truncated file the server then refuses to load, so every write is staged to a
 * temporary file and renamed into place. A dated backup can be kept first,
 * because a profile that took an hour to write is worth one extra copy.
 */

/** Reads a JSON file, tolerating the byte-order mark some Windows editors add. */
export function readJsonFile(path: string): unknown {
  if (!existsSync(path)) throw new AppError("config_missing", `${path} does not exist`, { path });
  try {
    return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new AppError("config_invalid_json", `${path} is not valid JSON: ${String(error)}`, { path });
  }
}

export type WriteOptions = {
  /** Copy the current file to `<path>.bak-<timestamp>` before replacing it. */
  backup?: boolean;
  now?: Date;
};

/** Writes pretty-printed JSON via a staged file and rename. Returns the backup path, if one was made. */
export function writeJsonAtomic(path: string, value: unknown, options: WriteOptions = {}): string | null {
  let backupPath: string | null = null;
  if (options.backup && existsSync(path)) {
    const stamp = (options.now ?? new Date()).toISOString().replace(/[-:]/g, "").replace(/\..*$/, "");
    backupPath = `${path}.bak-${stamp}`;
    copyFileSync(path, backupPath);
  }
  const staged = `${path}.tmp`;
  // UTF-8 without a byte-order mark: the loader would reject one.
  writeFileSync(staged, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(staged, path);
  return backupPath;
}

/**
 * Reads, transforms and writes a JSON file in one step. `mutate` receives a
 * copy and returns the new value; validate the result before returning it.
 */
export function updateJsonFile<T>(path: string, mutate: (current: T) => T, options: WriteOptions = {}): { value: T; backupPath: string | null } {
  const current = structuredClone(readJsonFile(path)) as T;
  const value = mutate(current);
  const backupPath = writeJsonAtomic(path, value, options);
  return { value, backupPath };
}
