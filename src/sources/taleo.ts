import { z } from "zod";
import type { Company } from "../domain/campaign.js";
import type { Job } from "../domain/job.js";
import { AppError } from "../util/errors.js";
import { fetchJson, fetchText } from "./http.js";
import { normalizeJob } from "./normalize.js";
import { boardVerification, parseSourcePayload } from "./sourceValidation.js";
import type { PostingCheck, PostingRef, SourceAdapter } from "./types.js";
import { boardSegments, hostname, invalidBoard } from "./enterprise/boards.js";
import { checkFromError, closedCheck, httpStatus, openCheck, unknownCheck, unparseableBoardCheck } from "./enterprise/checks.js";
import { collectPages, normalizeEach, validRows, withDetails } from "./enterprise/collect.js";
import type { DetailResult } from "./enterprise/collect.js";
import { soleCountry, trailingCountry } from "./enterprise/country.js";
import { anyDate } from "./enterprise/dates.js";
import { maxDetails, maxPostings } from "./enterprise/limits.js";
import { inlineText } from "./enterprise/markup.js";
import { isTaleoUnavailable, parseTaleoDetail, taleoHeadings, taleoLocationCell, taleoPortal } from "./enterprise/taleoPage.js";
import type { TaleoDetail } from "./enterprise/taleoPage.js";

/**
 * Taleo Enterprise Edition public career sections. Endpoint behaviour adapted
 * from career-ops (MIT).
 *
 * Board: "<host>/<career section>", e.g. "hdr.taleo.net/ex", read off
 * https://hdr.taleo.net/careersection/ex/jobsearch.ftl. Taleo Business
 * Edition (tbe.taleo.net) is a different product and is not supported.
 *
 * Each listing first reads the section's search page for its portal number
 * and column layout, then replays the anonymous JSON search the page itself
 * makes. Results carry title, location and date columns only; descriptions
 * come from each job page, one request per posting.
 */

const KIND = "taleo" as const;
const SECTION = /^[A-Za-z0-9._-]{1,60}$/;
const CONTEST = /^[A-Za-z0-9._-]{1,40}$/;
const EXPECTED = '"host/careersection" (e.g. hdr.taleo.net/ex), read off https://<host>/careersection/<section>/jobsearch.ftl';
/** The search API answers 500 without these XHR headers. */
const XHR_HEADERS = { "x-requested-with": "XMLHttpRequest", tz: "GMT+00:00", tzname: "UTC" };

export type TaleoBoard = { host: string; section: string };

function isTaleoHost(host: string): boolean {
  return host.endsWith(".taleo.net") && !host.endsWith(".tbe.taleo.net") && host !== "tre.taleo.net";
}

function sectionOf(url: URL): TaleoBoard | null {
  const host = hostname(url.hostname);
  const section = /^\/careersection\/([^/]+)\/[a-z]+\.ftl$/i.exec(url.pathname)?.[1];
  return host && isTaleoHost(host) && section && SECTION.test(section) ? { host, section } : null;
}

export function parseTaleoBoard(board: string): TaleoBoard {
  const parts = boardSegments(board);
  const host = parts.length === 2 ? hostname(parts[0]!) : null;
  const section = parts[1] ?? "";
  if (!host || !isTaleoHost(host) || !SECTION.test(section)) {
    throw invalidBoard(KIND, board, EXPECTED, (url) => {
      const found = sectionOf(url);
      return found ? `${found.host}/${found.section}` : null;
    });
  }
  return { host, section };
}

function searchPageUrl(board: TaleoBoard): string {
  return `https://${board.host}/careersection/${board.section}/jobsearch.ftl?lang=en`;
}

export function taleoPostingUrl(board: TaleoBoard, contestNo: string): string {
  return `https://${board.host}/careersection/${board.section}/jobdetail.ftl?${new URLSearchParams({ job: contestNo, lang: "en" })}`;
}

