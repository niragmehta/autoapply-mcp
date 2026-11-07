import { z } from "zod";
import type { Company } from "../domain/campaign.js";
import type { Job } from "../domain/job.js";
import { AppError } from "../util/errors.js";
import { fetchJson } from "./http.js";
import { normalizeJob } from "./normalize.js";
import { boardVerification, parseSourcePayload } from "./sourceValidation.js";
import type { PostingCheck, PostingRef, SourceAdapter } from "./types.js";
import { boardSegments, hostname, invalidBoard } from "./enterprise/boards.js";
import { checkFromError, closedCheck, hasEnded, openCheck, unknownCheck, unparseableBoardCheck } from "./enterprise/checks.js";
import { collectPages, normalizeEach, validRows, withDetails } from "./enterprise/collect.js";
import type { DetailResult } from "./enterprise/collect.js";
import { soleCountry } from "./enterprise/country.js";
import { isoInstant } from "./enterprise/dates.js";
import { readJobPosting } from "./enterprise/jobPosting.js";
import { maxDetails, maxPostings } from "./enterprise/limits.js";

/**
 * Phenom People career sites ("CareerConnect"), always on the employer's own
 * domain. Endpoint behaviour adapted from career-ops (MIT).
 *
 * Board: "<host>/<country>/<language>", e.g. "careers.mastercard.com/us/en",
 * read off https://careers.mastercard.com/us/en/search-results. The two path
 * segments select the site's locale and are sent to the widget API as its
 * `country` and `lang`.
 *
 * Search results carry a teaser only; the description comes from the same
 * widget API's job-detail call, one request per posting.
 */

const KIND = "phenom" as const;
const COUNTRY = /^(?:[a-z]{2}|global)$/;
const LANGUAGE = /^[a-z]{2}(?:[-_][a-z]{2})?$/;
const JOB_ID = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,59}$/;
const PAGE_SIZE = 100;
const POSTING_PATH = /^\/((?:[a-z]{2}|global))\/([a-z]{2}(?:[-_][a-z]{2})?)\/job\/([A-Za-z0-9][A-Za-z0-9_.-]{0,59})(?:\/[^/]*)?\/?$/;
const EXPECTED = '"host/country/language" (e.g. careers.mastercard.com/us/en), read off https://<host>/<country>/<language>/search-results';

export type PhenomBoard = { host: string; country: string; language: string };

export function parsePhenomBoard(board: string): PhenomBoard {
  const parts = boardSegments(board);
  const host = parts.length === 3 ? hostname(parts[0]!) : null;
  const country = parts[1]?.toLowerCase() ?? "";
  const language = parts[2]?.toLowerCase() ?? "";
  if (!host || !COUNTRY.test(country) || !LANGUAGE.test(language)) {
    throw invalidBoard(KIND, board, EXPECTED, (url) => {
      const match = /^\/([a-z]{2}|global)\/([a-z]{2}(?:[-_][a-z]{2})?)(?:\/|$)/.exec(url.pathname);
      return match ? `${url.hostname.toLowerCase()}/${match[1]}/${match[2]}` : null;
    });
  }
  return { host, country, language };
}

function widgetsUrl(board: PhenomBoard): string {
  return `https://${board.host}/widgets`;
}

/** Widget locale: "us/en" is `lang: "en_us", country: "us"`. */
function locale(board: PhenomBoard) {
  return { lang: `${board.language.slice(0, 2)}_${board.country}`, country: board.country, deviceType: "desktop", siteType: "external" };
}

function slug(title: string): string {
  return title.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "job";
}

function postingUrl(board: PhenomBoard, jobId: string, title: string): string {
  return `https://${board.host}/${board.country}/${board.language}/job/${encodeURIComponent(jobId)}/${slug(title)}`;
}

const text = z.string().nullish();
const jobSchema = z.object({
  jobId: z.union([z.string(), z.number()]).transform(String).pipe(z.string().regex(JOB_ID)),
  title: z.string().trim().min(1),
  location: text,
  cityStateCountry: text,
  country: text,
  multi_location: z.array(z.unknown()).nullish(),
  isMultiLocation: z.boolean().nullish(),
  postedDate: text,
  dateCreated: text,
  type: text,
  descriptionTeaser: text,
});
type PhenomJob = z.infer<typeof jobSchema>;

const detailSchema = jobSchema.extend({
  description: text,
  postingEndDate: text,
  structureData: z.record(z.string(), z.unknown()).nullish(),
});
type PhenomDetail = z.infer<typeof detailSchema>;

const searchSchema = z.object({
  refineSearch: z.object({
    totalHits: z.number().nullish(),
    data: z.object({ jobs: z.array(z.unknown()).nullish() }).nullish(),
  }),
});
const detailEnvelope = z.object({
  jobDetail: z.object({ hits: z.number().nullish(), data: z.object({ job: z.unknown() }).partial().nullish() }),
});

async function readSearch(board: PhenomBoard, company: Company, from: number, size = PAGE_SIZE) {
  const payload = parseSourcePayload(searchSchema, await fetchJson<unknown>(widgetsUrl(board), {
    allowedHosts: [board.host],
    body: {
      ...locale(board), pageName: "search-results", ddoKey: "refineSearch", sortBy: "", subsearch: "",
      from, size, jobs: true, counts: true, all_fields: ["category", "country", "city"], clearAll: false,
      jdsource: "facets", isSliderEnable: false, pageId: "page1", keywords: company.query.trim(),
      global: true, selected_fields: {}, locationData: {},
    },
  }), "Phenom search");
  const raw = payload.refineSearch.data?.jobs ?? [];
  return { raw, total: payload.refineSearch.totalHits ?? null, rows: validRows(jobSchema, raw, { kind: KIND, company }) };
}

