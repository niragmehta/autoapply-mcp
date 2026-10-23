import type { Company } from "../domain/campaign.js";
import type { CompensationRange, Job } from "../domain/job.js";
import { AppError } from "../util/errors.js";
import { logger } from "../util/logger.js";
import { fetchText } from "./http.js";
import { epochToIso, normalizeJob } from "./normalize.js";
import type { BoardVerification, SourceAdapter } from "./types.js";

/**
 * Google Careers (google.com/about/careers).
 *
 * The search page is server-rendered and carries every result as JSON in an
 * `AF_initDataCallback` block keyed `ds:1`: title, locations, responsibilities,
 * qualifications and the description. Only the pay range is missing from it,
 * so each posting costs one more request to read that off its own page.
 *
 * Board: `<location>[;<LEVEL>,<LEVEL>...]`, for example
 * `United States;MID,ADVANCED`. The levels are Google's own search filter
 * (EARLY, MID, ADVANCED, DIRECTOR_PLUS); omitting them searches every level.
 * The company's `query` is the search text.
 */

const RESULTS = "https://www.google.com/about/careers/applications/jobs/results/";
const PAGE_SIZE = 20;

export type GoogleBoard = { location: string; levels: string[] };

export function parseGoogleBoard(board: string): GoogleBoard {
  const [location = "", levels = ""] = board.split(";").map((part) => part.trim());
  if (!location) {
    throw new AppError("invalid_board", `google board must be "<location>[;<LEVEL>,...]", got: ${board}`, { board });
  }
  return {
    location,
    levels: levels
      .split(",")
      .map((level) => level.trim().toUpperCase())
      .filter((level) => level.length > 0),
  };
}

export function googleSearchUrl(board: GoogleBoard, query: string, page: number): string {
  const params = new URLSearchParams();
  params.set("location", board.location);
  for (const level of board.levels) params.append("target_level", level);
  if (query.trim()) params.set("q", query.trim());
  if (page > 1) params.set("page", String(page));
  return `${RESULTS}?${params.toString()}`;
}

export function googleJobUrl(id: string): string {
  return `${RESULTS}${encodeURIComponent(id)}`;
}

export type GooglePosting = {
  id: string;
  title: string;
  applyUrl: string;
  company: string;
  locations: string[];
  descriptionHtml: string;
  postedAt: string | null;
};

/** Extracts the JSON payload of one `AF_initDataCallback` block. */
function callbackData(html: string, key: string): unknown {
  const pattern = new RegExp(`AF_initDataCallback\\(\\{key: '${key}'[\\s\\S]*?data:([\\s\\S]*?), sideChannel`);
  const match = pattern.exec(html);
  if (!match?.[1]) return null;
  try {
    return JSON.parse(match[1]) as unknown;
  } catch {
    return null;
  }
}

function htmlField(value: unknown): string {
  return Array.isArray(value) && typeof value[1] === "string" ? value[1] : "";
}

function postingFrom(entry: unknown): GooglePosting | null {
  if (!Array.isArray(entry) || typeof entry[0] !== "string" || typeof entry[1] !== "string") return null;
  const locations = Array.isArray(entry[9])
    ? entry[9].map((place) => (Array.isArray(place) && typeof place[0] === "string" ? place[0] : "")).filter(Boolean)
    : [];
  const created = Array.isArray(entry[12]) ? epochToIso(entry[12][0]) : null;
  const sections = [
    htmlField(entry[10]),
    htmlField(entry[3]) ? `<h3>Responsibilities:</h3>${htmlField(entry[3])}` : "",
    htmlField(entry[4]),
  ].filter((section) => section.length > 0);
  return {
    id: entry[0],
    title: entry[1].trim(),
    applyUrl: typeof entry[2] === "string" ? entry[2] : googleJobUrl(entry[0]),
    company: typeof entry[7] === "string" ? entry[7] : "Google",
    locations,
    descriptionHtml: sections.join("\n"),
    postedAt: created,
  };
}

/** Reads the postings and the total hit count from one search results page. */
export function parseGoogleResults(html: string): { postings: GooglePosting[]; total: number | null } {
  const data = callbackData(html, "ds:1");
  if (!Array.isArray(data) || !Array.isArray(data[0])) return { postings: [], total: null };
  const postings = data[0].map(postingFrom).filter((posting): posting is GooglePosting => posting !== null);
  return { postings, total: typeof data[2] === "number" ? data[2] : null };
}

/**
 * The posting's own page states pay as "US: $174000 - $252000 (USD)". Read
 * here rather than left to the generic text parser because the figures carry
 * no thousands separators.
 */
export function parseGooglePay(html: string): CompensationRange | null {
  const match = /US:\s*\$\s?([\d,]+)\s*-\s*\$\s?([\d,]+)\s*\(USD\)/.exec(html);
  if (!match?.[1] || !match[2]) return null;
  const min = Number(match[1].replace(/,/g, ""));
  const max = Number(match[2].replace(/,/g, ""));
  if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0 || max < min) return null;
  return { min, max, currency: "USD", period: "year", source: "description-text", raw: match[0] };
}

function maxPages(): number {
  const raw = Number.parseInt(process.env.AUTOAPPLY_CAREERS_MAX_PAGES ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 10;
}

export const googleCareersAdapter: SourceAdapter = {
  kind: "google",

  listUrl(company: Company): string {
    return googleSearchUrl(parseGoogleBoard(company.board), company.query, 1);
  },

  boardUrl(company: Company): string {
    return googleSearchUrl(parseGoogleBoard(company.board), company.query, 1);
  },

  async listJobs(company: Company, capturedAt: string): Promise<Job[]> {
    const board = parseGoogleBoard(company.board);
    const postings: GooglePosting[] = [];
    const seen = new Set<string>();
    for (let page = 1; page <= maxPages(); page += 1) {
      const { postings: found, total } = parseGoogleResults(await fetchText(googleSearchUrl(board, company.query, page)));
      const fresh = found.filter((posting) => !seen.has(posting.id));
      for (const posting of fresh) seen.add(posting.id);
      postings.push(...fresh);
      if (fresh.length < PAGE_SIZE || (total !== null && postings.length >= total)) break;
    }

    const jobs: Job[] = [];
    for (const posting of postings) {
      let pay: CompensationRange | null = null;
      try {
        pay = parseGooglePay(await fetchText(googleJobUrl(posting.id)));
      } catch (error) {
        logger.warn("google posting page unreadable; pay left unknown", { id: posting.id, error: String(error) });
      }
      jobs.push(
        normalizeJob(
          {
            company,
            externalId: posting.id,
            title: posting.title,
            locations: posting.locations,
            url: googleJobUrl(posting.id),
            applyUrl: posting.applyUrl,
            descriptionHtml: posting.descriptionHtml,
            postedAt: posting.postedAt,
            structuredCompensation: pay,
          },
          capturedAt,
        ),
      );
    }
    return jobs;
  },

  probeUrls(): string[] {
    return [];
  },

  async verifyBoard(company: Company): Promise<BoardVerification> {
    const { postings, total } = parseGoogleResults(
      await fetchText(googleSearchUrl(parseGoogleBoard(company.board), company.query, 1)),
    );
    return {
      ok: postings.length > 0,
      postings: total ?? postings.length,
      sampleTitles: postings.slice(0, 3).map((posting) => posting.title),
      detail: postings.length > 0 ? "search returned postings" : "search matched no postings",
    };
  },
};
