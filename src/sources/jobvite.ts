import type { Company } from "../domain/campaign.js";
import type { Job } from "../domain/job.js";
import { AppError, toErrorMessage } from "../util/errors.js";
import { logger } from "../util/logger.js";
import { fetchText } from "./http.js";
import { normalizeJob } from "./normalize.js";
import { boardVerification } from "./sourceValidation.js";
import type { PostingCheck, PostingRef, SourceAdapter } from "./types.js";
import { invalidBoard } from "./enterprise/boards.js";
import { checkFromError, closedCheck, httpStatus, openCheck, unknownCheck, unparseableBoardCheck } from "./enterprise/checks.js";
import { normalizeEach, withDetails } from "./enterprise/collect.js";
import type { DetailResult } from "./enterprise/collect.js";
import { payPeriod, structuredPay } from "./enterprise/compensation.js";
import { soleCountry, trailingCountry } from "./enterprise/country.js";
import { usDate } from "./enterprise/dates.js";
import {
  JOBVITE_JOB_ID, isJobviteMissing, jobviteCompanyId, parseJobviteDetail, parseJobviteFeed, parseJobviteList,
} from "./enterprise/jobvitePage.js";
import type { JobviteDetail, JobviteFeedJob, JobviteListRow } from "./enterprise/jobvitePage.js";
import { maxDetails, maxPostings } from "./enterprise/limits.js";
import { escapeHtml, joinSections } from "./enterprise/markup.js";

/**
 * Jobvite hosted career boards. Endpoint behaviour adapted from career-ops (MIT).
 *
 * Board: the vanity slug, e.g. "tylertech", read off
 * https://jobs.jobvite.com/tylertech/jobs.
 *
 * The board's job list page names every posting and embeds the opaque
 * company id the XML feed on app.jobvite.com is keyed on; the feed carries
 * every posting's description, date and locations in one response. That feed
 * host rate-limits hard (429 with Retry-After: 30), so when it fails the
 * adapter falls back to the job list and reads descriptions from posting
 * pages, up to the detail cap. Jobvite offers no server-side search, so
 * `company.query` is not used.
 */

const KIND = "jobvite" as const;
const BOARD_HOST = "jobs.jobvite.com";
const FEED_HOST = "app.jobvite.com";
const SLUG = /^[a-z0-9][a-z0-9_-]{0,99}$/;
/** The feed inlines every description; a large tenant's is ~2 MB and slow to serve. */
const FEED_TIMEOUT_MS = 45_000;
const EXPECTED = 'the vanity slug (e.g. tylertech), read off https://jobs.jobvite.com/<slug>/jobs';

function slugOf(url: URL): string | null {
  if (url.hostname.toLowerCase() !== BOARD_HOST) return null;
  const slug = url.pathname.split("/").filter(Boolean).find((segment) => segment !== "careers")?.toLowerCase() ?? "";
  return SLUG.test(slug) ? slug : null;
}

export function parseJobviteBoard(board: string): string {
  const slug = board.trim().toLowerCase();
  if (!SLUG.test(slug)) throw invalidBoard(KIND, board, EXPECTED, slugOf);
  return slug;
}

function listPageUrl(slug: string): string {
  return `https://${BOARD_HOST}/${slug}/jobs`;
}

export function jobvitePostingUrl(slug: string, id: string): string {
  return `https://${BOARD_HOST}/${slug}/job/${id}`;
}

/**
 * The URL actually requested for a board page. Tenants with a branded careers
 * site redirect jobs.jobvite.com to their own domain unless these framing
 * parameters are present, and that redirect would leave the pinned host.
 */
function inline(url: string): string {
  return `${url}?nl=1&fr=true`;
}

