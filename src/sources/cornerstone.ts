import { z } from "zod";
import type { Company } from "../domain/campaign.js";
import type { Job } from "../domain/job.js";
import { AppError } from "../util/errors.js";
import { fetchJson, fetchText } from "./http.js";
import { normalizeJob } from "./normalize.js";
import { boardVerification, parseSourcePayload } from "./sourceValidation.js";
import type { PostingCheck, PostingRef, SourceAdapter } from "./types.js";
import { boardSegments, hostname, invalidBoard } from "./enterprise/boards.js";
import { checkFromError, closedCheck, hasEnded, httpStatus, openCheck, unknownCheck, unparseableBoardCheck } from "./enterprise/checks.js";
import { collectPages, normalizeEach, validRows, withDetails } from "./enterprise/collect.js";
import type { DetailResult } from "./enterprise/collect.js";
import { placeLabel, soleCountry } from "./enterprise/country.js";
import { isoInstant, usDate } from "./enterprise/dates.js";
import { maxDetails, maxPostings } from "./enterprise/limits.js";

/**
 * Cornerstone OnDemand (CSOD) hosted career sites. Endpoint behaviour adapted
 * from career-ops (MIT).
 *
 * Board: "<host>/<career site id>", e.g. "cornerstone.csod.com/2", read off
 * https://cornerstone.csod.com/ux/ats/careersite/2/home?c=cornerstone. When
 * the `c=` value differs from the host's first label it is added as a third
 * part: "career-ohb.csod.com/4/career-ohb". A bare tenant ("cornerstone/2")
 * is shorthand for "<tenant>.csod.com".
 *
 * The search and job-detail APIs want a bearer token; the career site's home
 * page embeds an anonymous one, which is read without logging in and reused
 * for a few minutes. Some tenants also require the session cookies that page
 * sets, which the shared HTTP client does not carry; those boards fail with
 * HTTP 401 rather than returning anything misleading.
 */

const KIND = "csod" as const;
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const SITE = /^\d{1,6}$/;
const CORP = /^[A-Za-z0-9_-]{1,60}$/;
const REQUISITION = /^\d{1,12}$/;
const PAGE_SIZE = 25;
const TOKEN_TTL_MS = 10 * 60_000;
const EXPECTED = '"host/siteId" (e.g. cornerstone.csod.com/2), read off https://<host>/ux/ats/careersite/<siteId>/home?c=<corp>';

export type CsodBoard = { host: string; siteId: number; corp: string };

function boardString(board: CsodBoard): string {
  const label = board.host.split(".")[0];
  return `${board.host}/${board.siteId}${board.corp === label ? "" : `/${board.corp}`}`;
}

function boardOf(url: URL): CsodBoard | null {
  const host = hostname(url.hostname);
  const site = /^\/ux\/ats\/careersite\/(\d{1,6})(?:\/|$)/i.exec(url.pathname)?.[1];
  if (!host || !host.endsWith(".csod.com") || !site) return null;
  const corp = url.searchParams.get("c") ?? host.split(".")[0]!;
  return CORP.test(corp) ? { host, siteId: Number(site), corp } : null;
}

export function parseCsodBoard(board: string): CsodBoard {
  const [first = "", site = "", corp, ...extra] = boardSegments(board);
  const lower = first.toLowerCase();
  const host = LABEL.test(lower) ? `${lower}.csod.com` : hostname(lower);
  if (!host || !host.endsWith(".csod.com") || !SITE.test(site) || extra.length > 0 || (corp !== undefined && !CORP.test(corp))) {
    throw invalidBoard(KIND, board, EXPECTED, (url) => {
      const found = boardOf(url);
      return found ? boardString(found) : null;
    });
  }
  return { host, siteId: Number(site), corp: corp ?? host.split(".")[0]! };
}

function homeUrl(board: CsodBoard): string {
  return `https://${board.host}/ux/ats/careersite/${board.siteId}/home?${new URLSearchParams({ c: board.corp })}`;
}

export function csodPostingUrl(board: CsodBoard, id: string): string {
  return `https://${board.host}/ux/ats/careersite/${board.siteId}/home/requisition/${id}?${new URLSearchParams({ c: board.corp })}`;
}

type Session = { token: string; cultureId: number; cultureName: string; expires: number };
const sessions = new Map<string, Session>();

