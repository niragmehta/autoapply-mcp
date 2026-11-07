import { z } from "zod";
import type { Company } from "../domain/campaign.js";
import type { CompensationRange, Job } from "../domain/job.js";
import { AppError } from "../util/errors.js";
import { fetchJson } from "./http.js";
import { normalizeJob } from "./normalize.js";
import { boardVerification, parseSourcePayload } from "./sourceValidation.js";
import type { PostingCheck, PostingRef, SourceAdapter } from "./types.js";
import { boardSegments, invalidBoard } from "./enterprise/boards.js";
import { checkFromError, closedCheck, openCheck, unknownCheck, unparseableBoardCheck } from "./enterprise/checks.js";
import { collectPages, normalizeEach, validRows, withDetails } from "./enterprise/collect.js";
import type { DetailResult } from "./enterprise/collect.js";
import { payPeriod, structuredPay } from "./enterprise/compensation.js";
import { placeLabel, soleCountry, trailingCountry } from "./enterprise/country.js";
import { isoInstant } from "./enterprise/dates.js";
import { maxDetails, maxPostings } from "./enterprise/limits.js";

/**
 * ADP Workforce Now Recruitment career centers. Endpoint behaviour adapted
 * from career-ops (MIT).
 *
 * Board: the career center's `cid`, plus its `ccId` when the careers URL
 * carries one: "1774d0ee-6390-4d36-9333-1f675e3b3058" or
 * "1774d0ee-…/19000101_000001", read off
 * https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html?cid=<cid>&ccId=<ccId>.
 *
 * The public staffing API lists requisitions twenty at a time with titles,
 * locations, dates and any published pay grade; descriptions cost one detail
 * request per posting. It has no keyword search, so `company.query` is not used.
 */

const KIND = "adp" as const;
const HOST = "workforcenow.adp.com";
const API = `https://${HOST}/mascsr/default/careercenter/public/events/staffing/v1`;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CC_ID = /^[0-9_]{1,40}$/;
const ITEM_ID = /^\d{1,20}_\d{1,10}$/;
const JOB_ID = /^[A-Za-z0-9_-]{1,40}$/;
const PAGE_SIZE = 20;
const EXPECTED = '"cid" or "cid/ccId" (e.g. 1774d0ee-6390-4d36-9333-1f675e3b3058), read off the recruitment.html?cid=…&ccId=… careers URL';

export type AdpBoard = { cid: string; ccId: string | null };

function boardOf(url: URL): AdpBoard | null {
  if (url.hostname.toLowerCase() !== HOST) return null;
  const cid = url.searchParams.get("cid") ?? "";
  const ccId = url.searchParams.get("ccId");
  if (!GUID.test(cid) || (ccId !== null && !CC_ID.test(ccId))) return null;
  return { cid: cid.toLowerCase(), ccId };
}

function boardString(board: AdpBoard): string {
  return board.ccId ? `${board.cid}/${board.ccId}` : board.cid;
}

export function parseAdpBoard(board: string): AdpBoard {
  const [cid = "", ccId, ...extra] = boardSegments(board);
  if (!GUID.test(cid) || extra.length > 0 || (ccId !== undefined && !CC_ID.test(ccId))) {
    throw invalidBoard(KIND, board, EXPECTED, (url) => {
      const found = boardOf(url);
      return found ? boardString(found) : null;
    });
  }
  return { cid: cid.toLowerCase(), ccId: ccId ?? null };
}

function params(board: AdpBoard, extra: Record<string, string> = {}): URLSearchParams {
  return new URLSearchParams({ cid: board.cid, ...(board.ccId ? { ccId: board.ccId } : {}), lang: "en_US", locale: "en_US", ...extra });
}

export function adpListUrl(board: AdpBoard, skip: number, top = PAGE_SIZE): string {
  return `${API}/job-requisitions?${params(board, { $skip: String(skip), $top: String(top) })}`;
}

export function adpPostingUrl(board: AdpBoard, jobId: string): string {
  const search = new URLSearchParams({ cid: board.cid, ...(board.ccId ? { ccId: board.ccId } : {}), jobId, lang: "en_US" });
  return `https://${HOST}/mascsr/default/mdf/recruitment/recruitment.html?${search}`;
}

