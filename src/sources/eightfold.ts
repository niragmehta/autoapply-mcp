import { z } from "zod";
import type { Company } from "../domain/campaign.js";
import type { Job, WorkplaceType } from "../domain/job.js";
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
import { epochSeconds } from "./enterprise/dates.js";
import { maxDetails, maxPostings, slowerInterval } from "./enterprise/limits.js";

/**
 * Eightfold AI career sites. Endpoint behaviour adapted from career-ops (MIT).
 *
 * Board: the tenant, optionally with the employer domain the site is scoped
 * to: "qualcomm/qualcomm.com", read off
 * https://qualcomm.eightfold.ai/careers?domain=qualcomm.com. A bare tenant
 * ("qualcomm") is shorthand for "qualcomm.eightfold.ai"; a host with dots is
 * used as written, for branded sites that serve the same API. Without a
 * domain the adapter reads it from the careers page once per process.
 *
 * Tenants serve one of two APIs: the newer PCSX search (which requires the
 * domain) or the classic `/api/apply/v2/jobs`; each answers 403 on the
 * other. Both return ten postings per page and no description, so
 * descriptions cost one detail request per posting.
 */

const KIND = "eightfold" as const;
const TENANT = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const POSITION_ID = /^\d{1,20}$/;
const PAGE_SIZE = 10;
const EXPECTED = '"tenant" or "tenant/domain" (e.g. qualcomm/qualcomm.com), read off https://<tenant>.eightfold.ai/careers?domain=<domain>';

export type EightfoldBoard = { host: string; domain: string | null };
type Api = "pcsx" | "v2";

function boardFromUrl(url: URL): string | null {
  const host = hostname(url.hostname);
  if (!host) return null;
  const tenant = /^([a-z0-9-]+)\.eightfold\.ai$/.exec(host)?.[1];
  const domain = hostname(url.searchParams.get("domain") ?? "");
  return `${tenant ?? host}${domain ? `/${domain}` : ""}`;
}

export function parseEightfoldBoard(board: string): EightfoldBoard {
  const parts = boardSegments(board.toLowerCase());
  const first = parts[0] ?? "";
  const host = TENANT.test(first) ? `${first}.eightfold.ai` : hostname(first);
  const domain = parts[1] === undefined ? null : hostname(parts[1]);
  if (!host || parts.length > 2 || (parts.length === 2 && !domain)) {
    throw invalidBoard(KIND, board, EXPECTED, boardFromUrl);
  }
  return { host, domain };
}

/** Domains read off careers pages, by host; they do not change while the server runs. */
const discoveredDomains = new Map<string, string>();

async function domainOf(board: EightfoldBoard): Promise<string> {
  if (board.domain) return board.domain;
  const known = discoveredDomains.get(board.host);
  if (known) return known;
  const html = await fetchText(`https://${board.host}/careers`, { allowedHosts: [board.host], minIntervalMs: slowerInterval(2) });
  const found = /_EF_GROUP_ID\s*=\s*["']([^"']+)["']/.exec(html)?.[1] ?? /&#34;domain&#34;:\s*&#34;([^&]+)&#34;/.exec(html)?.[1];
  const domain = found ? hostname(found) : null;
  if (!domain) {
    throw new AppError("invalid_board", `could not read the Eightfold domain from https://${board.host}/careers; add it to the board as "tenant/domain"`);
  }
  discoveredDomains.set(board.host, domain);
  return domain;
}

/** A search page URL; an empty domain is left out for the server to infer. */
function searchUrl(api: Api, host: string, domain: string, query: string, start: number, num = PAGE_SIZE): string {
  const params = new URLSearchParams(domain ? { domain } : {});
  params.set("start", String(start));
  if (api === "v2") params.set("num", String(num));
  if (query.trim()) params.set("query", query.trim());
  return api === "pcsx" ? `https://${host}/api/pcsx/search?${params}` : `https://${host}/api/apply/v2/jobs?${params}`;
}

function detailUrl(api: Api, host: string, domain: string, id: string): string {
  return api === "pcsx"
    ? `https://${host}/api/pcsx/position_details?${new URLSearchParams({ position_id: id, domain, hl: "en" })}`
    : `https://${host}/api/apply/v2/jobs/${encodeURIComponent(id)}?${new URLSearchParams({ domain })}`;
}

const text = z.string().nullish();
const strings = z.array(z.unknown()).nullish().transform((values) =>
  (values ?? []).filter((value): value is string => typeof value === "string" && value.trim().length > 0));