/** The anonymous token and culture the career site's home page boots with. */
async function session(board: CsodBoard): Promise<Session> {
  const key = homeUrl(board);
  const cached = sessions.get(key);
  if (cached && cached.expires > Date.now()) return cached;
  const html = await fetchText(key, { allowedHosts: [board.host] });
  const token = /"token"\s*:\s*"([A-Za-z0-9._-]{20,})"/.exec(html)?.[1];
  if (!token) throw new AppError("invalid_board", `no anonymous career-site token on ${key}; check the site id and c= value`);
  const fresh: Session = {
    token,
    cultureId: Number(/"cultureID"\s*:\s*(\d{1,4})/.exec(html)?.[1] ?? 1),
    cultureName: /"cultureName"\s*:\s*"([A-Za-z-]{2,10})"/.exec(html)?.[1] ?? "en-US",
    expires: Date.now() + TOKEN_TTL_MS,
  };
  sessions.set(key, fresh);
  return fresh;
}

function authorized(board: CsodBoard, auth: Session, body?: unknown) {
  return { allowedHosts: [board.host], headers: { authorization: `Bearer ${auth.token}` }, ...(body === undefined ? {} : { body }) };
}

const text = z.string().nullish();
const placeSchema = z.object({ city: text, state: text, country: text });
const requisitionSchema = z.object({
  requisitionId: z.union([z.string(), z.number()]).transform(String).pipe(z.string().regex(REQUISITION)),
  displayJobTitle: z.string().trim().min(1),
  postingEffectiveDate: text,
  locations: z.array(placeSchema).nullish(),
});
type Requisition = z.infer<typeof requisitionSchema>;
const searchSchema = z.object({ data: z.object({ totalCount: z.number().nullish(), requisitions: z.array(z.unknown()) }) });

const detailSchema = z.object({
  displayTitle: z.string().nullish(),
  externalDescription: text,
  openDate: text,
  primaryLocation: placeSchema.nullish(),
  additionalLocations: z.array(placeSchema).nullish(),
});
type Detail = z.infer<typeof detailSchema>;
const postingsSchema = z.object({
  data: z.object({ postings: z.array(z.object({ careerSiteId: z.number(), startDate: text, endDate: text })) }),
});

async function readSearch(board: CsodBoard, company: Company, auth: Session, pageNumber: number, pageSize = PAGE_SIZE) {
  const body = {
    careerSiteId: board.siteId, careerSitePageId: board.siteId, pageNumber, pageSize,
    cultureId: auth.cultureId, cultureName: auth.cultureName, searchText: company.query.trim(),
    states: [], countryCodes: [], cities: [], placeID: "", radius: null, postingsWithinDays: null,
    customFieldCheckboxKeys: [], customFieldDropdowns: [], customFieldRadios: [],
  };
  const payload = parseSourcePayload(searchSchema, await fetchJson<unknown>(
    `https://${board.host}/services/x/career-site/v1/search`, authorized(board, auth, body),
  ), "Cornerstone search");
  return {
    raw: payload.data.requisitions.length,
    total: payload.data.totalCount ?? null,
    rows: validRows(requisitionSchema, payload.data.requisitions, { kind: KIND, company }),
  };
}

async function readDetail(board: CsodBoard, auth: Session, id: string): Promise<DetailResult<Detail>> {
  try {
    const payload = await fetchJson<unknown>(
      `https://${board.host}/services/x/job-requisition/v2/requisitions/${id}/jobDetails?cultureId=${auth.cultureId}`, authorized(board, auth),
    );
    const record = payload && typeof payload === "object" ? (payload as { data?: unknown }).data : null;
    return { status: "ok", detail: parseSourcePayload(detailSchema, record, "Cornerstone job details") };
  } catch (error) {
    if (httpStatus(error) === 404) return { status: "gone" };
    throw error;
  }
}

/** Whether the requisition is posted on this career site right now. */
async function isPostedHere(board: CsodBoard, auth: Session, id: string): Promise<boolean> {
  const payload = parseSourcePayload(postingsSchema, await fetchJson<unknown>(
    `https://${board.host}/services/x/career-site/v1/requisition/${id}`, authorized(board, auth),
  ), "Cornerstone postings");
  const started = (value: string | null | undefined) => {
    const at = isoInstant(value);
    return at === null || hasEnded(at);
  };
  return payload.data.postings.some((posting) =>
    posting.careerSiteId === board.siteId && started(posting.startDate) && !hasEnded(isoInstant(posting.endDate)));
}