/** "Canadian Dollar (CAD $)" → "CAD"; a bare code passes through. */
function feedCurrency(label: string): string {
  return /\(([A-Z]{3})\b/.exec(label)?.[1] ?? (/^[A-Z]{3}$/.test(label.trim()) ? label.trim() : "");
}

function feedJob(company: Company, slug: string, job: JobviteFeedJob, capturedAt: string): Job {
  const url = jobvitePostingUrl(slug, job.id);
  return normalizeJob({
    company,
    externalId: job.id,
    title: job.title,
    locations: job.locations,
    url,
    applyUrl: url,
    descriptionHtml: job.descriptionHtml,
    postedAt: usDate(job.date),
    isRemote: job.locations.some((value) => /\bremote\b/i.test(value)),
    employmentType: job.jobType || undefined,
    structuredCompensation: structuredPay({
      min: job.salary.min,
      max: job.salary.max,
      currency: feedCurrency(job.salary.currency),
      period: payPeriod(job.salary.frequency),
      raw: `Jobvite salary ${job.salary.min}-${job.salary.max} ${job.salary.currency} ${job.salary.frequency}`.trim(),
    }),
    country: soleCountry(job.locations.map(trailingCountry)),
  }, capturedAt);
}

function pageJob(company: Company, slug: string, row: JobviteListRow, detail: JobviteDetail | null, capturedAt: string): Job {
  const url = jobvitePostingUrl(slug, row.id);
  const locations = detail && detail.locations.length > 0 ? detail.locations : [row.location].filter(Boolean);
  return normalizeJob({
    company,
    externalId: row.id,
    title: row.title || detail?.title || "",
    locations,
    url,
    applyUrl: url,
    descriptionHtml: detail ? joinSections([detail.descriptionHtml, ...detail.notes.map((note) => `<p>${escapeHtml(note)}</p>`)]) : "",
    isRemote: locations.some((value) => /\bremote\b/i.test(value)),
  }, capturedAt);
}

/** A posting page; `gone` when Jobvite redirects it to "The job listing no longer exists." */
async function readPosting(slug: string, id: string): Promise<DetailResult<JobviteDetail>> {
  let html: string;
  try {
    html = await fetchText(inline(jobvitePostingUrl(slug, id)), { allowedHosts: [BOARD_HOST] });
  } catch (error) {
    const status = httpStatus(error);
    if (status === 404 || status === 410) return { status: "gone" };
    throw error;
  }
  const detail = parseJobviteDetail(html);
  if (detail) return { status: "ok", detail };
  if (isJobviteMissing(html)) return { status: "gone" };
  throw new AppError("unreadable_posting", `Jobvite posting ${id} page carried no description`);
}

async function readFeed(companyId: string): Promise<JobviteFeedJob[]> {
  const xml = await fetchText(`https://${FEED_HOST}/CompanyJobs/Xml.aspx?${new URLSearchParams({ c: companyId })}`, {
    allowedHosts: [FEED_HOST], timeoutMs: FEED_TIMEOUT_MS, accept: "application/xml, text/xml",
  });
  return parseJobviteFeed(xml);
}

export const jobviteAdapter: SourceAdapter = {
  kind: KIND,

  listUrl(company: Company): string {
    return listPageUrl(parseJobviteBoard(company.board));
  },

  boardUrl(company: Company): string {
    return listPageUrl(parseJobviteBoard(company.board));
  },

  async listJobs(company: Company, capturedAt: string): Promise<Job[]> {
    const slug = parseJobviteBoard(company.board);
    const html = await fetchText(inline(listPageUrl(slug)), { allowedHosts: [BOARD_HOST] });
    const rows = parseJobviteList(html, slug).slice(0, maxPostings(KIND));
    const context = { kind: KIND, company };
    const companyId = jobviteCompanyId(html);
    if (companyId) {
      try {
        const feed = await readFeed(companyId);
        // An empty feed beside a non-empty job list is a feed fault, not an empty board.
        if (feed.length > 0 || rows.length === 0) {
          return normalizeEach(feed.slice(0, maxPostings(KIND)), (job) => feedJob(company, slug, job, capturedAt), context);
        }
      } catch (error) {
        logger.warn("jobvite feed unavailable; reading posting pages instead", { company: company.name, error: toErrorMessage(error) });
      }
    }
    const detailed = await withDetails(rows, maxDetails(KIND), (row) => readPosting(slug, row.id), context);
    return normalizeEach(detailed, ({ row, detail }) => pageJob(company, slug, row, detail, capturedAt), context);
  },

  async verifyBoard(company: Company) {
    const slug = parseJobviteBoard(company.board);
    const rows = parseJobviteList(await fetchText(inline(listPageUrl(slug)), { allowedHosts: [BOARD_HOST] }), slug);
    return boardVerification(rows.map((row) => row.title));
  },

  probeUrls(slug: string): string[] {
    const value = slug.trim().toLowerCase();
    return SLUG.test(value) ? [listPageUrl(value)] : [];
  },

  parsePostingUrl(url: URL): PostingRef | null {
    const match = /^\/(?:careers\/)?([a-z0-9][a-z0-9_-]{0,99})\/job\/([A-Za-z0-9]{4,20})(?:\/apply)?\/?$/i.exec(url.pathname);
    if (url.hostname.toLowerCase() !== BOARD_HOST || !match) return null;
    return { board: match[1]!.toLowerCase(), externalId: match[2]! };
  },

  async fetchPosting(company: Company, externalId: string, capturedAt: string): Promise<Job | null> {
    const slug = parseJobviteBoard(company.board);
    if (!JOBVITE_JOB_ID.test(externalId)) throw new AppError("invalid_posting_id", `not a Jobvite job id: ${externalId}`);
    const result = await readPosting(slug, externalId);
    if (result.status === "gone") return null;
    return pageJob(company, slug, { id: externalId, title: result.detail.title, location: "" }, result.detail, capturedAt);
  },

  async checkPosting(job: Job): Promise<PostingCheck> {
    let slug: string;
    try {
      slug = parseJobviteBoard(job.board);
    } catch (error) {
      return unparseableBoardCheck(error);
    }
    if (!JOBVITE_JOB_ID.test(job.externalId)) return unknownCheck("the stored id is not a Jobvite job id", "page");
    try {
      const result = await readPosting(slug, job.externalId);
      return result.status === "gone"
        ? closedCheck("Jobvite says the job listing no longer exists", "page")
        : openCheck("the posting page still shows the job", "page");
    } catch (error) {
      return checkFromError(error, "page", false);
    }
  },
};