function searchBody(query: string, pageNo: number) {
  return {
    multilineEnabled: false,
    sortingSelection: { sortBySelectionParam: "3", ascendingSortingOrder: "false" },
    fieldData: { fields: { KEYWORD: query.trim(), LOCATION: "" }, valid: true },
    filterSelectionParam: { searchFilterSelections: [] },
    advancedSearchFiltersSelectionParam: { searchFilterSelections: [] },
    pageNo,
  };
}

const rowSchema = z.object({
  contestNo: z.union([z.string(), z.number()]).transform((value) => String(value).trim()).pipe(z.string().regex(CONTEST)),
  jobId: z.union([z.string(), z.number()]).nullish(),
  column: z.array(z.unknown()),
  linkedColumn: z.number().int().nonnegative().nullish(),
  locationsColumns: z.array(z.number()).nullish(),
});
type Row = z.infer<typeof rowSchema>;

const pageSchema = z.object({
  requisitionList: z.array(z.unknown()),
  pagingData: z.object({ totalCount: z.union([z.number(), z.string()]).nullish(), pageSize: z.number().nullish() }).nullish(),
});

export type TaleoListing = { contestNo: string; title: string; locations: string[]; postedAt: string | null };

function cell(row: Row, index: number): string {
  const value = row.column[index];
  return typeof value === "string" || typeof value === "number" ? String(value) : "";
}

/**
 * Maps the result columns by their headings. The title falls back to the
 * column Taleo links to the job page, and locations come from the columns
 * Taleo itself marks as locations.
 */
function toListing(row: Row, headings: readonly string[]): TaleoListing | null {
  const find = (pattern: RegExp, fallback: number) => {
    const index = headings.findIndex((heading) => pattern.test(heading));
    return index >= 0 ? index : fallback;
  };
  const title = inlineText(cell(row, find(/title/i, row.linkedColumn ?? 0)));
  if (!title) return null;
  const locationIndexes = row.locationsColumns?.length ? row.locationsColumns : [find(/location|city/i, 1)];
  return {
    contestNo: row.contestNo,
    title,
    locations: [...new Set(locationIndexes.flatMap((index) => taleoLocationCell(cell(row, index))))],
    postedAt: anyDate(cell(row, find(/posting date|date posted|posted/i, 2)).trim()),
  };
}

async function readShell(board: TaleoBoard): Promise<{ portal: string; headings: string[] }> {
  const html = await fetchText(searchPageUrl(board), { allowedHosts: [board.host] });
  const portal = taleoPortal(html);
  if (!portal) {
    throw new AppError("invalid_board", `Taleo career section "${board.section}" on ${board.host} is private or unavailable (no public portal number)`);
  }
  return { portal, headings: taleoHeadings(html) };
}

async function readPage(board: TaleoBoard, portal: string, company: Company, pageNo: number) {
  const url = `https://${board.host}/careersection/rest/jobboard/searchjobs?${new URLSearchParams({ lang: "en", portal })}`;
  const payload = parseSourcePayload(pageSchema, await fetchJson<unknown>(url, {
    allowedHosts: [board.host], headers: XHR_HEADERS, body: searchBody(company.query, pageNo),
  }), "Taleo search");
  const total = Number(payload.pagingData?.totalCount);
  return {
    raw: payload.requisitionList.length,
    total: Number.isFinite(total) && total >= 0 ? total : null,
    rows: validRows(rowSchema, payload.requisitionList, { kind: KIND, company }),
  };
}

/** The job page; `gone` when Taleo says the job is no longer available. */
async function readDetail(board: TaleoBoard, contestNo: string): Promise<DetailResult<TaleoDetail>> {
  let html: string;
  try {
    html = await fetchText(taleoPostingUrl(board, contestNo), { allowedHosts: [board.host] });
  } catch (error) {
    const status = httpStatus(error);
    if (status === 404 || status === 410) return { status: "gone" };
    throw error;
  }
  const detail = parseTaleoDetail(html, contestNo);
  if (detail) return { status: "ok", detail };
  if (isTaleoUnavailable(html)) return { status: "gone" };
  throw new AppError("unreadable_posting", `Taleo job ${contestNo} page carried no job description`);
}