function placesOf(places: readonly z.infer<typeof placeSchema>[]): { labels: string[]; countries: string[] } {
  return {
    labels: [...new Set(places.map((place) => placeLabel({ city: place.city, region: place.state, country: place.country })).filter(Boolean))],
    countries: places.map((place) => place.country ?? ""),
  };
}

function toJob(company: Company, board: CsodBoard, row: Requisition, detail: Detail | null, capturedAt: string): Job {
  const listed = row.locations ?? [];
  const detailed = detail ? [detail.primaryLocation, ...(detail.additionalLocations ?? [])].filter((place) => place != null) : [];
  const { labels, countries } = placesOf(listed.length > 0 ? listed : detailed);
  const url = csodPostingUrl(board, row.requisitionId);
  return normalizeJob({
    company,
    externalId: row.requisitionId,
    title: row.displayJobTitle,
    locations: labels,
    url,
    applyUrl: url,
    descriptionHtml: detail?.externalDescription ?? "",
    postedAt: usDate(row.postingEffectiveDate) ?? isoInstant(detail?.openDate),
    isRemote: labels.some((label) => /\bremote\b/i.test(label)),
    country: soleCountry(countries),
  }, capturedAt);
}

export const cornerstoneAdapter: SourceAdapter = {
  kind: KIND,

  listUrl(company: Company): string {
    return `https://${parseCsodBoard(company.board).host}/services/x/career-site/v1/search`;
  },

  boardUrl(company: Company): string {
    return homeUrl(parseCsodBoard(company.board));
  },

  async listJobs(company: Company, capturedAt: string): Promise<Job[]> {
    const board = parseCsodBoard(company.board);
    const auth = await session(board);
    const rows = await collectPages<Requisition>({
      cap: maxPostings(KIND),
      key: (row) => row.requisitionId,
      fetchPage: async (index) => {
        const page = await readSearch(board, company, auth, index + 1);
        return { rows: page.rows, more: page.raw >= PAGE_SIZE && (page.total === null || (index + 1) * PAGE_SIZE < page.total) };
      },
    });
    const context = { kind: KIND, company };
    const detailed = await withDetails(rows, maxDetails(KIND), (row) => readDetail(board, auth, row.requisitionId), context);
    return normalizeEach(detailed, ({ row, detail }) => toJob(company, board, row, detail, capturedAt), context);
  },

  async verifyBoard(company: Company) {
    const board = parseCsodBoard(company.board);
    const page = await readSearch(board, company, await session(board), 1, 5);
    return boardVerification(page.rows.map((row) => row.displayJobTitle), page.total ?? page.rows.length);
  },

  probeUrls(): string[] {
    return [];
  },

  parsePostingUrl(url: URL): PostingRef | null {
    const board = boardOf(url);
    const id = /\/home\/requisition\/(\d{1,12})\/?$/i.exec(url.pathname)?.[1];
    return board && id ? { board: boardString(board), externalId: id } : null;
  },

  async fetchPosting(company: Company, externalId: string, capturedAt: string): Promise<Job | null> {
    const board = parseCsodBoard(company.board);
    if (!REQUISITION.test(externalId)) throw new AppError("invalid_posting_id", `not a Cornerstone requisition id: ${externalId}`);
    const auth = await session(board);
    const result = await readDetail(board, auth, externalId);
    if (result.status === "gone" || !(await isPostedHere(board, auth, externalId))) return null;
    const row: Requisition = { requisitionId: externalId, displayJobTitle: result.detail.displayTitle?.trim() || "", postingEffectiveDate: null, locations: null };
    return toJob(company, board, row, result.detail, capturedAt);
  },

  async checkPosting(job: Job): Promise<PostingCheck> {
    let board: CsodBoard;
    try {
      board = parseCsodBoard(job.board);
    } catch (error) {
      return unparseableBoardCheck(error);
    }
    if (!REQUISITION.test(job.externalId)) return unknownCheck("the stored id is not a Cornerstone requisition id", "api");
    try {
      const auth = await session(board);
      const detail = await readDetail(board, auth, job.externalId);
      if (detail.status === "gone") return closedCheck("Cornerstone no longer has the requisition", "api");
      return await isPostedHere(board, auth, job.externalId)
        ? openCheck(`the requisition is posted on career site ${board.siteId}`, "api")
        : closedCheck(`the requisition is no longer posted on career site ${board.siteId}`, "api");
    } catch (error) {
      return checkFromError(error, "api", false);
    }
  },
};
