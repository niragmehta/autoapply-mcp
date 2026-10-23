import type { Company } from "../domain/campaign.js";
import type { Job } from "../domain/job.js";
import { logger } from "../util/logger.js";
import { fetchText } from "./http.js";
import { asString, normalizeJob } from "./normalize.js";
import type { BoardVerification, SourceAdapter } from "./types.js";

/**
 * Apple Jobs (jobs.apple.com).
 *
 * Search and posting pages are server-rendered with their data embedded as
 * `window.__staticRouterHydrationData`. Search results are a summary; each
 * posting's page adds the qualifications and the internal level range
 * ("Software Development Engineer - Security ICT4" to "... ICT5"), which is
 * kept in the description because it is the only seniority signal Apple
 * publishes.
 *
 * Board: the location filter slug (e.g. `united-states-USA`); the company's
 * `query` is the search text.
 */

const ORIGIN = "https://jobs.apple.com";
const PAGE_SIZE = 20;

type AppleLocation = { name?: unknown; stateProvince?: unknown; countryName?: unknown };
type AppleResult = {
  id?: unknown;
  postingTitle?: unknown;
  transformedPostingTitle?: unknown;
  locations?: AppleLocation[];
  jobSummary?: unknown;
  postDateInGMT?: unknown;
};
type AppleDetail = {
  description?: unknown;
  jobSummary?: unknown;
  minimumQualifications?: unknown;
  preferredQualifications?: unknown;
  lowJobTitle?: unknown;
  highJobTitle?: unknown;
  locations?: AppleLocation[];
};

export function appleSearchUrl(location: string, query: string, page: number): string {
  const params = new URLSearchParams();
  if (query.trim()) params.set("search", query.trim());
  params.set("sort", "relevance");
  if (location.trim()) params.set("location", location.trim());
  if (page > 1) params.set("page", String(page));
  return `${ORIGIN}/en-us/search?${params.toString()}`;
}

export function appleJobUrl(id: string, slug: string): string {
  return `${ORIGIN}/en-us/details/${encodeURIComponent(id)}${slug ? `/${encodeURIComponent(slug)}` : ""}`;
}

export function appleApplyUrl(id: string): string {
  return `${ORIGIN}/app/en-us/apply/${encodeURIComponent(id)}`;
}

/** Decodes the page's `window.__staticRouterHydrationData = JSON.parse("...")` payload. */
export function appleHydrationData(html: string): Record<string, unknown> | null {
  const match = /window\.__staticRouterHydrationData\s*=\s*JSON\.parse\("([\s\S]*?)"\);/.exec(html);
  if (!match?.[1]) return null;
  try {
    const decoded = JSON.parse(`"${match[1]}"`) as string;
    return JSON.parse(decoded) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function loader(html: string, name: string): Record<string, unknown> | null {
  const data = appleHydrationData(html);
  const loaders = data?.loaderData as Record<string, unknown> | undefined;
  const value = loaders?.[name];
  return value && typeof value === "object" ? (value as Record<string, unknown>) : null;
}

export function appleLocationNames(locations: AppleLocation[] | undefined): string[] {
  return (locations ?? [])
    .map((place) => [asString(place.name), asString(place.stateProvince), asString(place.countryName)].filter(Boolean).join(", "))
    .filter((name) => name.length > 0);
}

export function parseAppleSearch(html: string): { results: AppleResult[]; total: number | null } {
  const search = loader(html, "search");
  const results = Array.isArray(search?.searchResults) ? (search.searchResults as AppleResult[]) : [];
  return { results, total: typeof search?.totalRecords === "number" ? search.totalRecords : null };
}

export function parseAppleDetail(html: string): AppleDetail | null {
  const details = loader(html, "jobDetails");
  const data = details?.jobsData;
  return data && typeof data === "object" ? (data as AppleDetail) : null;
}

/** Description HTML built from a posting, with its level range stated up front. */
export function appleDescriptionHtml(summary: string, detail: AppleDetail | null): string {
  const text = (value: unknown) => asString(value).trim();
  const block = (heading: string, value: unknown) =>
    text(value) ? `<h3>${heading}</h3><p>${text(value).replace(/\n/g, "<br>")}</p>` : "";
  const levels = [text(detail?.lowJobTitle), text(detail?.highJobTitle)].filter(Boolean);
  return [
    levels.length ? `<p>Apple job level: ${[...new Set(levels)].join(" to ")}</p>` : "",
    block("Summary", detail?.jobSummary ?? summary),
    block("Description", detail?.description),
    block("Minimum qualifications", detail?.minimumQualifications),
    block("Preferred qualifications", detail?.preferredQualifications),
  ].join("\n");
}

function maxPages(): number {
  const raw = Number.parseInt(process.env.AUTOAPPLY_CAREERS_MAX_PAGES ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 10;
}

export const appleJobsAdapter: SourceAdapter = {
  kind: "apple",

  listUrl(company: Company): string {
    return appleSearchUrl(company.board, company.query, 1);
  },

  boardUrl(company: Company): string {
    return appleSearchUrl(company.board, company.query, 1);
  },

  async listJobs(company: Company, capturedAt: string): Promise<Job[]> {
    const results: AppleResult[] = [];
    const seen = new Set<string>();
    for (let page = 1; page <= maxPages(); page += 1) {
      const { results: found, total } = parseAppleSearch(await fetchText(appleSearchUrl(company.board, company.query, page)));
      const fresh = found.filter((result) => {
        const id = asString(result.id);
        if (!id || seen.has(id)) return false;
        seen.add(id);
        return true;
      });
      results.push(...fresh);
      if (fresh.length < PAGE_SIZE || (total !== null && results.length >= total)) break;
    }

    const jobs: Job[] = [];
    for (const result of results) {
      const id = asString(result.id);
      const slug = asString(result.transformedPostingTitle);
      let detail: AppleDetail | null = null;
      try {
        detail = parseAppleDetail(await fetchText(appleJobUrl(id, slug)));
      } catch (error) {
        logger.warn("apple posting page unreadable; keeping the search summary", { id, error: String(error) });
      }
      const locations = appleLocationNames(detail?.locations?.length ? detail.locations : result.locations);
      jobs.push(
        normalizeJob(
          {
            company,
            externalId: id,
            title: asString(result.postingTitle),
            locations,
            url: appleJobUrl(id, slug),
            applyUrl: appleApplyUrl(id),
            descriptionHtml: appleDescriptionHtml(asString(result.jobSummary), detail),
            postedAt: asString(result.postDateInGMT) || null,
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
    const { results, total } = parseAppleSearch(await fetchText(appleSearchUrl(company.board, company.query, 1)));
    return {
      ok: results.length > 0,
      postings: total ?? results.length,
      sampleTitles: results.slice(0, 3).map((result) => asString(result.postingTitle)),
      detail: results.length > 0 ? "search returned postings" : "search matched no postings",
    };
  },
};