const positionSchema = z.object({
  id: z.union([z.string(), z.number()]).transform(String).pipe(z.string().regex(POSITION_ID)),
  name: text,
  posting_name: text,
  location: text,
  locations: strings,
  standardizedLocations: strings,
  postedTs: z.unknown().optional(),
  creationTs: z.unknown().optional(),
  t_create: z.unknown().optional(),
  workLocationOption: text,
  work_location_option: text,
  canonicalPositionUrl: text,
  jobDescription: text,
  job_description: text,
});
type Position = z.infer<typeof positionSchema>;

const pcsxPageSchema = z.object({ data: z.object({ positions: z.array(z.unknown()), count: z.number().nullish() }) });
const v2PageSchema = z.object({ positions: z.array(z.unknown()), count: z.number().nullish() });

type SearchPage = { raw: number; total: number | null; rows: Position[] };

/** Eightfold's edge rate-limits bursts, so its requests get twice the usual spacing. */
function getJson(url: string, host: string): Promise<unknown> {
  return fetchJson<unknown>(url, { allowedHosts: [host], minIntervalMs: slowerInterval(2) });
}

async function readSearch(api: Api, board: EightfoldBoard, domain: string, company: Company, start: number): Promise<SearchPage> {
  const payload = await getJson(searchUrl(api, board.host, domain, company.query, start), board.host);
  const page = api === "pcsx"
    ? parseSourcePayload(pcsxPageSchema, payload, "Eightfold PCSX search").data
    : parseSourcePayload(v2PageSchema, payload, "Eightfold search");
  const rows = validRows(positionSchema, page.positions, { kind: KIND, company }).filter((row) => titleOf(row).length > 0);
  return { raw: page.positions.length, total: page.count ?? null, rows };
}

/** First page on whichever API the tenant serves: PCSX unless it answers 403. */
async function firstSearch(board: EightfoldBoard, domain: string, company: Company): Promise<{ api: Api; page: SearchPage }> {
  try {
    return { api: "pcsx", page: await readSearch("pcsx", board, domain, company, 0) };
  } catch (error) {
    if (httpStatus(error) !== 403) throw error;
    return { api: "v2", page: await readSearch("v2", board, domain, company, 0) };
  }
}

/** One position's detail; `gone` on 404. Falls back to the classic API when PCSX refuses. */
async function readDetail(board: EightfoldBoard, domain: string, id: string, api?: Api): Promise<DetailResult<Position>> {
  const order: Api[] = api ? [api] : ["pcsx", "v2"];
  for (const [index, which] of order.entries()) {
    try {
      const payload = await getJson(detailUrl(which, board.host, domain, id), board.host);
      const record = which === "pcsx" && payload && typeof payload === "object" ? (payload as { data?: unknown }).data : payload;
      return { status: "ok", detail: parseSourcePayload(positionSchema, record, "Eightfold position") };
    } catch (error) {
      const status = httpStatus(error);
      if (status === 404) return { status: "gone" };
      if (status !== 403 || index === order.length - 1) throw error;
    }
  }
  throw new AppError("unreadable_posting", `Eightfold position ${id} could not be read`);
}

function titleOf(position: Position): string {
  return (position.name ?? position.posting_name ?? "").trim();
}

function workplaceOf(position: Position): WorkplaceType {
  const option = (position.workLocationOption ?? position.work_location_option ?? "").toLowerCase();
  if (option.includes("remote")) return "remote";
  if (option.includes("hybrid")) return "hybrid";
  if (option.includes("onsite") || option.includes("on-site")) return "onsite";
  return "unknown";
}

