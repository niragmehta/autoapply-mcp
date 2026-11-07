import type { Company } from "../domain/campaign.js";
import type { Job } from "../domain/job.js";
import { AppError } from "../util/errors.js";
import { logger } from "../util/logger.js";
import { fetchJson, fetchText } from "./http.js";
import { normalizeJob } from "./normalize.js";
import { boardVerification, parseSourcePayload } from "./sourceValidation.js";
import type { PostingCheck, PostingRef, SourceAdapter } from "./types.js";
import { boardSegments, hostname, invalidBoard } from "./enterprise/boards.js";
import { checkFromError, closedCheck, httpStatus, openCheck, unknownCheck, unparseableBoardCheck } from "./enterprise/checks.js";
import { collectPages, normalizeEach, withDetails } from "./enterprise/collect.js";
import type { DetailResult } from "./enterprise/collect.js";
import { soleCountry, trailingCountry } from "./enterprise/country.js";
import { usDate } from "./enterprise/dates.js";
import type { JobPostingFields } from "./enterprise/jobPosting.js";
import { maxDetails, maxPostings } from "./enterprise/limits.js";
import {
  csbLocations, csbPageSchema, csbRow, csbSlug, isSuccessFactorsErrorPage, parseSuccessFactorsPosting, parseSuccessFactorsTiles,
} from "./enterprise/successFactorsPage.js";
import type { CsbRow, SuccessFactorsTile } from "./enterprise/successFactorsPage.js";

/**
 * SAP SuccessFactors Recruiting Marketing (RMK) career sites, usually on the
 * employer's own domain. Endpoint behaviour adapted from career-ops (MIT).
 *
 * Board: the career-site host, e.g. "jobs.zf.com", read off
 * https://jobs.zf.com/search/. A site that serves several brands from one
 * host adds the brand path: "careers.example.com/Brand".
 *
 * RMK lists postings as an HTML tile fragment (title, path, sometimes city and
 * date) and keeps descriptions on each job page. Newer Career Site Builder
 * (CSB) sites answer the tile endpoint with an empty shell and list through a
 * JSON search API instead; those are read in the en_US locale, and their job
 * pages render client-side, so they carry no description.
 */

const KIND = "successfactors" as const;
const PATH_SEGMENT = /^[A-Za-z0-9_-]{1,60}$/;
const CSB_LOCALE = "en_US";
const CSB_PAGE_SIZE = 10;
const RMK_POSTING_PATH = /^((?:\/[A-Za-z0-9_-]+)*)\/job\/[^/]+\/(\d{3,20})\/?$/;
const CSB_POSTING_PATH = /^((?:\/[A-Za-z0-9_-]+)*)\/job\/[^/]+\/(\d{1,20})-([a-z]{2}_[A-Z]{2})\/?$/;
const EXPECTED = 'the career-site host (e.g. jobs.zf.com), plus a brand path when the site has one, read off https://<host>/search/';

export type SuccessFactorsBoard = { host: string; prefix: string };

export function parseSuccessFactorsBoard(board: string): SuccessFactorsBoard {
  const [first, ...rest] = boardSegments(board);
  const host = first ? hostname(first) : null;
  if (!host || rest.length > 2 || !rest.every((segment) => PATH_SEGMENT.test(segment))) {
    throw invalidBoard(KIND, board, EXPECTED, (url) => hostname(url.hostname));
  }
  return { host, prefix: rest.map((segment) => `/${segment}`).join("") };
}

function origin(board: SuccessFactorsBoard): string {
  return `https://${board.host}${board.prefix}`;
}

export function successFactorsTilesUrl(board: SuccessFactorsBoard, query: string, startRow: number): string {
  const search = new URLSearchParams({ q: query.trim(), sortColumn: "referencedate", sortDirection: "desc", startrow: String(startRow) });
  return `${origin(board)}/tile-search-results/?${search}`;
}

function csbUrl(board: SuccessFactorsBoard): string {
  return `${origin(board)}/services/recruiting/v1/jobs`;
}

/** A URL on the board's own host, or null for anything that would leave it. */
function onBoard(board: SuccessFactorsBoard, path: string): string | null {
  try {
    const url = new URL(path, `https://${board.host}`);
    return url.hostname === board.host ? `https://${board.host}${url.pathname}` : null;
  } catch {
    return null;
  }
}

