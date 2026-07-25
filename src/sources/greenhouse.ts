import type { Company } from "../domain/campaign.js";
import type { CompensationRange, Job } from "../domain/job.js";
import { fetchJson } from "./http.js";
import { asString, normalizeJob } from "./normalize.js";
import type { SourceAdapter } from "./types.js";

/**
 * Greenhouse Job Board API (public, unauthenticated for reads).
 * https://developers.greenhouse.io/job-board.html
 *
 * Application submission through the API needs an employer-issued board key,
 * so candidates apply through the hosted form instead.
 */

const BASE = "https://boards-api.greenhouse.io/v1/boards";

type GreenhouseOffice = { name?: unknown; location?: unknown };
type GreenhousePayRange = { min_cents?: unknown; max_cents?: unknown; currency_type?: unknown; title?: unknown };
type GreenhouseJob = {
  id?: unknown;
  title?: unknown;
  updated_at?: unknown;
  first_published?: unknown;
  absolute_url?: unknown;
  content?: unknown;
  location?: { name?: unknown };
  offices?: GreenhouseOffice[];
  pay_input_ranges?: GreenhousePayRange[];
  metadata?: unknown;
};

function collectLocations(job: GreenhouseJob): string[] {
  const primary = asString(job.location?.name);
  const offices = (job.offices ?? [])
    .map((office) => asString(office.location) || asString(office.name))
    .filter((value) => value.length > 0 && value.toLowerCase() !== "n/a");
  return [...new Set([primary, ...offices].filter((value) => value.length > 0))];
}

function structuredPay(job: GreenhouseJob): CompensationRange | null {
  const range = job.pay_input_ranges?.[0];
  if (!range) return null;
  const minCents = typeof range.min_cents === "number" ? range.min_cents : null;
  const maxCents = typeof range.max_cents === "number" ? range.max_cents : null;
  if (minCents === null && maxCents === null) return null;
  return {
    min: minCents === null ? null : minCents / 100,
    max: maxCents === null ? null : maxCents / 100,
    currency: (asString(range.currency_type, "USD") || "USD").toUpperCase().slice(0, 3),
    period: "year",
    source: "ats-structured",
    raw: asString(range.title, "greenhouse pay_input_ranges"),
  };
}

export const greenhouseAdapter: SourceAdapter = {
  kind: "greenhouse",

  listUrl(company: Company): string {
    return `${BASE}/${encodeURIComponent(company.board)}/jobs?content=true&pay_transparency=true`;
  },

  boardUrl(company: Company): string {
    return `https://job-boards.greenhouse.io/${encodeURIComponent(company.board)}`;
  },

  async listJobs(company: Company, capturedAt: string): Promise<Job[]> {
    const payload = await fetchJson<{ jobs?: GreenhouseJob[] }>(this.listUrl(company));
    const jobs = payload.jobs ?? [];
    return jobs.map((job) =>
      normalizeJob(
        {
          company,
          externalId: String(job.id ?? ""),
          title: asString(job.title),
          locations: collectLocations(job),
          url: asString(job.absolute_url),
          applyUrl: asString(job.absolute_url),
          descriptionHtml: asString(job.content),
          postedAt: asString(job.first_published) || asString(job.updated_at) || null,
          structuredCompensation: structuredPay(job),
        },
        capturedAt,
      ),
    );
  },

  probeUrls(slug: string): string[] {
    return [`${BASE}/${encodeURIComponent(slug)}/jobs`];
  },
};

export type GreenhouseQuestionField = { name?: unknown; type?: unknown; values?: unknown };
export type GreenhouseQuestion = { label?: unknown; required?: unknown; fields?: GreenhouseQuestionField[] };

/**
 * Fetches one posting including its application questions, which drives the
 * answer policy engine before a submission is prepared.
 */
export async function fetchGreenhouseJobDetail(
  board: string,
  jobId: string,
): Promise<{ questions: GreenhouseQuestion[]; compliance: GreenhouseQuestion[]; payRanges: GreenhousePayRange[] }> {
  const url = `${BASE}/${encodeURIComponent(board)}/jobs/${encodeURIComponent(jobId)}?questions=true&pay_transparency=true`;
  const payload = await fetchJson<{
    questions?: GreenhouseQuestion[];
    compliance?: GreenhouseQuestion[];
    location_questions?: GreenhouseQuestion[];
    pay_input_ranges?: GreenhousePayRange[];
  }>(url);
  return {
    questions: [...(payload.questions ?? []), ...(payload.location_questions ?? [])],
    compliance: payload.compliance ?? [],
    payRanges: payload.pay_input_ranges ?? [],
  };
}
