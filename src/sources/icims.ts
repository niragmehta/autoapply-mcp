import type { Company } from "../domain/campaign.js";
import type { Job } from "../domain/job.js";
import { AppError } from "../util/errors.js";
import { fetchText } from "./http.js";
import { normalizeJob } from "./normalize.js";
import { boardVerification } from "./sourceValidation.js";
import type { PostingCheck, PostingRef, SourceAdapter } from "./types.js";
import { hostname, invalidBoard } from "./enterprise/boards.js";
import { checkFromError, closedCheck, hasEnded, httpStatus, openCheck, unknownCheck, unparseableBoardCheck } from "./enterprise/checks.js";
import { collectPages, normalizeEach, withDetails } from "./enterprise/collect.js";
import type { DetailResult } from "./enterprise/collect.js";
import { soleCountry, trailingCountry } from "./enterprise/country.js";
import {
  icimsCardLocations, icimsPageCount, icimsPostingLink, isIcimsMissingPage, parseIcimsCards,
} from "./enterprise/icimsPage.js";
import type { IcimsCard } from "./enterprise/icimsPage.js";
import { readJobPosting } from "./enterprise/jobPosting.js";
import type { JobPostingFields } from "./enterprise/jobPosting.js";
import { maxDetails, maxPostings } from "./enterprise/limits.js";
import { escapeHtml, findJobPosting, joinSections } from "./enterprise/markup.js";

/**
 * iCIMS hosted career portals. iCIMS has no anonymous JSON API, so this reads
 * the public portal pages. Endpoint behaviour adapted from career-ops (MIT).
 *
 * Board: the portal host, e.g. "careers-gdms.icims.com", read off
 * https://careers-gdms.icims.com/jobs/search?ss=1. A bare tenant name
 * ("gdms") is shorthand for the usual "careers-<tenant>.icims.com" portal.
 *
 * Search pages carry a title, location and short summary per posting; the
 * description, posting date and address come from each posting page's
 * schema.org JobPosting, one request per posting.
 */