function toJob(company: Company, board: TaleoBoard, listing: TaleoListing, detail: TaleoDetail | null, capturedAt: string): Job {
  const url = taleoPostingUrl(board, listing.contestNo);
  const locations = listing.locations.length > 0 ? listing.locations : detail?.locations ?? [];
  return normalizeJob({
    company,
    externalId: listing.contestNo,
    title: listing.title || detail?.title || "",
    locations,
    url,
    applyUrl: url,
    descriptionHtml: detail?.descriptionHtml ?? "",
    postedAt: listing.postedAt ?? detail?.postedAt ?? null,
    isRemote: locations.some((value) => /\bremote\b/i.test(value)),
    employmentType: detail?.employmentType,
    country: soleCountry(locations.map(trailingCountry)),
  }, capturedAt);
}

export const taleoAdapter: SourceAdapter = {
  kind: KIND,

  listUrl(company: Company): string {
    const board = parseTaleoBoard(company.board);
    return `https://${board.host}/careersection/rest/jobboard/searchjobs?lang=en`;
  },

  boardUrl(company: Company): string {
    return searchPageUrl(parseTaleoBoard(company.board));
  },

  async listJobs(company: Company, capturedAt: string): Promise<Job[]> {
    const board = parseTaleoBoard(company.board);
    const { portal, headings } = await readShell(board);
    let rawSeen = 0;
    const listings = await collectPages<TaleoListing>({
      cap: maxPostings(KIND),
      key: (listing) => listing.contestNo,
      fetchPage: async (index) => {
        const page = await readPage(board, portal, company, index + 1);
        rawSeen += page.raw;
        // Page sizes are uneven on some sections, so only the total or an empty page ends the walk.
        return {
          rows: page.rows.map((row) => toListing(row, headings)).filter((listing): listing is TaleoListing => listing !== null),
          more: page.raw > 0 && (page.total === null || rawSeen < page.total),
        };
      },
    });
    const context = { kind: KIND, company };
    const detailed = await withDetails(listings, maxDetails(KIND), (listing) => readDetail(board, listing.contestNo), context);
    return normalizeEach(detailed, ({ row, detail }) => toJob(company, board, row, detail, capturedAt), context);
  },

  async verifyBoard(company: Company) {
    const board = parseTaleoBoard(company.board);
    const { portal, headings } = await readShell(board);
    const page = await readPage(board, portal, company, 1);
    const titles = page.rows.map((row) => toListing(row, headings)?.title ?? "").filter(Boolean);
    return boardVerification(titles, page.total ?? titles.length);
  },

  probeUrls(): string[] {
    return [];
  },

  parsePostingUrl(url: URL): PostingRef | null {
    const board = sectionOf(url);
    const contestNo = url.searchParams.get("job") ?? "";
    if (!board || !/\/jobdetail\.ftl$/i.test(url.pathname) || !CONTEST.test(contestNo)) return null;
    return { board: `${board.host}/${board.section}`, externalId: contestNo };
  },

  async fetchPosting(company: Company, externalId: string, capturedAt: string): Promise<Job | null> {
    const board = parseTaleoBoard(company.board);
    if (!CONTEST.test(externalId)) throw new AppError("invalid_posting_id", `not a Taleo job number: ${externalId}`);
    const result = await readDetail(board, externalId);
    if (result.status === "gone") return null;
    const { detail } = result;
    const listing: TaleoListing = { contestNo: externalId, title: detail.title, locations: detail.locations, postedAt: detail.postedAt };
    return toJob(company, board, listing, detail, capturedAt);
  },

  async checkPosting(job: Job): Promise<PostingCheck> {
    let board: TaleoBoard;
    try {
      board = parseTaleoBoard(job.board);
    } catch (error) {
      return unparseableBoardCheck(error);
    }
    if (!CONTEST.test(job.externalId)) return unknownCheck("the stored job number is not a Taleo job number", "page");
    try {
      const result = await readDetail(board, job.externalId);
      return result.status === "gone"
        ? closedCheck("Taleo says the job is no longer available", "page")
        : openCheck("the job page still shows the description", "page");
    } catch (error) {
      return checkFromError(error, "page", false);
    }
  },
};