/** The widget's job detail; `null` when the site has no such job (zero hits). */
async function readDetail(board: PhenomBoard, jobId: string): Promise<PhenomDetail | null> {
  const payload = parseSourcePayload(detailEnvelope, await fetchJson<unknown>(widgetsUrl(board), {
    allowedHosts: [board.host],
    body: { ...locale(board), pageName: "job", ddoKey: "jobDetail", jobId },
  }), "Phenom job detail");
  if (!payload.jobDetail.hits || !payload.jobDetail.data?.job) return null;
  return parseSourcePayload(detailSchema, payload.jobDetail.data.job, "Phenom job detail");
}

function locationsOf(job: PhenomJob): string[] {
  const multiple = (job.multi_location ?? []).filter((value): value is string => typeof value === "string");
  const single = job.location?.trim() || job.cityStateCountry?.trim() || "";
  return [...new Set((multiple.length > 0 ? multiple : [single]).map((value) => value.trim()).filter(Boolean))];
}

function toJob(company: Company, board: PhenomBoard, row: PhenomJob, detail: PhenomDetail | null, capturedAt: string): Job {
  const source = detail ?? row;
  const url = postingUrl(board, row.jobId, source.title);
  const locations = locationsOf(source);
  const structured = detail?.structureData ? readJobPosting(detail.structureData) : null;
  return normalizeJob({
    company,
    externalId: row.jobId,
    title: source.title,
    locations,
    url,
    applyUrl: url,
    ...(detail?.description ? { descriptionHtml: detail.description } : { descriptionPlain: source.descriptionTeaser ?? "" }),
    postedAt: isoInstant(source.postedDate) ?? isoInstant(source.dateCreated),
    isRemote: locations.some((value) => /\bremote\b/i.test(value)),
    employmentType: source.type ?? structured?.employmentType,
    structuredCompensation: structured?.compensation ?? null,
    // The primary country alone would misplace a posting also open elsewhere.
    country: source.isMultiLocation ? undefined : soleCountry([source.country]),
  }, capturedAt);
}

export const phenomAdapter: SourceAdapter = {
  kind: KIND,

  listUrl(company: Company): string {
    return widgetsUrl(parsePhenomBoard(company.board));
  },

  boardUrl(company: Company): string {
    const board = parsePhenomBoard(company.board);
    return `https://${board.host}/${board.country}/${board.language}/search-results`;
  },

  async listJobs(company: Company, capturedAt: string): Promise<Job[]> {
    const board = parsePhenomBoard(company.board);
    const rows = await collectPages<PhenomJob>({
      cap: maxPostings(KIND),
      key: (row) => row.jobId,
      fetchPage: async (index) => {
        const from = index * PAGE_SIZE;
        const page = await readSearch(board, company, from);
        const more = page.raw.length > 0 && (page.total === null ? page.raw.length >= PAGE_SIZE : from + PAGE_SIZE < page.total);
        return { rows: page.rows, more };
      },
    });
    const context = { kind: KIND, company };
    const detailed = await withDetails(rows, maxDetails(KIND), async (row): Promise<DetailResult<PhenomDetail>> => {
      const detail = await readDetail(board, row.jobId);
      return detail ? { status: "ok", detail } : { status: "gone" };
    }, context);
    return normalizeEach(detailed, ({ row, detail }) => toJob(company, board, row, detail, capturedAt), context);
  },

  async verifyBoard(company: Company) {
    const page = await readSearch(parsePhenomBoard(company.board), company, 0, 5);
    return boardVerification(page.rows.map((row) => row.title), page.total ?? page.rows.length);
  },

  probeUrls(): string[] {
    return [];
  },

  parsePostingUrl(url: URL): PostingRef | null {
    const host = hostname(url.hostname);
    const match = POSTING_PATH.exec(url.pathname);
    if (!host || !match) return null;
    return { board: `${host}/${match[1]}/${match[2]}`, externalId: match[3]! };
  },

  async fetchPosting(company: Company, externalId: string, capturedAt: string): Promise<Job | null> {
    const board = parsePhenomBoard(company.board);
    if (!JOB_ID.test(externalId)) throw new AppError("invalid_posting_id", `not a Phenom job id: ${externalId}`);
    const detail = await readDetail(board, externalId);
    return detail ? toJob(company, board, detail, detail, capturedAt) : null;
  },

  async checkPosting(job: Job): Promise<PostingCheck> {
    let board: PhenomBoard;
    try {
      board = parsePhenomBoard(job.board);
    } catch (error) {
      return unparseableBoardCheck(error);
    }
    if (!JOB_ID.test(job.externalId)) return unknownCheck("the stored id is not a Phenom job id", "api");
    try {
      const detail = await readDetail(board, job.externalId);
      if (!detail) return closedCheck("the career site no longer has the job", "api");
      if (hasEnded(isoInstant(detail.postingEndDate))) return closedCheck(`the posting ended ${detail.postingEndDate}`, "api");
      return openCheck("the career site still serves the job", "api");
    } catch (error) {
      return checkFromError(error, "api", false);
    }
  },
};
