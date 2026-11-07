import { z } from "zod";
import type { Company } from "../domain/campaign.js";
import type { CompensationRange, Job } from "../domain/job.js";
import { AppError } from "../util/errors.js";
import { fetchJson, fetchText } from "./http.js";
import { normalizeJob } from "./normalize.js";
import { boardVerification, parseSourcePayload } from "./sourceValidation.js";
import type { PostingCheck, PostingRef, SourceAdapter } from "./types.js";
import { boardSegments, hostname, invalidBoard } from "./enterprise/boards.js";
import { checkFromError, closedCheck, httpStatus, openCheck, unknownCheck, unparseableBoardCheck } from "./enterprise/checks.js";
import { collectPages, normalizeEach, validRows, withDetails } from "./enterprise/collect.js";
import type { DetailResult } from "./enterprise/collect.js";
import { structuredPay } from "./enterprise/compensation.js";
import { placeLabel, soleCountry } from "./enterprise/country.js";
import { isoInstant } from "./enterprise/dates.js";
import { maxDetails, maxPostings } from "./enterprise/limits.js";
import { readUkgPage } from "./enterprise/ukgPage.js";

/**
 * UKG Pro Recruiting (formerly UltiPro) public job boards. Endpoint behaviour
 * adapted from career-ops (MIT).
 *
 * Board: "<host>/<tenant>/<board id>", e.g.
 * "recruiting.ultipro.com/MIC1014MICS/aba7ab7f-e037-4961-b6cf-c1491e2105e0",
 * read off https://<host>/<tenant>/JobBoard/<board id>/. Tenants live on
 * several UKG hosts (recruiting.ultipro.com, recruiting2.ultipro.com,
 * recruiting.ultipro.ca, <name>.rec.pro.ukg.net) and the host is kept as
 * written.
 *
 * The search API returns a brief description; the full description, pay
 * range and open/closed flag are embedded in each opportunity's page.
 */

const KIND = "ultipro" as const;
const HOST = /^(?:recruiting\d*\.ultipro\.(?:com|ca)|[a-z0-9-]+\.rec\.pro\.ukg\.net)$/;
const TENANT = /^[A-Za-z0-9]{3,40}$/;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PAGE_SIZE = 50;
const EXPECTED = '"host/tenant/boardId" (e.g. recruiting.ultipro.com/MIC1014MICS/aba7ab7f-e037-4961-b6cf-c1491e2105e0), read off https://<host>/<tenant>/JobBoard/<boardId>/';

export type UkgBoard = { host: string; tenant: string; boardId: string };

function boardOf(url: URL): UkgBoard | null {
  const host = hostname(url.hostname);
  const match = /^\/([^/]+)\/JobBoard\/([^/]+)/i.exec(url.pathname);
  if (!host || !HOST.test(host) || !match || !TENANT.test(match[1]!) || !GUID.test(match[2]!)) return null;
  return { host, tenant: match[1]!, boardId: match[2]!.toLowerCase() };
}

export function parseUkgBoard(board: string): UkgBoard {
  const parts = boardSegments(board);
  const host = parts.length === 3 ? hostname(parts[0]!) : null;
  const tenant = parts[1] ?? "";
  const boardId = parts[2] ?? "";
  if (!host || !HOST.test(host) || !TENANT.test(tenant) || !GUID.test(boardId)) {
    throw invalidBoard(KIND, board, EXPECTED, (url) => {
      const found = boardOf(url);
      return found ? `${found.host}/${found.tenant}/${found.boardId}` : null;
    });
  }
  return { host, tenant, boardId: boardId.toLowerCase() };
}

function base(board: UkgBoard): string {
  return `https://${board.host}/${board.tenant}/JobBoard/${board.boardId}`;
}

export function ukgPostingUrl(board: UkgBoard, id: string): string {
  return `${base(board)}/OpportunityDetail?${new URLSearchParams({ opportunityId: id })}`;
}

function searchBody(query: string, skip: number, top: number) {
  return {
    opportunitySearch: {
      Top: top, Skip: skip, QueryString: query.trim(),
      OrderBy: [{ Value: "postedDateDesc", PropertyName: "PostedDate", Ascending: false }], Filters: [],
    },
    matchCriteria: {
      PreferredJobs: [], Educations: [], LicenseAndCertifications: [], Skills: [], hasNoLicenses: false, SkippedSkills: [],
    },
  };
}