const text = z.string().nullish();
const fieldList = <T extends z.ZodRawShape>(shape: T) => z.array(z.object({ nameCode: z.object({ codeValue: text }).nullish(), ...shape })).nullish();
const rate = z.object({ amountValue: z.number().nullish(), currencyCode: text }).nullish();
const requisitionSchema = z.object({
  itemID: z.string().regex(ITEM_ID),
  requisitionTitle: z.string().trim().min(1),
  postDate: text,
  customFieldGroup: z.object({
    stringFields: fieldList({ stringValue: text }),
    dateFields: fieldList({ dateValue: text }),
    codeFields: fieldList({ codeValue: text, shortName: text }),
  }).nullish(),
  requisitionLocations: z.array(z.object({
    nameCode: z.object({ shortName: text, longName: text }).nullish(),
    address: z.object({
      cityName: text,
      countrySubdivisionLevel1: z.object({ codeValue: text }).nullish(),
      country: z.object({ codeValue: text }).nullish(),
    }).nullish(),
  })).nullish(),
  payGradeRange: z.object({ minimumRate: rate, maximumRate: rate }).nullish(),
  workLevelCode: z.object({ shortName: text }).nullish(),
  requisitionDescription: text,
});
type Requisition = z.infer<typeof requisitionSchema>;
const listSchema = z.object({ jobRequisitions: z.array(z.unknown()).nullish(), meta: z.object({ totalNumber: z.number().nullish() }).nullish() });

type FieldGroup = NonNullable<Requisition["customFieldGroup"]>;

function field<T extends { nameCode?: { codeValue?: string | null } | null }>(list: readonly T[] | null | undefined, name: string): T | undefined {
  return (list ?? []).find((entry) => entry.nameCode?.codeValue === name);
}

function stringField(row: Requisition, name: string): string | null | undefined {
  return field<NonNullable<FieldGroup["stringFields"]>[number]>(row.customFieldGroup?.stringFields, name)?.stringValue;
}

function dateField(row: Requisition, name: string): string | null | undefined {
  return field<NonNullable<FieldGroup["dateFields"]>[number]>(row.customFieldGroup?.dateFields, name)?.dateValue;
}

function codeField(row: Requisition, name: string) {
  return field<NonNullable<FieldGroup["codeFields"]>[number]>(row.customFieldGroup?.codeFields, name);
}

function externalJobId(row: Requisition): string | null {
  const value = stringField(row, "ExternalJobID")?.trim() ?? "";
  return JOB_ID.test(value) ? value : null;
}

async function readPage(board: AdpBoard, company: Company, skip: number, top = PAGE_SIZE) {
  const payload = parseSourcePayload(listSchema, await fetchJson<unknown>(adpListUrl(board, skip, top), { allowedHosts: [HOST] }), "ADP requisitions");
  const raw = payload.jobRequisitions ?? [];
  return { raw: raw.length, total: payload.meta?.totalNumber ?? null, rows: validRows(requisitionSchema, raw, { kind: KIND, company }) };
}

/** One requisition; ADP answers an empty object, not a 404, for one it no longer has. */
async function readDetail(board: AdpBoard, itemId: string): Promise<DetailResult<Requisition>> {
  const payload = await fetchJson<unknown>(`${API}/job-requisitions/${encodeURIComponent(itemId)}?${params(board)}`, { allowedHosts: [HOST] });
  if (!payload || typeof payload !== "object" || !("itemID" in payload)) return { status: "gone" };
  const detail = parseSourcePayload(requisitionSchema, payload, "ADP requisition");
  if (detail.itemID !== itemId) throw new AppError("invalid_source_payload", "ADP answered with a different requisition");
  return { status: "ok", detail };
}

function placesOf(row: Requisition): { labels: string[]; countries: string[] } {
  const places = row.requisitionLocations ?? [];
  const labels = places.map((place) => {
    const address = place.address;
    const label = address?.cityName
      ? placeLabel({ city: address.cityName, region: address.countrySubdivisionLevel1?.codeValue, country: address.country?.codeValue })
      : "";
    return label || place.nameCode?.shortName?.trim() || place.nameCode?.longName?.trim() || "";
  });
  const countries = places.map((place) => place.address?.country?.codeValue ?? trailingCountry(place.nameCode?.shortName ?? ""));
  return { labels: [...new Set(labels.filter(Boolean))], countries };
}

function payOf(row: Requisition): CompensationRange | null {
  const range = row.payGradeRange;
  const type = codeField(row, "SalaryType");
  const period = payPeriod(type?.shortName) === "unknown" ? payPeriod(type?.codeValue) : payPeriod(type?.shortName);
  return structuredPay({
    min: range?.minimumRate?.amountValue,
    max: range?.maximumRate?.amountValue,
    currency: range?.minimumRate?.currencyCode ?? range?.maximumRate?.currencyCode,
    period,
    raw: stringField(row, "SalaryRange") ?? "ADP pay grade range",
  });
}

