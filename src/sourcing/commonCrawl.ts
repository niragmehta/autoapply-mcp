import type { Company } from "../domain/campaign.js";
import type { Db } from "../db/database.js";
import {
  allHarvestedBoards,
  finishHarvestRun,
  HARVEST_ATS,
  insertHarvestedBoards,
  startHarvestRun,
  type HarvestAts,
  type HarvestedBoardInput,
} from "../db/repositories/harvest.js";
import { toErrorMessage } from "../util/errors.js";
import {
  abortableSleep,
  boardFromCrawlUrl,
  cdxPage,
  cdxPageCount,
  harvestKey,
  HARVEST_QUERIES,
  isAbort,
  listCrawlIndexes,
  type CdxClientOptions,
} from "./ccIndex.js";

/**
 * Board harvesting from the Common Crawl URL index.
 *
 * Lists every Greenhouse, Ashby, Lever and Workday board the recent crawls
 * captured, drops the ones companies.json already tracks or an earlier harvest
 * already found, and records the rest in harvested_boards for scanning. Each
 * page's boards are stored as soon as the page is read, so a cancelled or
 * failed run keeps what it reached. A full harvest takes tens of minutes, which
 * is why it runs from the CLI or the run queue rather than an MCP tool call.
 */

export type HarvestOptions = CdxClientOptions & {
  db: Db;
  companies: readonly Company[];
  ats?: readonly HarvestAts[];
  /** How many of the newest crawl indexes to read. */
  indexes?: number;
  /** Explicit index ids, e.g. CC-MAIN-2026-43; overrides `indexes`. */
  indexIds?: readonly string[];
  /** Safety cap on pages read per query. */
  maxPages?: number;
};

export type HarvestProgress = {
  stage: "indexes" | "query" | "page" | "retry" | "done";
  message: string;
  index?: string;
  ats?: HarvestAts;
  page?: number;
  pages?: number;
};

export type HarvestSummary = {
  runId: string;
  indexes: string[];
  pagesRead: number;
  urls: number;
  added: number;
  /** Distinct boards seen in the crawl, and how many of them were new. */
  byAts: Record<string, { seen: number; added: number }>;
  errors: string[];
  aborted: boolean;
};

type Counted = HarvestedBoardInput & { key: string };

/** Keys already known: tracked companies (Workday by tenant) and every earlier harvest. */
export function knownBoardKeys(db: Db, companies: readonly Company[]): Set<string> {
  const keys = new Set<string>();
  for (const company of companies) keys.add(harvestKey(company.ats, company.board));
  for (const board of allHarvestedBoards(db)) keys.add(harvestKey(board.ats, board.board));
  return keys;
}

/** Counts boards on a page; Workday keeps the most-cited site per tenant. */
function collect(urls: readonly string[], ats: HarvestAts, sourceIndex: string, into: Map<string, Counted>): void {
  for (const url of urls) {
    const board = boardFromCrawlUrl(url);
    if (!board || board.ats !== ats) continue;
    const exact = `${board.ats}:${board.board.toLowerCase()}`;
    const current = into.get(exact);
    if (current) current.hits += 1;
    else into.set(exact, { ...board, hits: 1, sourceIndex, key: harvestKey(board.ats, board.board) });
  }
}

function bestPerKey(found: Map<string, Counted>, known: ReadonlySet<string>): Counted[] {
  const best = new Map<string, Counted>();
  for (const board of found.values()) {
    if (known.has(board.key)) continue;
    const current = best.get(board.key);
    if (!current || board.hits > current.hits) best.set(board.key, board);
  }
  return [...best.values()];
}