const text = z.string().nullish();
const placeSchema = z.object({
  LocalizedName: text,
  LocalizedDescription: text,
  Address: z.object({
    City: text,
    State: z.object({ Code: text, Name: text }).nullish(),
    Country: z.object({ Code: text, Name: text }).nullish(),
  }).nullish(),
});
const opportunitySchema = z.object({
  Id: z.string().regex(GUID),
  Title: z.string().trim().min(1),
  FullTime: z.boolean().nullish(),
  Locations: z.array(placeSchema).nullish(),
  PostedDate: text,
  BriefDescription: text,
});
type Opportunity = z.infer<typeof opportunitySchema>;

const amount = z.number().nullish();
const detailSchema = opportunitySchema.extend({
  Description: text,
  OpportunityIsClosed: z.boolean().nullish(),
  Salaried: z.boolean().nullish(),
  CompensationAnnualMinimum: amount,
  CompensationAnnualMaximum: amount,
  CompensationHourlyMinimum: amount,
  CompensationHourlyMaximum: amount,
  CompensationCurrencyCode: text,
  PayRangeVisible: z.boolean().nullish(),
  PayRange: z.object({ PayRangeMinimum: amount, PayRangeMaximum: amount }).nullish(),
  PayRangeCurrencyCode: text,
});
type Detail = z.infer<typeof detailSchema>;

const pageSchema = z.object({ opportunities: z.array(z.unknown()), totalCount: z.number().nullish() });

async function readPage(board: UkgBoard, company: Company, skip: number, top = PAGE_SIZE) {
  const payload = parseSourcePayload(pageSchema, await fetchJson<unknown>(`${base(board)}/JobBoardView/LoadSearchResults`, {
    allowedHosts: [board.host], body: searchBody(company.query, skip, top),
  }), "UKG search");
  return {
    raw: payload.opportunities.length,
    total: payload.totalCount ?? null,
    rows: validRows(opportunitySchema, payload.opportunities, { kind: KIND, company }),
  };
}

type PageRead = { status: "open" | "closed"; detail: Detail } | { status: "gone"; reason: string };

/** An opportunity's page: its record (open or closed), or `gone` when UKG shows a notice instead. */
async function readOpportunity(board: UkgBoard, id: string): Promise<PageRead> {
  let html: string;
  try {
    html = await fetchText(ukgPostingUrl(board, id), { allowedHosts: [board.host] });
  } catch (error) {
    const status = httpStatus(error);
    if (status === 404 || status === 410) return { status: "gone", reason: `UKG answered HTTP ${status}` };
    throw error;
  }
  const page = readUkgPage(html, id);
  if (page.status === "unavailable") return { status: "gone", reason: page.reason };
  if (page.status === "unreadable") throw new AppError("unreadable_posting", `UKG opportunity ${id} page carried no record`);
  const detail = parseSourcePayload(detailSchema, page.record, "UKG opportunity");
  return { status: detail.OpportunityIsClosed ? "closed" : "open", detail };
}

async function readDetail(board: UkgBoard, id: string): Promise<DetailResult<Detail>> {
  const result = await readOpportunity(board, id);
  return result.status === "open" ? { status: "ok", detail: result.detail } : { status: "gone" };
}

function locationsOf(row: Opportunity): { labels: string[]; countries: string[] } {
  const places = row.Locations ?? [];
  const labels = places.map((place) => {
    const address = place.Address;
    const label = placeLabel({ city: address?.City, region: address?.State?.Code, country: address?.Country?.Code ?? address?.Country?.Name });
    return label || place.LocalizedDescription?.trim() || place.LocalizedName?.trim() || "";
  });
  return {
    labels: [...new Set(labels.filter((label) => label.length > 0))],
    countries: places.map((place) => place.Address?.Country?.Code ?? place.Address?.Country?.Name ?? ""),
  };
}

