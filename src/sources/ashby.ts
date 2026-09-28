import type { Company } from "../domain/campaign.js";
import type { Job, WorkplaceType } from "../domain/job.js";
import { ashbyStructuredPay, type AshbyCompensation } from "./ashbyCompensation.js";
import { listHostedAshbyJobs } from "./ashbyHosted.js";
import { ashbyLocations, type AshbyLocation } from "./ashbyLocations.js";
import { fetchJson } from "./http.js";
import { asString, normalizeJob } from "./normalize.js";
import type { SourceAdapter } from "./types.js";
import { AppError } from "../util/errors.js";
import { logger } from "../util/logger.js";

/**
 * Ashby public job board API.
 * https://developers.ashbyhq.com/docs/public-job-posting-api
 *
 * Publishes structured compensation, which is the most reliable pay signal of
 * the three supported systems.
 */

const BASE = "https://api.ashbyhq.com/posting-api/job-board";

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
    return jobs.map((job) => {
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
    });
  },

  probeUrls(slug: string): string[] {
    return [`${BASE}/${encodeURIComponent(slug)}`];
  },
};
