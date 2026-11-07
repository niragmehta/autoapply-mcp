import { z } from "zod";
import type { Company } from "../domain/campaign.js";
import type { Job, WorkplaceType } from "../domain/job.js";
import { AppError } from "../util/errors.js";
import { fetchJson } from "./http.js";
import { normalizeJob } from "./normalize.js";
import { boardVerification, parseSourcePayload } from "./sourceValidation.js";
import type { PostingCheck, PostingRef, SourceAdapter } from "./types.js";
import { boardSegments, hostname, invalidBoard } from "./enterprise/boards.js";
import { checkFromError, closedCheck, hasEnded, openCheck, unknownCheck, unparseableBoardCheck } from "./enterprise/checks.js";
import { collectPages, normalizeEach, validRows, withDetails } from "./enterprise/collect.js";
import type { DetailResult } from "./enterprise/collect.js";
import { placeLabel, soleCountry } from "./enterprise/country.js";
import { isoInstant } from "./enterprise/dates.js";
import { maxDetails, maxPostings } from "./enterprise/limits.js";
import { escapeHtml, joinSections } from "./enterprise/markup.js";

/**
 * Oracle Recruiting Cloud (Fusion HCM "Candidate Experience") public REST API.
 * Endpoint behaviour adapted from career-ops (MIT).
 *
 * Board: "<host>/<siteNumber>", e.g. "jpmc.fa.oraclecloud.com/CX_1002", read
 * off https://<host>/hcmUI/CandidateExperience/<lang>/sites/<siteNumber>/jobs.
 * Tenants run several sites (internal, campus, external) on one host, so the
 * site number is required rather than guessed.
 *
 * The listing carries only a one-line summary; the description, the exact
 * posting window and the pay flex fields cost one detail request per posting.
 */

const KIND = "oraclecloud" as const;
const HOST = /^[a-z0-9-]+\.fa\.(?:[a-z0-9-]+\.)?(?:ocs\.)?oraclecloud(?:[1-9][0-9]?)?\.com$/;
const SITE = /^[A-Za-z0-9_]{1,40}$/;
const POSTING_ID = /^[A-Za-z0-9_-]{1,40}$/;
const PAGE_SIZE = 200;
const FACETS = "LOCATIONS%3BWORK_LOCATIONS%3BWORKPLACE_TYPES%3BTITLES%3BCATEGORIES%3BORGANIZATIONS%3BPOSTING_DATES%3BFLEX_FIELDS";
const EXPECTED = '"host/siteNumber" (e.g. jpmc.fa.oraclecloud.com/CX_1002), read off https://<host>/hcmUI/CandidateExperience/en/sites/<siteNumber>/jobs';

export type OracleBoard = { host: string; site: string };

function siteOf(url: URL): OracleBoard | null {
  const host = url.hostname.toLowerCase();
  if (!HOST.test(host)) return null;
  const segments = url.pathname.split("/").filter(Boolean);
  const site = segments[segments.indexOf("sites") + 1];
  return segments.includes("sites") && site && SITE.test(site) ? { host, site } : null;
}

export function parseOracleBoard(board: string): OracleBoard {
  const parts = boardSegments(board);
  const host = parts.length === 2 ? hostname(parts[0]!) : null;
  const site = parts[1] ?? "";
  if (!host || !HOST.test(host) || !SITE.test(site)) {
    throw invalidBoard(KIND, board, EXPECTED, (url) => {
      const found = siteOf(url);
      return found ? `${found.host}/${found.site}` : null;
    });
  }
  return { host, site };
}