/** UKG's explicit annual or hourly fields, else the visible pay range read by `Salaried`. */
function payOf(detail: Detail): CompensationRange | null {
  const currency = detail.CompensationCurrencyCode ?? detail.PayRangeCurrencyCode;
  return structuredPay({ min: detail.CompensationAnnualMinimum, max: detail.CompensationAnnualMaximum, currency, period: "year", raw: "UKG annual compensation" })
    ?? structuredPay({ min: detail.CompensationHourlyMinimum, max: detail.CompensationHourlyMaximum, currency, period: "hour", raw: "UKG hourly compensation" })
    ?? (detail.PayRangeVisible
      ? structuredPay({
        min: detail.PayRange?.PayRangeMinimum,
        max: detail.PayRange?.PayRangeMaximum,
        currency: detail.PayRangeCurrencyCode,
        period: detail.Salaried === true ? "year" : detail.Salaried === false ? "hour" : "unknown",
        raw: "UKG pay range",
      })
      : null);
}

function toJob(company: Company, board: UkgBoard, row: Opportunity, detail: Detail | null, capturedAt: string): Job {
  const source = detail ?? row;
  const { labels, countries } = locationsOf(source);
  const url = ukgPostingUrl(board, row.Id);
  return normalizeJob({
    company,
    externalId: row.Id,
    title: source.Title,
    locations: labels,
    url,
    applyUrl: url,
    ...(detail?.Description ? { descriptionHtml: detail.Description } : { descriptionPlain: source.BriefDescription ?? "" }),
    postedAt: isoInstant(source.PostedDate),
    isRemote: labels.some((label) => /\bremote\b/i.test(label)),
    employmentType: source.FullTime === true ? "full-time" : source.FullTime === false ? "part-time" : undefined,
    structuredCompensation: detail ? payOf(detail) : null,
    country: soleCountry(countries),
  }, capturedAt);
}

export const ukgAdapter: SourceAdapter = {
  kind: KIND,

  listUrl(company: Company): string {
    return `${base(parseUkgBoard(company.board))}/JobBoardView/LoadSearchResults`;
  },

  boardUrl(company: Company): string {
    return `${base(parseUkgBoard(company.board))}/`;
  },

  async listJobs(company: Company, capturedAt: string): Promise<Job[]> {
    const board = parseUkgBoard(company.board);
    const rows = await collectPages<Opportunity>({
      cap: maxPostings(KIND),
      key: (row) => row.Id.toLowerCase(),
      fetchPage: async (index) => {
        const skip = index * PAGE_SIZE;
        const page = await readPage(board, company, skip);
        return { rows: page.rows, more: page.raw >= PAGE_SIZE && (page.total === null || skip + PAGE_SIZE < page.total) };
      },
    });
    const context = { kind: KIND, company };
    const detailed = await withDetails(rows, maxDetails(KIND), (row) => readDetail(board, row.Id), context);
    return normalizeEach(detailed, ({ row, detail }) => toJob(company, board, row, detail, capturedAt), context);
  },

  async verifyBoard(company: Company) {
    const page = await readPage(parseUkgBoard(company.board), company, 0, 5);
    return boardVerification(page.rows.map((row) => row.Title), page.total ?? page.rows.length);
  },

  probeUrls(): string[] {
    return [];
  },

  parsePostingUrl(url: URL): PostingRef | null {
    const board = boardOf(url);
    const id = url.searchParams.get("opportunityId") ?? "";
    if (!board || !/\/OpportunityDetail\/?$/i.test(url.pathname) || !GUID.test(id)) return null;
    return { board: `${board.host}/${board.tenant}/${board.boardId}`, externalId: id.toLowerCase() };
  },

  async fetchPosting(company: Company, externalId: string, capturedAt: string): Promise<Job | null> {
    const board = parseUkgBoard(company.board);
    if (!GUID.test(externalId)) throw new AppError("invalid_posting_id", `not a UKG opportunity id: ${externalId}`);
    const result = await readOpportunity(board, externalId);
    return result.status === "open" ? toJob(company, board, result.detail, result.detail, capturedAt) : null;
  },

  async checkPosting(job: Job): Promise<PostingCheck> {
    let board: UkgBoard;
    try {
      board = parseUkgBoard(job.board);
    } catch (error) {
      return unparseableBoardCheck(error);
    }
    if (!GUID.test(job.externalId)) return unknownCheck("the stored id is not a UKG opportunity id", "page");
    try {
      const result = await readOpportunity(board, job.externalId);
      if (result.status === "gone") return closedCheck(result.reason, "page");
      return result.status === "closed"
        ? closedCheck("UKG marks the opportunity closed", "page")
        : openCheck("UKG marks the opportunity open", "page");
    } catch (error) {
      return checkFromError(error, "page", false);
    }
  },
};