export async function harvestBoards(
  options: HarvestOptions,
  onProgress: (progress: HarvestProgress) => void = () => undefined,
  signal?: AbortSignal,
): Promise<HarvestSummary> {
  const ats = options.ats && options.ats.length > 0 ? [...new Set(options.ats)] : [...HARVEST_ATS];
  const client: CdxClientOptions = { ...options, onRetry: (detail) => onProgress({ stage: "retry", message: detail }) };
  const sleep = options.sleep ?? abortableSleep;
  const runId = startHarvestRun(options.db, "harvest", { ats, indexes: options.indexIds ?? options.indexes ?? 1, maxPages: options.maxPages ?? null });
  const summary: HarvestSummary = { runId, indexes: [], pagesRead: 0, urls: 0, added: 0, byAts: {}, errors: [], aborted: false };
  const known = knownBoardKeys(options.db, options.companies);
  const tally = (name: HarvestAts) => (summary.byAts[name] ??= { seen: 0, added: 0 });
  const seen = new Map<HarvestAts, Set<string>>();
  const seenBoards = (name: HarvestAts) => {
    const set = seen.get(name) ?? new Set<string>();
    seen.set(name, set);
    return set;
  };

  const store = (name: HarvestAts, found: Map<string, Counted>) => {
    const fresh = bestPerKey(found, known);
    const added = insertHarvestedBoards(options.db, fresh.map(({ key: _key, ...board }) => board));
    for (const board of fresh) known.add(board.key);
    tally(name).added += added;
    summary.added += added;
    return added;
  };

  try {
    const indexIds = options.indexIds && options.indexIds.length > 0
      ? [...options.indexIds]
      : (await listCrawlIndexes(client, signal)).slice(0, Math.max(1, options.indexes ?? 1)).map((index) => index.id);
    summary.indexes = indexIds;
    onProgress({ stage: "indexes", message: `reading ${indexIds.join(", ")} for ${ats.join(", ")}` });

    for (const indexId of indexIds) {
      for (const name of ats) {
        for (const query of HARVEST_QUERIES[name]) {
          let pages: number;
          try {
            pages = await cdxPageCount(indexId, query, client, signal);
          } catch (error) {
            if (isAbort(error)) throw error;
            summary.errors.push(`${indexId} ${query.url}: ${toErrorMessage(error)}`);
            continue;
          }
          const limit = Math.min(pages, options.maxPages ?? pages);
          onProgress({ stage: "query", message: `${indexId} ${query.url}: ${pages} page(s)${limit < pages ? `, reading ${limit}` : ""}`, index: indexId, ats: name, pages: limit });
          // Workday sites are compared per tenant, so a whole query is gathered before storing.
          const pending = new Map<string, Counted>();
          try {
            for (let page = 0; page < limit; page += 1) {
              if (page > 0) await sleep(options.pageDelayMs ?? 1_500, signal);
              let urls: string[];
              try {
                urls = await cdxPage(indexId, query, page, client, signal);
              } catch (error) {
                if (isAbort(error)) throw error;
                summary.errors.push(`${indexId} ${query.url} page ${page}: ${toErrorMessage(error)}`);
                continue;
              }
              summary.pagesRead += 1;
              summary.urls += urls.length;
              collect(urls, name, indexId, pending);
              for (const exact of pending.keys()) seenBoards(name).add(exact);
              tally(name).seen = seenBoards(name).size;
              const added = name === "workday" ? 0 : store(name, pending);
              if (name !== "workday") pending.clear();
              onProgress({
                stage: "page",
                message: `${indexId} ${query.url} page ${page + 1}/${limit}: ${urls.length} URLs${name === "workday" ? "" : `, ${added} new board(s)`}`,
                index: indexId,
                ats: name,
                page: page + 1,
                pages: limit,
              });
            }
          } finally {
            if (name === "workday" && pending.size > 0) store(name, pending);
          }
        }
      }
    }
  } catch (error) {
    if (!isAbort(error)) {
      summary.errors.push(toErrorMessage(error));
      finishHarvestRun(options.db, runId, "failed", summary);
      onProgress({ stage: "done", message: `harvest failed: ${toErrorMessage(error)}` });
      return summary;
    }
    summary.aborted = true;
  }
  finishHarvestRun(options.db, runId, summary.aborted ? "aborted" : "done", summary);
  onProgress({ stage: "done", message: `${summary.aborted ? "cancelled" : "done"}: ${summary.added} new board(s) from ${summary.pagesRead} page(s)` });
  return summary;
}
