import type { Company } from "../domain/campaign.js";
import type { Job, WorkplaceType } from "../domain/job.js";
import { ashbyStructuredPay, type AshbyCompensation } from "./ashbyCompensation.js";
import { listHostedAshbyJobs } from "./ashbyHosted.js";
import { ashbyLocations, type AshbyLocation } from "./ashbyLocations.js";
import { fetchJson } from "./http.js";
import { asString, normalizeJob } from "./normalize.js";
import type { PostingCheck, PostingRef, SourceAdapter } from "./types.js";
import { AppError, toErrorMessage } from "../util/errors.js";
import { logger } from "../util/logger.js";

/**
 * Ashby public job board API.
 * https://developers.ashbyhq.com/docs/public-job-posting-api
 *
 * Publishes structured compensation, which is the most reliable pay signal of
 * the three supported systems.
 */

const BASE = "https://api.ashbyhq.com/posting-api/job-board";
const ASHBY_BOARD = /^[A-Za-z0-9 ._-]{1,100}$/;
const ASHBY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Liveness must answer quickly; unknown is an acceptable result, a long stall is not. */
const LIVENESS_REQUEST = { retries: 1, timeoutMs: 20_000 } as const;

async function apiJobs(url: string): Promise<AshbyJob[] | null> {
  try {
    const payload = await fetchJson<{ jobs?: AshbyJob[] }>(url);
    return (payload.jobs ?? []).filter((job) => job.isListed !== false);
  } catch (error) {
    if (!(error instanceof AppError) || error.code !== "not_found") throw error;
    logger.warn("Ashby listing API returned 404; checking public hosted job pages");
    return null;
  }
}

type AshbyJob = {
  id?: unknown;
  title?: unknown;
  location?: unknown;
  address?: unknown;
  secondaryLocations?: AshbyLocation[];
  department?: unknown;
  team?: unknown;
  isListed?: unknown;
  isRemote?: unknown;
  workplaceType?: unknown;
  descriptionHtml?: unknown;
  descriptionPlain?: unknown;
  publishedAt?: unknown;
  employmentType?: unknown;
  jobUrl?: unknown;
  applyUrl?: unknown;
  compensation?: AshbyCompensation;
};

function workplaceType(job: AshbyJob): WorkplaceType {
  const value = asString(job.workplaceType).toLowerCase();
  if (value === "remote") return "remote";
  if (value === "hybrid") return "hybrid";
  if (value === "onsite") return "onsite";
  return job.isRemote === true ? "remote" : "unknown";
}

export const ashbyAdapter: SourceAdapter = {
  kind: "ashby",

  listUrl(company: Company): string {
    return `${BASE}/${encodeURIComponent(company.board)}?includeCompensation=true`;
  },

  boardUrl(company: Company): string {
    return `https://jobs.ashbyhq.com/${encodeURIComponent(company.board)}`;
  },

  async listJobs(company: Company, capturedAt: string): Promise<Job[]> {
    const jobs = await apiJobs(this.listUrl(company));
    if (jobs === null) return listHostedAshbyJobs(company, capturedAt);
    return jobs.map((job) => toJob(company, job, capturedAt));
  },

  probeUrls(slug: string): string[] {
    return [`${BASE}/${encodeURIComponent(slug)}`];
  },

  /**
   * Ashby's posting API is board-level, so liveness asks whether the board
   * still lists the posting. A board without the public API (404) says nothing
   * about this posting and is left to the hosted page.
   */
  async checkPosting(job: Job): Promise<PostingCheck> {
    try {
      const jobs = await fetchJson<{ jobs?: AshbyJob[] }>(`${BASE}/${encodeURIComponent(job.board)}`, LIVENESS_REQUEST);
      if (!Array.isArray(jobs.jobs)) return { status: "unknown", via: "api", detail: "Ashby answered without a job list" };
      const wanted = job.externalId.toLowerCase();
      const listed = jobs.jobs.find((entry) => asString(entry.id).toLowerCase() === wanted);
      if (listed && listed.isListed !== false) return { status: "open", via: "api", detail: "Ashby still lists the posting on the board" };
      return { status: "closed", via: "api", detail: "Ashby's board no longer lists the posting" };
    } catch (error) {
      const detail = error instanceof AppError && error.code === "not_found"
        ? "Ashby's public posting API is off for this board"
        : `Ashby check failed: ${toErrorMessage(error)}`;
      return { status: "unknown", via: "api", detail };
    }
  },

  /** jobs.ashbyhq.com/{board}/{id}, with or without /application. */
  parsePostingUrl(url: URL): PostingRef | null {
    if (url.hostname.toLowerCase() !== "jobs.ashbyhq.com") return null;
    const [rawBoard, id, rest] = url.pathname.split("/").filter((segment) => segment.length > 0);
    if (!rawBoard || !id || (rest !== undefined && rest !== "application")) return null;
    let board: string;
    try {
      board = decodeURIComponent(rawBoard);
    } catch {
      return null;
    }
    return ASHBY_BOARD.test(board) && ASHBY_ID.test(id) ? { board, externalId: id } : null;
  },

  async fetchPosting(company: Company, externalId: string, capturedAt: string): Promise<Job | null> {
    if (!ASHBY_ID.test(externalId)) throw new AppError("invalid_posting_id", `Ashby posting ids are UUIDs, got: ${externalId}`);
    const jobs = await apiJobs(this.listUrl(company));
    if (jobs === null) {
      throw new AppError("posting_unreadable", "this Ashby board has no public posting API; paste the posting text instead");
    }
    const wanted = externalId.toLowerCase();
    const match = jobs.find((job) => asString(job.id).toLowerCase() === wanted);
    return match ? toJob(company, match, capturedAt) : null;
  },
};

function toJob(company: Company, job: AshbyJob, capturedAt: string): Job {
  const locations = ashbyLocations(job, job.secondaryLocations, workplaceType(job) === "remote");
  return normalizeJob(
    {
      company,
      externalId: asString(job.id),
      title: asString(job.title),
      locations,
      url: asString(job.jobUrl),
      applyUrl: asString(job.applyUrl) || asString(job.jobUrl),
      descriptionPlain: asString(job.descriptionPlain),
      descriptionHtml: asString(job.descriptionHtml),
      postedAt: asString(job.publishedAt) || null,
      workplaceType: workplaceType(job),
      isRemote: job.isRemote === true,
      employmentType: asString(job.employmentType),
      structuredCompensation: ashbyStructuredPay(job.compensation, locations, {
        isRemote: job.isRemote === true,
        workplaceType: workplaceType(job),
      }),
    },
    capturedAt,
  );
}
