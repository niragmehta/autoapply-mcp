import { toErrorMessage } from "../../util/errors.js";
import { logger } from "../../util/logger.js";

/**
 * Per-board ceiling on per-posting detail requests.
 *
 * Several SMB boards list titles only and keep descriptions, dates and pay on a
 * second endpoint. A small company rarely publishes more than a few dozen
 * roles, but an unbounded loop would turn one unusually large board into
 * hundreds of requests; narrow with `company.query` rather than raising this.
 */
export function detailLimit(): number {
  const raw = Number.parseInt(process.env.AUTOAPPLY_SMB_DETAIL_LIMIT ?? "", 10);
  return Number.isFinite(raw) && raw >= 0 ? Math.min(raw, 1000) : 100;
}

export type Enriched<T, D> = { item: T; detail: D | null };

/**
 * Reads details for the first `limit` items, one request at a time.
 *
 * A failed or empty detail keeps the item with `detail: null`: one unreadable
 * posting must never lose the rest of the board. Items past the limit are kept
 * with no detail too, so the board is still complete, just less rich.
 */
export async function withDetails<T, D>(
  items: readonly T[],
  read: (item: T) => Promise<D | null>,
  context: { ats: string; board: string },
  limit = detailLimit(),
): Promise<Array<Enriched<T, D>>> {
  let results: Array<Enriched<T, D>> = [];
  for (const [index, item] of items.entries()) {
    if (index >= limit) {
      results = [...results, { item, detail: null }];
      continue;
    }
    try {
      results = [...results, { item, detail: await read(item) }];
    } catch (error) {
      logger.warn("posting detail failed; keeping the listing row", { ...context, error: toErrorMessage(error) });
      results = [...results, { item, detail: null }];
    }
  }
  if (items.length > limit) {
    logger.warn("posting detail limit reached; later postings keep listing data only", {
      ...context, postings: items.length, limit,
    });
  }
  return results;
}

/** Normalizes each item, skipping (and logging) any that cannot be read. */
export function mapEach<T, R>(items: readonly T[], map: (item: T) => R | null, context: { ats: string; board: string }): R[] {
  let results: R[] = [];
  for (const item of items) {
    try {
      const mapped = map(item);
      if (mapped !== null) results = [...results, mapped];
    } catch (error) {
      logger.warn("skipping unreadable posting", { ...context, error: toErrorMessage(error) });
    }
  }
  return results;
}