async function readTiles(board: SuccessFactorsBoard, query: string, startRow: number): Promise<SuccessFactorsTile[]> {
  return parseSuccessFactorsTiles(await fetchText(successFactorsTilesUrl(board, query, startRow), { allowedHosts: [board.host] }));
}

async function readCsbPage(board: SuccessFactorsBoard, query: string, page: number) {
  const payload = parseSourcePayload(csbPageSchema, await fetchJson<unknown>(csbUrl(board), {
    allowedHosts: [board.host],
    body: { keywords: query.trim(), locale: CSB_LOCALE, location: "", pageNumber: page, sortBy: "date" },
  }), "SuccessFactors CSB");
  const rows = payload.jobSearchResult.map(csbRow).filter((row): row is CsbRow => row !== null);
  return { raw: payload.jobSearchResult.length, rows, total: payload.totalJobs ?? null };
}

/** The job page; `gone` when RMK answers 404/410 or redirects to its error page. */
async function readPosting(board: SuccessFactorsBoard, url: string): Promise<DetailResult<JobPostingFields>> {
  let html: string;
  try {
    html = await fetchText(url, { allowedHosts: [board.host] });
  } catch (error) {
    const status = httpStatus(error);
    if (status === 404 || status === 410) return { status: "gone" };
    throw error;
  }
  const posting = parseSuccessFactorsPosting(html);
  if (posting) return { status: "ok", detail: posting };
  if (isSuccessFactorsErrorPage(html)) return { status: "gone" };
  throw new AppError("unreadable_posting", "SuccessFactors job page carried no posting data");
}

function tileJob(company: Company, url: string, tile: SuccessFactorsTile, detail: JobPostingFields | null, capturedAt: string): Job {
  const locations = detail && detail.locations.length > 0 ? detail.locations : [tile.location].filter(Boolean);
  return normalizeJob({
    company,
    externalId: tile.id,
    title: detail?.title || tile.title,
    locations,
    url,
    applyUrl: url,
    descriptionHtml: detail?.descriptionHtml ?? "",
    postedAt: detail?.postedAt ?? tile.postedAt,
    isRemote: locations.some((value) => /\bremote\b/i.test(value)),
    employmentType: detail?.employmentType,
    structuredCompensation: detail?.compensation ?? null,
    country: detail?.country,
  }, capturedAt);
}

function csbJob(company: Company, board: SuccessFactorsBoard, row: CsbRow, capturedAt: string): Job {
  const url = `${origin(board)}/job/${csbSlug(row)}/${row.id}-${CSB_LOCALE}`;
  const locations = csbLocations(row);
  return normalizeJob({
    company,
    externalId: row.id,
    title: (row.unifiedStandardTitle ?? row.jobTitle ?? "").trim(),
    locations,
    url,
    applyUrl: url,
    postedAt: usDate(row.unifiedStandardStart),
    isRemote: locations.some((value) => /\bremote\b/i.test(value)),
    country: soleCountry(locations.map(trailingCountry)),
  }, capturedAt);
}

async function listCsb(company: Company, board: SuccessFactorsBoard, capturedAt: string): Promise<Job[]> {
  const rows = await collectPages<CsbRow>({
    cap: maxPostings(KIND),
    key: (row) => row.id,
    fetchPage: async (index) => {
      const page = await readCsbPage(board, company.query, index);
      const more = page.raw > 0 && (page.total === null ? page.raw >= CSB_PAGE_SIZE : (index + 1) * CSB_PAGE_SIZE < page.total);
      return { rows: page.rows, more };
    },
  });
  return normalizeEach(rows, (row) => csbJob(company, board, row, capturedAt), { kind: KIND, company });
}

/** CSB job pages render client-side, so an open CSB posting is confirmed by finding it in search. */
async function checkCsb(board: SuccessFactorsBoard, job: Job, id: string): Promise<PostingCheck> {
  const page = await readCsbPage(board, job.title, 0);
  return page.rows.some((row) => row.id === id)
    ? openCheck("the career site's search still lists the posting", "api")
    : unknownCheck("the posting did not appear in a title search; CSB pages cannot confirm closure", "api");
}

