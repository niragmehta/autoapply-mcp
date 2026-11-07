import type { Company } from "../domain/campaign.js";
import type { Job } from "../domain/job.js";
import { AppError } from "../util/errors.js";
import { fetchText } from "./http.js";
import { normalizeJob } from "./normalize.js";
import { boardVerification } from "./sourceValidation.js";
import type { PostingCheck, PostingRef, SourceAdapter } from "./types.js";
import { boardSegments, hostname, invalidBoard } from "./enterprise/boards.js";
import { checkFromError, closedCheck, httpStatus, openCheck, unknownCheck, unparseableBoardCheck } from "./enterprise/checks.js";
import { collectPages, normalizeEach, withDetails } from "./enterprise/collect.js";
import type { DetailResult } from "./enterprise/collect.js";
import { avatureCardCount, avatureDetailUrl, avatureJobId, avatureTotal, parseAvatureCards, parseAvatureDetail } from "./enterprise/avaturePage.js";
import type { AvatureCard, AvatureDetail } from "./enterprise/avaturePage.js";
import { maxDetails, maxPostings } from "./enterprise/limits.js";

/**
 * Avature career portals, server-rendered on <tenant>.avature.net or the
 * employer's own domain. Endpoint behaviour adapted from career-ops (MIT).
 *
 * Board: "<host>/<site path>", e.g. "bloomberg.avature.net/careers", read off
 * https://bloomberg.avature.net/careers/SearchJobs: the site path is
 * everything between the host and "/SearchJobs". A bare tenant ("bloomberg")
 * is shorthand for "<tenant>.avature.net/careers".
 *
 * Search pages carry a title and usually a location per posting; the
 * description comes from each JobDetail page.
 */

const KIND = "avature" as const;
const TENANT = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const SITE_SEGMENT = /^[A-Za-z0-9_-]{1,60}$/;
const EXPECTED = '"host/site path" (e.g. bloomberg.avature.net/careers), read off https://<host>/<site path>/SearchJobs';

export type AvatureBoard = { host: string; site: string };

function boardOf(url: URL): AvatureBoard | null {
  const host = hostname(url.hostname);
  const site = /^\/((?:[A-Za-z0-9_-]+\/)*?[A-Za-z0-9_-]+)\/(?:SearchJobs|JobDetail)\b/i.exec(url.pathname)?.[1];
  return host && site ? { host, site } : null;
}

export function parseAvatureBoard(board: string): AvatureBoard {
  const [first = "", ...site] = boardSegments(board);
  const lower = first.toLowerCase();
  const host = TENANT.test(lower) ? `${lower}.avature.net` : hostname(lower);
  if (!host || site.length > 3 || !site.every((segment) => SITE_SEGMENT.test(segment))) {
    throw invalidBoard(KIND, board, EXPECTED, (url) => {
      const found = boardOf(url);
      return found ? `${found.host}/${found.site}` : null;
    });
  }
  return { host, site: site.length > 0 ? site.join("/") : "careers" };
}

function origin(board: AvatureBoard): string {
  return `https://${board.host}/${board.site}`;
}

function searchUrl(board: AvatureBoard, query: string, offsetParam: string, offset: number): string {
  const params = new URLSearchParams();
  if (query.trim()) params.set("search", query.trim());
  params.set(offsetParam, String(offset));
  return `${origin(board)}/SearchJobs/?${params}`;
}

async function readSearch(board: AvatureBoard, query: string, offsetParam: string, offset: number) {
  const html = await fetchText(searchUrl(board, query, offsetParam, offset), { allowedHosts: [board.host] });
  return { cards: parseAvatureCards(html, `https://${board.host}`), count: avatureCardCount(html), total: avatureTotal(html) };
}

/** A JobDetail page; `gone` when Avature redirects it to its Error page (404). */
async function readDetail(board: AvatureBoard, url: string): Promise<DetailResult<AvatureDetail>> {
  let html: string;
  try {
    html = await fetchText(url, { allowedHosts: [board.host] });
  } catch (error) {
    const status = httpStatus(error);
    if (status === 404 || status === 410) return { status: "gone" };
    throw error;
  }
  const detail = parseAvatureDetail(html);
  if (detail) return { status: "ok", detail };
  throw new AppError("unreadable_posting", "Avature job page carried no job details");
}