const KIND = "icims" as const;
const TENANT = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const POSTING_ID = /^\d{1,12}$/;
const PAY_FIELD = /salary|pay|compensation|wage/i;
const LOCATION_FIELD = /^(?:job\s+)?locations?\b/i;
/** Identifier fields ("ID: 2026-79192") read as a pay range to the text parser. */
const ID_FIELD = /^(?:id|job\s*id|req(?:uisition)?\.?\s*(?:id|#|no\.?|number))$/i;
const EXPECTED = 'the portal host (e.g. careers-gdms.icims.com) or a bare tenant name, read off https://<host>/jobs/search';

export function parseIcimsBoard(board: string): string {
  const value = board.trim().toLowerCase();
  if (TENANT.test(value)) return `careers-${value}.icims.com`;
  const host = hostname(value);
  if (host && host.endsWith(".icims.com") && host !== "www.icims.com") return host;
  throw invalidBoard(KIND, board, EXPECTED, (url) => (url.hostname.endsWith(".icims.com") ? url.hostname.toLowerCase() : null));
}

export function icimsSearchUrl(host: string, query: string, page: number): string {
  const search = new URLSearchParams({ ss: "1", in_iframe: "1", pr: String(page) });
  if (query.trim()) search.set("searchKeyword", query.trim());
  return `https://${host}/jobs/search?${search}`;
}

async function readPage(host: string, query: string, page: number) {
  const html = await fetchText(icimsSearchUrl(host, query, page), { allowedHosts: [host] });
  return { cards: parseIcimsCards(html, host), pages: icimsPageCount(html) };
}

/** The posting's own page; `gone` when iCIMS answers 404/410 or its not-found page. */
async function readPosting(host: string, id: string): Promise<DetailResult<JobPostingFields>> {
  let html: string;
  try {
    html = await fetchText(`https://${host}/jobs/${encodeURIComponent(id)}/job?in_iframe=1`, { allowedHosts: [host] });
  } catch (error) {
    const status = httpStatus(error);
    if (status === 404 || status === 410) return { status: "gone" };
    throw error;
  }
  const posting = findJobPosting(html);
  if (posting) return { status: "ok", detail: readJobPosting(posting) };
  if (isIcimsMissingPage(html)) return { status: "gone" };
  throw new AppError("unreadable_posting", `iCIMS posting ${id} carried no JobPosting data`);
}

/**
 * Header fields as "Label: value" lines. Pay values like "USD $91,193.00 -
 * USD $98,674.00 /Yr." name the currency twice, which the shared range parser
 * does not read, so the code and symbol are folded into one symbol.
 */
function fieldLines(card: IcimsCard, only?: RegExp): string[] {
  return card.fields
    .filter((field) => !LOCATION_FIELD.test(field.label) && !ID_FIELD.test(field.label) && (!only || only.test(field.label)))
    .map((field) => {
      const value = PAY_FIELD.test(field.label)
        ? field.value.replace(/\bUSD\s*\$/gi, "$").replace(/\bCAD\s*\$/gi, "C$")
        : field.value;
      return `${field.label}: ${value}`;
    });
}

function toJob(company: Company, host: string, id: string, card: IcimsCard | null, detail: JobPostingFields | null, capturedAt: string): Job {
  const cardLocations = card ? icimsCardLocations(card) : [];
  const locations = detail && detail.locations.length > 0 ? detail.locations : cardLocations;
  const url = card?.url ?? icimsPostingLink(`/jobs/${id}/job`, host)?.url ?? `https://${host}/jobs/${id}/job`;
  const typeField = card?.fields.find((field) => /\btype\b/i.test(field.label))?.value;
  return normalizeJob({
    company,
    externalId: id,
    title: detail?.title || card?.title || "",
    locations,
    url,
    applyUrl: url,
    ...(detail
      ? { descriptionHtml: joinSections([detail.descriptionHtml, ...(card ? fieldLines(card, PAY_FIELD) : []).map((line) => `<p>${escapeHtml(line)}</p>`)]) }
      : { descriptionPlain: [card?.summary ?? "", ...(card ? fieldLines(card) : [])].filter(Boolean).join("\n") }),
    postedAt: detail?.postedAt ?? card?.postedAt ?? null,
    isRemote: detail?.isRemote || locations.some((value) => /\bremote\b/i.test(value)),
    employmentType: detail?.employmentType ?? typeField,
    structuredCompensation: detail?.compensation ?? null,
    country: detail?.country ?? soleCountry(cardLocations.map(trailingCountry)),
  }, capturedAt);
}

export const icimsAdapter: SourceAdapter = {
  kind: KIND,

  listUrl(company: Company): string {
    return icimsSearchUrl(parseIcimsBoard(company.board), company.query, 0);
  },

  boardUrl(company: Company): string {
    return `https://${parseIcimsBoard(company.board)}/jobs/search?ss=1`;
  },

  async listJobs(company: Company, capturedAt: string): Promise<Job[]> {
    const host = parseIcimsBoard(company.board);
    const cards = await collectPages<IcimsCard>({
      cap: maxPostings(KIND),
      key: (card) => card.id,
      fetchPage: async (index) => {
        const page = await readPage(host, company.query, index);
        // Without a pager the walk continues until an empty or repeated page.
        const more = page.cards.length > 0 && (page.pages === null || index + 1 < page.pages);
        return { rows: page.cards, more };
      },
    });
    const context = { kind: KIND, company };
    const detailed = await withDetails(cards, maxDetails(KIND), (card) => readPosting(host, card.id), context);
    return normalizeEach(detailed, ({ row, detail }) => toJob(company, host, row.id, row, detail, capturedAt), context);
  },

  async verifyBoard(company: Company) {
    const page = await readPage(parseIcimsBoard(company.board), company.query, 0);
    return boardVerification(page.cards.map((card) => card.title));
  },

  probeUrls(slug: string): string[] {
    const tenant = slug.trim().toLowerCase();
    return TENANT.test(tenant) ? [icimsSearchUrl(`careers-${tenant}.icims.com`, "", 0)] : [];
  },

  parsePostingUrl(url: URL): PostingRef | null {
    const host = url.hostname.toLowerCase();
    if (!host.endsWith(".icims.com")) return null;
    const link = icimsPostingLink(url.href, host);
    return link ? { board: host, externalId: link.id } : null;
  },

  async fetchPosting(company: Company, externalId: string, capturedAt: string): Promise<Job | null> {
    const host = parseIcimsBoard(company.board);
    if (!POSTING_ID.test(externalId)) throw new AppError("invalid_posting_id", `not an iCIMS job id: ${externalId}`);
    const result = await readPosting(host, externalId);
    return result.status === "ok" ? toJob(company, host, externalId, null, result.detail, capturedAt) : null;
  },

  async checkPosting(job: Job): Promise<PostingCheck> {
    let host: string;
    try {
      host = parseIcimsBoard(job.board);
    } catch (error) {
      return unparseableBoardCheck(error);
    }
    if (!POSTING_ID.test(job.externalId)) return unknownCheck("the stored id is not an iCIMS job id", "page");
    try {
      const result = await readPosting(host, job.externalId);
      if (result.status === "gone") return closedCheck("iCIMS says the job does not exist or is no longer open", "page");
      if (hasEnded(result.detail.validThrough)) return closedCheck(`the posting expired ${result.detail.validThrough}`, "page");
      return openCheck("the posting page still publishes the job", "page");
    } catch (error) {
      return checkFromError(error, "page", false);
    }
  },
};