function postingUrl(board: EightfoldBoard, position: Position): string {
  const canonical = position.canonicalPositionUrl?.trim() ?? "";
  if (/^https:\/\//i.test(canonical)) return canonical;
  return `https://${board.host}/careers/job/${position.id}`;
}

function toJob(company: Company, board: EightfoldBoard, row: Position, detail: Position | null, capturedAt: string): Job {
  const source = detail ?? row;
  const locations = [...new Set([...source.locations, source.location ?? ""].map((value) => value.trim()).filter(Boolean))];
  const workplaceType = workplaceOf(source);
  const url = postingUrl(board, row);
  return normalizeJob({
    company,
    externalId: row.id,
    title: titleOf(source) || titleOf(row),
    locations,
    url,
    applyUrl: url,
    descriptionHtml: detail?.jobDescription ?? detail?.job_description ?? row.job_description ?? "",
    postedAt: epochSeconds(source.postedTs) ?? epochSeconds(source.t_create) ?? epochSeconds(source.creationTs),
    workplaceType,
    isRemote: workplaceType === "remote",
    country: soleCountry(source.standardizedLocations.map(trailingCountry)),
  }, capturedAt);
}

async function checkWith(board: EightfoldBoard, job: Job): Promise<PostingCheck> {
  const domain = await domainOf(board);
  const result = await readDetail(board, domain, job.externalId);
  return result.status === "gone"
    ? closedCheck("Eightfold answered that the position no longer exists", "api")
    : openCheck("Eightfold still serves the position", "api");
}

export const eightfoldAdapter: SourceAdapter = {
  kind: KIND,

  listUrl(company: Company): string {
    const board = parseEightfoldBoard(company.board);
    return searchUrl("pcsx", board.host, board.domain ?? "", company.query, 0);
  },

  boardUrl(company: Company): string {
    const board = parseEightfoldBoard(company.board);
    return `https://${board.host}/careers${board.domain ? `?domain=${encodeURIComponent(board.domain)}` : ""}`;
  },

  async listJobs(company: Company, capturedAt: string): Promise<Job[]> {
    const board = parseEightfoldBoard(company.board);
    const domain = await domainOf(board);
    let api: Api = "pcsx";
    const rows = await collectPages<Position>({
      cap: maxPostings(KIND),
      key: (row) => row.id,
      fetchPage: async (index) => {
        const start = index * PAGE_SIZE;
        const page = index === 0
          ? await firstSearch(board, domain, company).then((first) => { api = first.api; return first.page; })
          : await readSearch(api, board, domain, company, start);
        // `count` is the pre-filter total on some tenants, so a short page also ends the walk.
        const more = page.raw >= PAGE_SIZE && (page.total === null || start + PAGE_SIZE < page.total);
        return { rows: page.rows, more };
      },
    });
    const context = { kind: KIND, company };
    const detailed = await withDetails(rows, maxDetails(KIND), (row) => readDetail(board, domain, row.id, api), context);
    return normalizeEach(detailed, ({ row, detail }) => toJob(company, board, row, detail, capturedAt), context);
  },

  async verifyBoard(company: Company) {
    const board = parseEightfoldBoard(company.board);
    const { page } = await firstSearch(board, await domainOf(board), company);
    return boardVerification(page.rows.map(titleOf), page.total ?? page.rows.length);
  },

  probeUrls(slug: string): string[] {
    const tenant = slug.trim().toLowerCase();
    if (!TENANT.test(tenant)) return [];
    const host = `${tenant}.eightfold.ai`;
    // The classic API infers the domain; PCSX needs one, so "<slug>.com" is the guess.
    return [searchUrl("v2", host, "", "", 0, 1), searchUrl("pcsx", host, `${tenant}.com`, "", 0)];
  },

  parsePostingUrl(url: URL): PostingRef | null {
    const board = boardFromUrl(url);
    const path = /^\/careers\/job\/(\d{6,20})\/?$/.exec(url.pathname)?.[1];
    const pid = url.pathname.replace(/\/+$/, "") === "/careers" ? url.searchParams.get("pid") ?? "" : "";
    const onTenant = url.hostname.toLowerCase().endsWith(".eightfold.ai");
    const id = path ?? (onTenant && POSITION_ID.test(pid) ? pid : null);
    return board && id ? { board, externalId: id } : null;
  },

  async fetchPosting(company: Company, externalId: string, capturedAt: string): Promise<Job | null> {
    const board = parseEightfoldBoard(company.board);
    if (!POSITION_ID.test(externalId)) throw new AppError("invalid_posting_id", `not an Eightfold position id: ${externalId}`);
    const result = await readDetail(board, await domainOf(board), externalId);
    return result.status === "ok" ? toJob(company, board, result.detail, result.detail, capturedAt) : null;
  },

  async checkPosting(job: Job): Promise<PostingCheck> {
    let board: EightfoldBoard;
    try {
      board = parseEightfoldBoard(job.board);
    } catch (error) {
      return unparseableBoardCheck(error);
    }
    if (!POSITION_ID.test(job.externalId)) return unknownCheck("the stored id is not an Eightfold position id", "api");
    try {
      return await checkWith(board, job);
    } catch (error) {
      return checkFromError(error, "api", false);
    }
  },
};
