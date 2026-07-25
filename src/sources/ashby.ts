import type { Company } from "../domain/campaign.js";
import type { CompensationRange, Job, WorkplaceType } from "../domain/job.js";
import { fetchJson } from "./http.js";
import { asString, normalizeJob } from "./normalize.js";
import type { SourceAdapter } from "./types.js";

/**
 * Ashby public job board API.
 * https://developers.ashbyhq.com/docs/public-job-posting-api
 *
 * Publishes structured compensation, which is the most reliable pay signal of
 * the three supported systems.
 */

const BASE = "https://api.ashbyhq.com/posting-api/job-board";

type AshbyComponent = {
  compensationType?: unknown;
  interval?: unknown;
  currencyCode?: unknown;
  minValue?: unknown;
  maxValue?: unknown;
};
type AshbyCompensation = {
  compensationTierSummary?: unknown;
  scrapeableCompensationSalarySummary?: unknown;
  summaryComponents?: AshbyComponent[];
};
type AshbySecondaryLocation = { location?: unknown };
type AshbyJob = {
  id?: unknown;
  title?: unknown;
  location?: unknown;
  secondaryLocations?: AshbySecondaryLocation[];
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

const INTERVAL_MAP: Record<string, CompensationRange["period"]> = {
  "1 year": "year",
  "1 month": "month",
  "1 hour": "hour",
};

function structuredPay(job: AshbyJob): CompensationRange | null {
  const components = job.compensation?.summaryComponents ?? [];
  const salary = components.find((component) => asString(component.compensationType).toLowerCase() === "salary");
  if (!salary) return null;
  const min = typeof salary.minValue === "number" ? salary.minValue : null;
  const max = typeof salary.maxValue === "number" ? salary.maxValue : null;
  if (min === null && max === null) return null;
  return {
    min,
    max,
    currency: (asString(salary.currencyCode, "USD") || "USD").toUpperCase().slice(0, 3),
    period: INTERVAL_MAP[asString(salary.interval).toLowerCase()] ?? "year",
    source: "ats-structured",
    raw: asString(job.compensation?.compensationTierSummary, "ashby compensation"),
  };
}

function workplaceType(job: AshbyJob): WorkplaceType {
  const value = asString(job.workplaceType).toLowerCase();
  if (value === "remote") return "remote";
  if (value === "hybrid") return "hybrid";
  if (value === "onsite") return "onsite";
  return job.isRemote === true ? "remote" : "unknown";
}

function locations(job: AshbyJob): string[] {
  const secondary = (job.secondaryLocations ?? [])
    .map((entry) => asString(entry.location))
    .filter((value) => value.length > 0);
  return [...new Set([asString(job.location), ...secondary].filter((value) => value.length > 0))];
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
    const payload = await fetchJson<{ jobs?: AshbyJob[] }>(this.listUrl(company));
    const jobs = (payload.jobs ?? []).filter((job) => job.isListed !== false);
    return jobs.map((job) =>
      normalizeJob(
        {
          company,
          externalId: asString(job.id),
          title: asString(job.title),
          locations: locations(job),
          url: asString(job.jobUrl),
          applyUrl: asString(job.applyUrl) || asString(job.jobUrl),
          descriptionPlain: asString(job.descriptionPlain),
          descriptionHtml: asString(job.descriptionHtml),
          postedAt: asString(job.publishedAt) || null,
          workplaceType: workplaceType(job),
          isRemote: job.isRemote === true,
          employmentType: asString(job.employmentType),
          structuredCompensation: structuredPay(job),
        },
        capturedAt,
      ),
    );
  },

  probeUrls(slug: string): string[] {
    return [`${BASE}/${encodeURIComponent(slug)}`];
  },
};
