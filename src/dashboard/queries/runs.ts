import type { RunRecord } from "../../db/repositories/runs.js";

/**
 * Run summaries as the dashboard shows them. A submit run skips a posting
 * confirmed closed with code "posting_closed" on the item; this counts those
 * items as `postingClosed`, so run lists can say how many were closed without
 * reading every item.
 */

export const POSTING_CLOSED = "posting_closed";

type Summary = Record<string, unknown> & { items?: unknown };

/** Adds a `postingClosed` count to a submit run's summary, from the items' own codes. */
export function annotateRun(run: RunRecord): RunRecord {
  if (run.type !== "submit") return run;
  const summary = run.summary as Summary | null;
  if (!summary || typeof summary !== "object" || !Array.isArray(summary.items)) return run;
  const postingClosed = (summary.items as unknown[]).filter(
    (item) => typeof item === "object" && item !== null && (item as { code?: unknown }).code === POSTING_CLOSED,
  ).length;
  return { ...run, summary: { ...summary, postingClosed } };
}
