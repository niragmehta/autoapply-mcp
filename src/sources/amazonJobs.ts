import type { Company } from "../domain/campaign.js";
import type { Job } from "../domain/job.js";
import { fetchJson } from "./http.js";
import { asString, normalizeJob } from "./normalize.js";
import type { BoardVerification, SourceAdapter } from "./types.js";

/**
 * Amazon Jobs (amazon.jobs), including AWS and Amazon's subsidiaries that
 * hire through it.
 *
 * The public search endpoint returns full postings as JSON, a page at a time.
 * Board: the ISO alpha-3 country to search (e.g. `USA`); the company's `query`
 * is the search text.
 */

const ORIGIN = "https://www.amazon.jobs";
const PAGE_SIZE = 100;

type AmazonJob = {
  id_icims?: unknown;
  title?: unknown;
  description?: unknown;
  basic_qualifications?: unknown;
  preferred_qualifications?: unknown;
  locations?: unknown;
  normalized_location?: unknown;
  location?: unknown;
  posted_date?: unknown;
  job_path?: unknown;
  is_intern?: unknown;
};

export function amazonSearchUrl(country: string, query: string, offset: number): string {
  const params = new URLSearchParams();
  if (query.trim()) params.set("base_query", query.trim());
  params.append("normalized_country_code[]", country.trim().toUpperCase());
  params.set("result_limit", String(PAGE_SIZE));
  params.set("offset", String(offset));
  params.set("sort", "recent");
  return `${ORIGIN}/en/search.json?${params.toString()}`;
}

/** The posting's form, which signs the candidate in first when needed. */
export function amazonApplyUrl(id: string): string {
  return `${ORIGIN}/applicant/jobs/${encodeURIComponent(id)}/apply`;
}

/**
 * Each entry of `locations` is itself a JSON string; `normalized_location`
 * ("Seattle, Washington, USA") is the fallback for a posting without them.
 */
export function amazonLocations(job: AmazonJob): string[] {
  const parsed = Array.isArray(job.locations)
    ? job.locations.flatMap((entry) => {
        try {
          const place = JSON.parse(String(entry)) as { city?: unknown; normalizedStateName?: unknown; normalizedCountryCode?: unknown };
          const parts = [asString(place.city), asString(place.normalizedStateName), asString(place.normalizedCountryCode)].filter(Boolean);
          return parts.length ? [parts.join(", ")] : [];
        } catch {
          return [];
        }
      })
    : [];
  if (parsed.length) return [...new Set(parsed)];
  const fallback = asString(job.normalized_location) || asString(job.location);
  return fallback ? [fallback] : [];
}

export function amazonPostedAt(value: unknown): string | null {
  const text = asString(value).replace(/\s+/g, " ").trim();
  if (!text) return null;
  const parsed = new Date(`${text} UTC`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function normalizeAmazonJob(job: AmazonJob, company: Company, capturedAt: string): Job | null {
  const id = asString(job.id_icims);
  const title = asString(job.title).trim();
  if (!id || !title || job.is_intern === true) return null;
  const section = (heading: string, value: unknown) => {
    const html = asString(value).trim();
    return html ? `<h3>${heading}</h3><p>${html}</p>` : "";
  };
  return normalizeJob(
    {
      company,
      externalId: id,
      title,
      locations: amazonLocations(job),
      url: `${ORIGIN}${asString(job.job_path) || `/en/jobs/${id}`}`,
      applyUrl: amazonApplyUrl(id),
      descriptionHtml: [
        section("Description", job.description),
        section("Basic qualifications", job.basic_qualifications),
        section("Preferred qualifications", job.preferred_qualifications),
      ].join("\n"),
      postedAt: amazonPostedAt(job.posted_date),
    },
    capturedAt,
  );
}

function maxPostings(): number {
  const raw = Number.parseInt(process.env.AUTOAPPLY_CAREERS_MAX_POSTINGS ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 500;
}

export const amazonJobsAdapter: SourceAdapter = {
  kind: "amazon",

  listUrl(company: Company): string {
    return amazonSearchUrl(company.board, company.query, 0);
  },

  boardUrl(company: Company): string {
    return `${ORIGIN}/en/search?base_query=${encodeURIComponent(company.query)}`;
  },

  async listJobs(company: Company, capturedAt: string): Promise<Job[]> {
    const jobs: Job[] = [];
    for (let offset = 0; offset < maxPostings(); offset += PAGE_SIZE) {
      const page = await fetchJson<{ hits?: unknown; jobs?: AmazonJob[] }>(amazonSearchUrl(company.board, company.query, offset));
      const found = page.jobs ?? [];
      for (const job of found) {
        const normalized = normalizeAmazonJob(job, company, capturedAt);
        if (normalized) jobs.push(normalized);
      }
      const hits = typeof page.hits === "number" ? page.hits : 0;
      if (found.length < PAGE_SIZE || offset + PAGE_SIZE >= hits) break;
    }
    return jobs;
  },

  probeUrls(): string[] {
    return [];
  },

  async verifyBoard(company: Company): Promise<BoardVerification> {
    const page = await fetchJson<{ hits?: unknown; jobs?: AmazonJob[] }>(amazonSearchUrl(company.board, company.query, 0));
    const found = page.jobs ?? [];
    return {
      ok: found.length > 0,
      postings: typeof page.hits === "number" ? page.hits : found.length,
      sampleTitles: found.slice(0, 3).map((job) => asString(job.title)),
      detail: found.length > 0 ? "search returned postings" : "search matched no postings",
    };
  },
};