function toJob(company: Company, card: AvatureCard, detail: AvatureDetail | null, capturedAt: string): Job {
  const locations = card.location ? [card.location] : detail?.locations ?? [];
  return normalizeJob({
    company,
    externalId: card.id,
    title: card.title || detail?.title || "",
    locations,
    url: card.url,
    applyUrl: card.url,
    descriptionHtml: detail?.descriptionHtml ?? "",
    postedAt: card.postedAt,
    isRemote: locations.some((value) => /\bremote\b/i.test(value)),
  }, capturedAt);
}

export const avatureAdapter: SourceAdapter = {
  kind: KIND,

  listUrl(company: Company): string {
    return searchUrl(parseAvatureBoard(company.board), company.query, "jobOffset", 0);
  },

  boardUrl(company: Company): string {
    return `${origin(parseAvatureBoard(company.board))}/SearchJobs`;
  },

  async listJobs(company: Company, capturedAt: string): Promise<Job[]> {
    const board = parseAvatureBoard(company.board);
    let offsetParam = "jobOffset";
    let pageSize = 0;
    let firstId: string | undefined;
    const cards = await collectPages<AvatureCard>({
      cap: maxPostings(KIND),
      key: (card) => card.id,
      fetchPage: async (index, collected) => {
        let page = await readSearch(board, company.query, offsetParam, collected);
        // Some branded tenants ignore jobOffset and page with a bare `offset`;
        // a second page that repeats the first is the sign.
        if (index === 1 && page.cards[0]?.id === firstId) {
          const retry = await readSearch(board, company.query, "offset", collected);
          if (retry.cards[0] && retry.cards[0].id !== firstId) {
            offsetParam = "offset";
            page = retry;
          }
        }
        if (index === 0) {
          pageSize = page.count;
          firstId = page.cards[0]?.id;
        }
        const more = page.count > 0 && page.count >= pageSize && (page.total === null || collected + page.count < page.total);
        return { rows: page.cards, more };
      },
    });
    const context = { kind: KIND, company };
    const detailed = await withDetails(cards, maxDetails(KIND), (card) => readDetail(board, card.url), context);
    return normalizeEach(detailed, ({ row, detail }) => toJob(company, row, detail, capturedAt), context);
  },

  async verifyBoard(company: Company) {
    const page = await readSearch(parseAvatureBoard(company.board), company.query, "jobOffset", 0);
    return boardVerification(page.cards.map((card) => card.title), page.total ?? page.cards.length);
  },

  probeUrls(slug: string): string[] {
    const tenant = slug.trim().toLowerCase();
    return TENANT.test(tenant) ? [`https://${tenant}.avature.net/careers/SearchJobs`] : [];
  },

  parsePostingUrl(url: URL): PostingRef | null {
    const board = boardOf(url);
    const id = avatureJobId(url.pathname + url.search);
    if (!board || !id || !/\/JobDetail\b/i.test(url.pathname)) return null;
    return { board: `${board.host}/${board.site}`, externalId: id };
  },

  async fetchPosting(company: Company, externalId: string, capturedAt: string): Promise<Job | null> {
    const board = parseAvatureBoard(company.board);
    if (!/^\d{1,12}$/.test(externalId)) throw new AppError("invalid_posting_id", `not an Avature job id: ${externalId}`);
    // Avature keys job pages on the id; the slug before it is cosmetic.
    const url = `${origin(board)}/JobDetail/job/${externalId}`;
    const result = await readDetail(board, url);
    if (result.status === "gone") return null;
    const card: AvatureCard = { id: externalId, url, title: result.detail.title, location: "", postedAt: null };
    return toJob(company, card, result.detail, capturedAt);
  },

  async checkPosting(job: Job): Promise<PostingCheck> {
    let board: AvatureBoard;
    try {
      board = parseAvatureBoard(job.board);
    } catch (error) {
      return unparseableBoardCheck(error);
    }
    let url: URL;
    try {
      url = new URL(job.url);
    } catch {
      return unknownCheck("the stored posting URL does not parse", "page");
    }
    if (url.hostname !== board.host) return unknownCheck("the stored posting URL is not on the board's host", "page");
    const target = avatureDetailUrl(url);
    if (!target) return unknownCheck("the stored posting URL is not an Avature job page", "page");
    try {
      const result = await readDetail(board, target);
      return result.status === "gone"
        ? closedCheck("Avature sends the posting to its error page", "page")
        : openCheck("the job page still shows the posting", "page");
    } catch (error) {
      return checkFromError(error, "page", false);
    }
  },
};