/** Quotes the keyword for the finder grammar, where `,` and `;` are separators. */
function keywordClause(query: string): string {
  const cleaned = query.replace(/["',;]+/g, " ").replace(/\s+/g, " ").trim();
  return cleaned ? `,keyword=${encodeURIComponent(`"${cleaned}"`)}` : "";
}

export function oracleListingUrl(board: OracleBoard, query: string, offset: number, limit = PAGE_SIZE): string {
  const finder = `findReqs;siteNumber=${board.site},facetsList=${FACETS},limit=${limit},sortBy=POSTING_DATES_DESC,offset=${offset}${keywordClause(query)}`;
  // The expand is required: without it the API reports a total but no rows.
  return `https://${board.host}/hcmRestApi/resources/latest/recruitingCEJobRequisitions?onlyData=true`
    + `&expand=${encodeURIComponent("requisitionList.workLocation,requisitionList.secondaryLocations")}`
    + `&finder=${finder}&limit=${limit}&offset=${offset}`;
}

function detailUrl(board: OracleBoard, id: string): string {
  return `https://${board.host}/hcmRestApi/resources/latest/recruitingCEJobRequisitionDetails`
    + `?expand=all&onlyData=true&finder=ById;Id=${encodeURIComponent(`"${id}"`)},siteNumber=${board.site}`;
}

function postingUrl(board: OracleBoard, id: string): string {
  return `https://${board.host}/hcmUI/CandidateExperience/en/sites/${board.site}/job/${encodeURIComponent(id)}`;
}

const text = z.string().nullish();
const requisitionSchema = z.object({
  Id: z.union([z.string(), z.number()]).transform(String).pipe(z.string().regex(POSTING_ID)),
  Title: z.string().trim().min(1),
  PostedDate: text,
  PrimaryLocation: text,
  PrimaryLocationCountry: text,
  WorkplaceTypeCode: text,
  WorkplaceType: text,
  JobSchedule: text,
  ShortDescriptionStr: text,
  secondaryLocations: z.array(z.object({ Name: text, CountryCode: text })).nullish(),
  workLocation: z.array(z.object({ TownOrCity: text, Region2: text, Country: text })).nullish(),
});
type Requisition = z.infer<typeof requisitionSchema>;

const detailSchema = requisitionSchema.extend({
  ExternalPostedStartDate: text,
  ExternalPostedEndDate: text,
  ExternalDescriptionStr: text,
  ExternalResponsibilitiesStr: text,
  ExternalQualificationsStr: text,
  requisitionFlexFields: z.array(z.object({ Prompt: z.unknown().optional(), Value: z.unknown().optional() })).nullish(),
});
type Detail = z.infer<typeof detailSchema>;

const listSchema = z.object({
  items: z.array(z.object({ TotalJobsCount: z.number().nullish(), requisitionList: z.array(z.unknown()).nullish() })),
});
const detailListSchema = z.object({ items: z.array(z.unknown()) });

async function readListPage(board: OracleBoard, company: Company, offset: number, limit = PAGE_SIZE) {
  const payload = parseSourcePayload(
    listSchema,
    await fetchJson<unknown>(oracleListingUrl(board, company.query, offset, limit), { allowedHosts: [board.host] }),
    "Oracle Recruiting Cloud",
  );
  const item = payload.items[0];
  const raw = item?.requisitionList ?? [];
  return { total: item?.TotalJobsCount ?? null, raw, rows: validRows(requisitionSchema, raw, { kind: KIND, company }) };
}

/** `null` when the site no longer publishes the requisition. */
async function readDetail(board: OracleBoard, id: string): Promise<Detail | null> {
  const payload = parseSourcePayload(
    detailListSchema,
    await fetchJson<unknown>(detailUrl(board, id), { allowedHosts: [board.host] }),
    "Oracle Recruiting Cloud detail",
  );
  if (payload.items.length === 0) return null;
  return parseSourcePayload(detailSchema, payload.items[0], "Oracle Recruiting Cloud detail");
}

function locationsOf(row: Requisition): string[] {
  const primary = row.PrimaryLocation?.trim() ?? "";
  const fallback = primary ? [] : (row.workLocation ?? []).map((place) =>
    placeLabel({ city: place.TownOrCity, region: place.Region2?.replace(/^[A-Z]{2}-/, ""), country: place.Country }));
  const secondary = (row.secondaryLocations ?? []).map((place) => place.Name?.trim() ?? "");
  return [...new Set([primary, ...fallback, ...secondary].filter((value) => value.length > 0))];
}

function workplaceOf(row: Requisition): WorkplaceType {
  const label = `${row.WorkplaceTypeCode ?? ""} ${row.WorkplaceType ?? ""}`.toUpperCase();
  if (label.includes("REMOTE")) return "remote";
  if (label.includes("HYBRID")) return "hybrid";
  if (/ON[_ -]?SITE/.test(label)) return "onsite";
  return "unknown";
}

/** Pay ranges live in flex fields ("Base Pay/Salary: New York,NY $100,000.00-$110,000.00"). */
function flexFieldsHtml(detail: Detail): string {
  return (detail.requisitionFlexFields ?? [])
    .filter((field) => typeof field.Prompt === "string" && typeof field.Value === "string" && field.Value.trim())
    .map((field) => `<p>${escapeHtml(String(field.Prompt))}: ${escapeHtml(String(field.Value))}</p>`)
    .join("\n");
}

function countriesOf(row: Requisition): (string | null | undefined)[] {
  return [row.PrimaryLocationCountry, ...(row.secondaryLocations ?? []).map((place) => place.CountryCode)];
}

function toJob(company: Company, board: OracleBoard, row: Requisition, detail: Detail | null, capturedAt: string): Job {
  const source = detail ?? row;
  const url = postingUrl(board, row.Id);
  const workplaceType = workplaceOf(source);
  const sources = detail ? [row, detail] : [row];
  return normalizeJob({
    company,
    externalId: row.Id,
    title: source.Title,
    locations: [...new Set(sources.flatMap(locationsOf))],
    url,
    applyUrl: url,
    ...(detail
      ? { descriptionHtml: joinSections([detail.ExternalDescriptionStr, detail.ExternalResponsibilitiesStr, detail.ExternalQualificationsStr, flexFieldsHtml(detail)]) }
      : { descriptionPlain: row.ShortDescriptionStr ?? "" }),
    postedAt: isoInstant(detail?.ExternalPostedStartDate) ?? isoInstant(source.PostedDate),
    workplaceType,
    isRemote: workplaceType === "remote",
    employmentType: source.JobSchedule ?? undefined,
    country: soleCountry(sources.flatMap(countriesOf)),
  }, capturedAt);
}

export const oracleCloudAdapter: SourceAdapter = {
  kind: KIND,

  listUrl(company: Company): string {
    return oracleListingUrl(parseOracleBoard(company.board), company.query, 0);
  },

  boardUrl(company: Company): string {
    const board = parseOracleBoard(company.board);
    return `https://${board.host}/hcmUI/CandidateExperience/en/sites/${board.site}/jobs`;
  },

  async listJobs(company: Company, capturedAt: string): Promise<Job[]> {
    const board = parseOracleBoard(company.board);
    const rows = await collectPages<Requisition>({
      cap: maxPostings(KIND),
      key: (row) => row.Id,
      fetchPage: async (index) => {
        const offset = index * PAGE_SIZE;
        const page = await readListPage(board, company, offset);
        // A short page is not the end when a total is published: Oracle drops
        // filtered rows mid-list, so only the total or an empty page ends it.
        const more = page.raw.length > 0
          && (page.total === null ? page.raw.length >= PAGE_SIZE : offset + PAGE_SIZE < page.total);
        return { rows: page.rows, more };
      },
    });
    const context = { kind: KIND, company };
    const detailed = await withDetails(rows, maxDetails(KIND), async (row): Promise<DetailResult<Detail>> => {
      const detail = await readDetail(board, row.Id);
      return detail ? { status: "ok", detail } : { status: "gone" };
    }, context);
    return normalizeEach(detailed, ({ row, detail }) => toJob(company, board, row, detail, capturedAt), context);
  },

  async verifyBoard(company: Company) {
    const page = await readListPage(parseOracleBoard(company.board), company, 0, 5);
    return boardVerification(page.rows.map((row) => row.Title), page.total ?? page.rows.length);
  },

  probeUrls(): string[] {
    return [];
  },

  parsePostingUrl(url: URL): PostingRef | null {
    const board = siteOf(url);
    if (!board) return null;
    const segments = url.pathname.split("/").filter(Boolean);
    const marker = segments.findIndex((segment, index) => index > segments.indexOf("sites") && (segment === "job" || segment === "preview"));
    const id = marker >= 0 ? segments[marker + 1] : undefined;
    return id && POSTING_ID.test(id) ? { board: `${board.host}/${board.site}`, externalId: id } : null;
  },

  async fetchPosting(company: Company, externalId: string, capturedAt: string): Promise<Job | null> {
    const board = parseOracleBoard(company.board);
    if (!POSTING_ID.test(externalId)) throw new AppError("invalid_posting_id", `not an Oracle requisition id: ${externalId}`);
    const detail = await readDetail(board, externalId);
    return detail ? toJob(company, board, detail, detail, capturedAt) : null;
  },

  async checkPosting(job: Job): Promise<PostingCheck> {
    let board: OracleBoard;
    try {
      board = parseOracleBoard(job.board);
    } catch (error) {
      return unparseableBoardCheck(error);
    }
    if (!POSTING_ID.test(job.externalId)) return unknownCheck("the stored id is not an Oracle requisition id", "api");
    try {
      const detail = await readDetail(board, job.externalId);
      if (!detail) return closedCheck(`site ${board.site} no longer publishes requisition ${job.externalId}`, "api");
      if (hasEnded(isoInstant(detail.ExternalPostedEndDate))) {
        return closedCheck(`the posting window ended ${detail.ExternalPostedEndDate}`, "api");
      }
      return openCheck(`site ${board.site} still publishes requisition ${job.externalId}`, "api");
    } catch (error) {
      // The detail finder answers an empty list for a missing requisition, so
      // an HTTP error here says nothing about the posting itself.
      return checkFromError(error, "api", false);
    }
  },
};