function toJob(company: Company, board: AdpBoard, row: Requisition, detail: Requisition | null, capturedAt: string): Job {
  const source = detail ?? row;
  const { labels, countries } = placesOf(source);
  const url = adpPostingUrl(board, externalJobId(source) ?? row.itemID);
  return normalizeJob({
    company,
    externalId: row.itemID,
    title: source.requisitionTitle,
    locations: labels,
    url,
    applyUrl: url,
    descriptionHtml: detail?.requisitionDescription ?? "",
    postedAt: isoInstant(dateField(source, "PostingDate")) ?? isoInstant(source.postDate),
    isRemote: labels.some((label) => /\bremote\b/i.test(label)),
    employmentType: source.workLevelCode?.shortName ?? undefined,
    structuredCompensation: payOf(source),
    country: soleCountry(countries),
  }, capturedAt);
}

async function listRequisitions(board: AdpBoard, company: Company): Promise<Requisition[]> {
  return collectPages<Requisition>({
    cap: maxPostings(KIND),
    key: (row) => row.itemID,
    fetchPage: async (_index, collected) => {
      // `$skip` is one-based and advances by the rows actually returned.
      const page = await readPage(board, company, collected + 1);
      return { rows: page.rows, more: page.raw >= PAGE_SIZE && (page.total === null || collected + page.raw < page.total) };
    },
  });
}

export const adpAdapter: SourceAdapter = {
  kind: KIND,

  listUrl(company: Company): string {
    return adpListUrl(parseAdpBoard(company.board), 1);
  },

  boardUrl(company: Company): string {
    const board = parseAdpBoard(company.board);
    const search = new URLSearchParams({ cid: board.cid, ...(board.ccId ? { ccId: board.ccId } : {}), lang: "en_US" });
    return `https://${HOST}/mascsr/default/mdf/recruitment/recruitment.html?${search}`;
  },

  async listJobs(company: Company, capturedAt: string): Promise<Job[]> {
    const board = parseAdpBoard(company.board);
    const rows = await listRequisitions(board, company);
    const context = { kind: KIND, company };
    const detailed = await withDetails(rows, maxDetails(KIND), (row) => readDetail(board, row.itemID), context);
    return normalizeEach(detailed, ({ row, detail }) => toJob(company, board, row, detail, capturedAt), context);
  },

  async verifyBoard(company: Company) {
    const page = await readPage(parseAdpBoard(company.board), company, 1, 5);
    return boardVerification(page.rows.map((row) => row.requisitionTitle), page.total ?? page.rows.length);
  },

  probeUrls(): string[] {
    return [];
  },

  parsePostingUrl(url: URL): PostingRef | null {
    const board = boardOf(url);
    const id = url.searchParams.get("jwId") ?? url.searchParams.get("jobId") ?? "";
    if (!board || !/\/recruitment\.html$/i.test(url.pathname) || !(ITEM_ID.test(id) || JOB_ID.test(id))) return null;
    return { board: boardString(board), externalId: id };
  },

  /** Takes ADP's internal item id, or the public job number a shared link carries. */
  async fetchPosting(company: Company, externalId: string, capturedAt: string): Promise<Job | null> {
    const board = parseAdpBoard(company.board);
    let itemId = externalId;
    if (!ITEM_ID.test(externalId)) {
      if (!JOB_ID.test(externalId)) throw new AppError("invalid_posting_id", `not an ADP job id: ${externalId}`);
      const match = (await listRequisitions(board, company)).find((row) => externalJobId(row) === externalId);
      if (!match) return null;
      itemId = match.itemID;
    }
    const result = await readDetail(board, itemId);
    return result.status === "ok" ? toJob(company, board, result.detail, result.detail, capturedAt) : null;
  },

  async checkPosting(job: Job): Promise<PostingCheck> {
    let board: AdpBoard;
    try {
      board = parseAdpBoard(job.board);
    } catch (error) {
      return unparseableBoardCheck(error);
    }
    if (!ITEM_ID.test(job.externalId)) return unknownCheck("the stored id is not an ADP requisition item id", "api");
    try {
      const result = await readDetail(board, job.externalId);
      return result.status === "gone"
        ? closedCheck("ADP no longer returns the requisition", "api")
        : openCheck("ADP still publishes the requisition", "api");
    } catch (error) {
      return checkFromError(error, "api", false);
    }
  },
};
