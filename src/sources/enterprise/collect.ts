import type { z } from "zod";
import type { AtsKind, Company } from "../../domain/campaign.js";
import type { Job } from "../../domain/job.js";
import { AppError, toErrorMessage } from "../../util/errors.js";
import { logger } from "../../util/logger.js";

/** One listing page: the usable rows, and whether the source says more follow. */
export type Page<T> = { rows: readonly T[]; more: boolean };

/**
 * Validates listing rows one at a time. A row that does not match the schema
 * is skipped and logged; it never fails the page it arrived on.
 */
export function validRows<T>(
  schema: z.ZodType<T>,
  rows: readonly unknown[],
  context: { kind: AtsKind; company: Company },
): T[] {
  return rows.flatMap((row) => {
    const result = schema.safeParse(row);
    if (result.success) return [result.data];
    logger.warn("skipping unreadable posting row", {
      ats: context.kind,
      company: context.company.name,
      path: result.error.issues[0]?.path.map(String).join(".") ?? "",
    });
    return [];
  });
}

/** Hard stop for any walk, independent of what a source claims about its total. */
const MAX_PAGES = 1_000;

/** Whether an error is the source saying "slow down" (HTTP 429, after retries). */
function isRateLimited(error: unknown): boolean {
  return error instanceof AppError && error.details.status === 429;
}

/**
 * Walks a paginated listing until the source reports no more pages, a page
 * repeats rows already seen (the offset was ignored), or the cap is reached.
 *
 * A page whose rows were all unusable but which the source still calls
 * non-final is skipped rather than treated as the end, so one malformed page
 * cannot hide the rest of a board. When a source rate-limits a later page,
 * the walk stops and keeps what it already read instead of pressing on.
 */
export async function collectPages<T>(options: {
  cap: number;
  key: (row: T) => string;
  fetchPage: (index: number, collected: number) => Promise<Page<T>>;
}): Promise<T[]> {
  const seen = new Set<string>();
  const rows: T[] = [];
  for (let index = 0; index < MAX_PAGES && rows.length < options.cap; index += 1) {
    let page: Page<T>;
    try {
      page = await options.fetchPage(index, rows.length);
    } catch (error) {
      if (index === 0 || !isRateLimited(error)) throw error;
      logger.warn("listing rate-limited; keeping the pages already read", { pages: index, postings: rows.length });
      break;
    }
    const fresh = page.rows.filter((row) => {
      const key = options.key(row);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    rows.push(...fresh.slice(0, options.cap - rows.length));
    if (!page.more) break;
    if (page.rows.length > 0 && fresh.length === 0) break;
  }
  return rows;
}

/** What one per-posting read found: the detail, or that the ATS no longer has it. */
export type DetailResult<D> = { status: "ok"; detail: D } | { status: "gone" };

export type WithDetail<T, D> = { row: T; detail: D | null };

/**
 * Reads per-posting detail for the first `limit` rows, one request at a time.
 *
 * A failed read keeps the row with only the listing's fields: one dead posting
 * must never lose the rest of the board. A posting the ATS reports gone
 * between the listing and the read is dropped. Once the source rate-limits,
 * no further detail is requested and the remaining rows keep listing fields.
 */
export async function withDetails<T, D>(
  rows: readonly T[],
  limit: number,
  read: (row: T) => Promise<DetailResult<D>>,
  context: { kind: AtsKind; company: Company },
): Promise<WithDetail<T, D>[]> {
  const out: WithDetail<T, D>[] = [];
  let throttled = false;
  for (const [index, row] of rows.entries()) {
    if (index >= limit || throttled) {
      out.push({ row, detail: null });
      continue;
    }
    try {
      const result = await read(row);
      if (result.status === "ok") out.push({ row, detail: result.detail });
    } catch (error) {
      throttled = isRateLimited(error);
      logger.warn(throttled ? "posting details rate-limited; keeping listing fields for the rest" : "posting detail failed; keeping listing fields", {
        ats: context.kind,
        company: context.company.name,
        error: toErrorMessage(error),
      });
      out.push({ row, detail: null });
    }
  }
  return out;
}

/** Normalizes each row on its own so one malformed posting cannot fail the board. */
export function normalizeEach<T>(
  rows: readonly T[],
  build: (row: T) => Job | null,
  context: { kind: AtsKind; company: Company },
): Job[] {
  return rows.flatMap((row) => {
    try {
      const job = build(row);
      return job && job.title.length > 0 ? [job] : [];
    } catch (error) {
      logger.warn("skipping malformed posting", {
        ats: context.kind,
        company: context.company.name,
        error: toErrorMessage(error),
      });
      return [];
    }
  });
}