export const successFactorsAdapter: SourceAdapter = {
  kind: KIND,

  listUrl(company: Company): string {
    return successFactorsTilesUrl(parseSuccessFactorsBoard(company.board), company.query, 0);
  },

  boardUrl(company: Company): string {
    return `${origin(parseSuccessFactorsBoard(company.board))}/search/`;
  },

  async listJobs(company: Company, capturedAt: string): Promise<Job[]> {
    const board = parseSuccessFactorsBoard(company.board);
    let pageSize = 0;
    const tiles = await collectPages<SuccessFactorsTile>({
      cap: maxPostings(KIND),
      key: (tile) => tile.id,
      fetchPage: async (index, collected) => {
        const rows = await readTiles(board, company.query, collected);
        if (index === 0) pageSize = rows.length;
        // Page sizes are per tenant (25, 100); a page shorter than the first is the last.
        return { rows, more: rows.length > 0 && rows.length >= pageSize };
      },
    });
    if (tiles.length === 0) {
      try {
        return await listCsb(company, board, capturedAt);
      } catch (error) {
        // The tile endpoint answered, so the board is reachable and may simply be empty.
        logger.debug("successfactors CSB search unavailable", { company: company.name, error: String(error) });
        return [];
      }
    }
    const context = { kind: KIND, company };
    const located = tiles.flatMap((tile) => {
      const url = onBoard(board, tile.path);
      return url ? [{ tile, url }] : [];
    });
    const detailed = await withDetails(located, maxDetails(KIND), ({ url }) => readPosting(board, url), context);
    return normalizeEach(detailed, ({ row, detail }) => tileJob(company, row.url, row.tile, detail, capturedAt), context);
  },

  async verifyBoard(company: Company) {
    const board = parseSuccessFactorsBoard(company.board);
    const tiles = await readTiles(board, company.query, 0);
    if (tiles.length > 0) return boardVerification(tiles.map((tile) => tile.title));
    const page = await readCsbPage(board, company.query, 0);
    return boardVerification(page.rows.map((row) => (row.unifiedStandardTitle ?? row.jobTitle ?? "").trim()).filter(Boolean), page.total ?? page.rows.length);
  },

  probeUrls(): string[] {
    return [];
  },

  parsePostingUrl(url: URL): PostingRef | null {
    const host = hostname(url.hostname);
    const match = RMK_POSTING_PATH.exec(url.pathname);
    if (!host || !match) return null;
    return { board: `${host}${match[1] ?? ""}`, externalId: match[2]! };
  },

  async fetchPosting(company: Company, externalId: string, capturedAt: string): Promise<Job | null> {
    const board = parseSuccessFactorsBoard(company.board);
    if (!/^\d{1,20}$/.test(externalId)) {
      throw new AppError("invalid_posting_id", `SuccessFactors posting id must be numeric, got: ${externalId}`);
    }
    // RMK keys job pages on the id; the slug before it is cosmetic.
    const url = `${origin(board)}/job/job/${externalId}/`;
    const result = await readPosting(board, url);
    if (result.status === "gone") return null;
    const tile: SuccessFactorsTile = { id: externalId, path: "", title: result.detail.title, location: "", postedAt: null };
    return tileJob(company, url, tile, result.detail, capturedAt);
  },

  async checkPosting(job: Job): Promise<PostingCheck> {
    let board: SuccessFactorsBoard;
    try {
      board = parseSuccessFactorsBoard(job.board);
    } catch (error) {
      return unparseableBoardCheck(error);
    }
    let path = "";
    try {
      path = new URL(job.url).pathname;
    } catch {
      return unknownCheck("the stored posting URL does not parse", "page");
    }
    const csb = CSB_POSTING_PATH.exec(path);
    if (!csb && !RMK_POSTING_PATH.test(path)) return unknownCheck("the stored posting URL is not a SuccessFactors job page", "page");
    try {
      if (csb) return await checkCsb(board, job, csb[2]!);
      const url = onBoard(board, path);
      if (!url) return unknownCheck("the stored posting URL is not on the board's host", "page");
      const result = await readPosting(board, url);
      return result.status === "gone"
        ? closedCheck("the career site sends the posting to its error page", "page")
        : openCheck("the job page still shows the posting", "page");
    } catch (error) {
      return checkFromError(error, csb ? "api" : "page", false);
    }
  },
};
