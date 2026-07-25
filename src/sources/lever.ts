import type { Company } from "../domain/campaign.js";
import type { CompensationRange, Job, WorkplaceType } from "../domain/job.js";
import { fetchJson } from "./http.js";
import { asString, epochToIso, normalizeJob } from "./normalize.js";
import type { SourceAdapter } from "./types.js";

/**
 * Lever Postings API (public).
 * https://github.com/lever/postings-api
 *
 * Postings are public; applications go through the Lever-hosted form.
 */

function base(company: Company): string {
  return company.region === "eu" ? "https://api.eu.lever.co/v0/postings" : "https://api.lever.co/v0/postings";
}

type LeverSalary = { min?: unknown; max?: unknown; currency?: unknown; interval?: unknown };
type LeverPosting = {
  id?: unknown;
  text?: unknown;
  hostedUrl?: unknown;
  applyUrl?: unknown;
  createdAt?: unknown;
  descriptionPlain?: unknown;
  description?: unknown;
  additionalPlain?: unknown;
  workplaceType?: unknown;
  salaryRange?: LeverSalary;
  categories?: {
    location?: unknown;
    allLocations?: unknown;
    commitment?: unknown;
    team?: unknown;
    department?: unknown;
  };
};

const INTERVAL_MAP: Record<string, CompensationRange["period"]> = {
  "per-year-salary": "year",
  "per-month-salary": "month",
  "per-hour-wage": "hour",
};

function structuredPay(posting: LeverPosting): CompensationRange | null {
  const salary = posting.salaryRange;
  if (!salary) return null;
  const min = typeof salary.min === "number" ? salary.min : null;
  const max = typeof salary.max === "number" ? salary.max : null;
  if (min === null && max === null) return null;
  return {
    min,
    max,
    currency: (asString(salary.currency, "USD") || "USD").toUpperCase().slice(0, 3),
    period: INTERVAL_MAP[asString(salary.interval).toLowerCase()] ?? "year",
    source: "ats-structured",
    raw: `lever salaryRange ${asString(salary.interval)}`,
  };
}

function workplaceType(posting: LeverPosting): WorkplaceType {
  const value = asString(posting.workplaceType).toLowerCase();
  if (value === "remote" || value === "hybrid" || value === "onsite") return value;
  return "unknown";
}

function locations(posting: LeverPosting): string[] {
  const all = Array.isArray(posting.categories?.allLocations)
    ? posting.categories.allLocations.filter((item): item is string => typeof item === "string")
    : [];
  const primary = asString(posting.categories?.location);
  return [...new Set([primary, ...all].filter((value) => value.length > 0))];
}

export const leverAdapter: SourceAdapter = {
  kind: "lever",

  listUrl(company: Company): string {
    return `${base(company)}/${encodeURIComponent(company.board)}?mode=json`;
  },

  boardUrl(company: Company): string {
    const host = company.region === "eu" ? "https://jobs.eu.lever.co" : "https://jobs.lever.co";
    return `${host}/${encodeURIComponent(company.board)}`;
  },

  async listJobs(company: Company, capturedAt: string): Promise<Job[]> {
    const postings = await fetchJson<LeverPosting[]>(this.listUrl(company));
    if (!Array.isArray(postings)) return [];
    return postings.map((posting) => {
      const description = [asString(posting.descriptionPlain), asString(posting.additionalPlain)]
        .filter((value) => value.length > 0)
        .join("\n\n");
      return normalizeJob(
        {
          company,
          externalId: asString(posting.id),
          title: asString(posting.text),
          locations: locations(posting),
          url: asString(posting.hostedUrl),
          applyUrl: asString(posting.applyUrl) || asString(posting.hostedUrl),
          descriptionPlain: description,
          descriptionHtml: asString(posting.description),
          postedAt: epochToIso(posting.createdAt),
          workplaceType: workplaceType(posting),
          employmentType: asString(posting.categories?.commitment),
          structuredCompensation: structuredPay(posting),
        },
        capturedAt,
      );
    });
  },

  probeUrls(slug: string): string[] {
    return [
      `https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json&limit=1`,
      `https://api.eu.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json&limit=1`,
    ];
  },
};
