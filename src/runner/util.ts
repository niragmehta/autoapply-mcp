import { redact } from "../text/redact.js";
import { RunCancelledError } from "./types.js";

/** Small helpers shared by the run queue and its tasks. */

export function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Resolves after `ms`, or rejects with RunCancelledError once `signal` aborts. */
export function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new RunCancelledError());
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new RunCancelledError());
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, Math.max(0, ms));
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** A timer that never keeps the process alive on its own. */
export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

/** Log data and summaries must be JSON, and are redacted like every other stored record. */
export function sanitizeData(data: unknown): unknown {
  if (data === undefined || data === null) return null;
  try {
    const text = redact(JSON.stringify(data));
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return { redacted: text };
    }
  } catch {
    return { note: "unserialisable data" };
  }
}

export function chunk<T>(items: readonly T[], size: number): T[][] {
  const step = Math.max(1, Math.floor(size));
  const out: T[][] = [];
  for (let index = 0; index < items.length; index += step) out.push(items.slice(index, index + step));
  return out;
}
