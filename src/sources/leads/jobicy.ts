import { z } from "zod";
import { fetchJson } from "../http.js";
import { SOURCE_MIN_INTERVAL_MS, leadSalary, parseSourceResponse, parseSourceSearchInput } from "../leadTypes.js";
import type { JobLead, SourceAttribution, SourceSearchInput, SourceSearchResult } from "../leadTypes.js";
import { absoluteDate } from "../smb/dates.js";
import { countryCode } from "../smb/geo.js";
import { isWildcardQuery, matchesQuery } from "../smb/query.js";
import {
  buildLead, cachedFetch, containsText, httpsUrl, openEndedPagination, parseRows, plain, skippedNotice, unsupportedFilter,
} from "./common.js";

/**
 * Jobicy public Jobs API (remote jobs from the last seven days).
 * https://jobicy.com/jobs-rss-feed
 *
 * `tag`, `geo` and `industry` filter at the source; pages continue with an
 * opaque cursor, so page N replays N-1 cursors (capped at page 5). Jobicy asks
 * that listings credit it with a direct link and that application buttons
 * lead to the Jobicy job URL, which is therefore the lead's apply link.
 */

const ENDPOINT = "https://jobicy.com/api/jobs";
const HOSTS = ["jobicy.com"];
const CACHE_TTL_MS = 10 * 60_000;
const PAGE_SIZE = 50;
const MAX_PAGE = 5;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const JobSchema = z.object({
  id: z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]).transform(String),
  url: z.string().min(1),
  jobTitle: z.string().min(1),
  companyName: z.string().nullish(),
  jobIndustry: z.array(z.string()).nullish(),
  jobType: z.array(z.string()).nullish(),
  jobGeo: z.string().nullish(),
  jobLevel: z.string().nullish(),
  jobDescription: z.string().nullish(),
  jobExcerpt: z.string().nullish(),
  pubDate: z.string().nullish(),
  salaryMin: z.number().nonnegative().nullish(),
  salaryMax: z.number().nonnegative().nullish(),
  salaryCurrency: z.string().nullish(),
  salaryPeriod: z.string().nullish(),
});
const PageSchema = z.object({
  jobs: z.array(z.unknown()),
  nextCursor: z.string().nullish(),
  hasMore: z.boolean().optional(),
});
type JobicyJob = z.infer<typeof JobSchema>;

const ATTRIBUTION: SourceAttribution = {
  label: "Jobicy",
  url: "https://jobicy.com",
  changes: "Fields normalized into unverified job leads; entity-encoded titles decoded.",
  requirements: [
    "Clearly credit Jobicy as the original source with a direct link to the listing.",
    "Application buttons must lead to the original Jobicy job URL provided in the feed.",
    "Do not present Jobicy listings as your own original postings.",
  ],
};
const LIMITATIONS = [
  "Jobicy's public API covers remote jobs published in the last seven days; older listings are not returned.",
  "Country maps to Jobicy's geo slug (usa, canada, europe, ...); location is not supported. Category is a Jobicy industry slug such as engineering.",
  "Jobicy reports no total; pagination.total is a lower bound. Pages beyond 5 are not fetched.",
  "Verify each lead on the employer's own careers site before preparing an application.",
] as const;

function geoSlug(country: string | undefined): string | undefined {
  if (!country) return undefined;
  const code = countryCode(country);
  if (code === "US") return "usa";
  if (code === "CA") return "canada";
  const slug = country.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  if (!SLUG.test(slug)) throw unsupportedFilter("Jobicy", "country", "Use a Jobicy geo slug such as usa, canada or europe.");
  return slug;
}

function toLead(job: JobicyJob, endpoint: string, retrievedAt: string): JobLead {
  const geo = plain(job.jobGeo);
  const sourceUrl = httpsUrl(job.url, HOSTS) ?? `https://jobicy.com/jobs/${job.id}`;
  return buildLead("jobicy", endpoint, retrievedAt, {
    sourceId: job.id,
    sourceUrl,
    title: plain(job.jobTitle),
    company: plain(job.companyName),
    locations: [geo ? `Remote — ${geo}` : "Remote — location restrictions unspecified"],
    locationRestrictions: geo ? [geo] : [],
    timezoneRestrictions: [],
    description: job.jobDescription ?? job.jobExcerpt ?? "",
    salary: leadSalary(job.salaryMin || null, job.salaryMax || null, job.salaryCurrency, job.salaryPeriod),
    publishedAt: absoluteDate(job.pubDate) ?? undefined,
    applyUrl: sourceUrl,
    publishedAtRaw: job.pubDate ?? undefined,
  });
}

async function readPage(params: URLSearchParams, cursor: string | null): Promise<{ data: z.infer<typeof PageSchema>; url: string; retrievedAt: string }> {
  const url = new URL(ENDPOINT);
  url.search = new URLSearchParams([...params, ...(cursor ? [["cursor", cursor] as [string, string]] : [])]).toString();
  const { value, retrievedAt } = await cachedFetch(url.href, CACHE_TTL_MS, () =>
    fetchJson<unknown>(url.href, { allowedHosts: HOSTS, minIntervalMs: SOURCE_MIN_INTERVAL_MS }));
  return { data: parseSourceResponse(PageSchema, value, "jobicy"), url: url.href, retrievedAt };
}

export async function searchJobicy(input: SourceSearchInput): Promise<SourceSearchResult> {
  const search = parseSourceSearchInput(input);
  const page = search.page ?? 1;
  if (page > MAX_PAGE) throw unsupportedFilter("Jobicy", "page", `Pages beyond ${MAX_PAGE} are not fetched; narrow the search instead.`);
  if (search.category && !SLUG.test(search.category)) throw unsupportedFilter("Jobicy", "category", "Use an industry slug such as engineering.");
  const geo = geoSlug(search.country);
  const params = new URLSearchParams({
    count: String(PAGE_SIZE),
    ...(isWildcardQuery(search.query) ? {} : { tag: search.query }),
    ...(geo ? { geo } : {}),
    ...(search.category ? { industry: search.category } : {}),
  });
  let cursor: string | null = null;
  let current = await readPage(params, null);
  for (let index = 1; index < page; index += 1) {
    cursor = current.data.nextCursor ?? null;
    if (!cursor) break;
    current = await readPage(params, cursor);
  }
  const exhausted = page > 1 && !cursor;
  const { items, skipped } = exhausted ? { items: [], skipped: 0 } : parseRows(current.data.jobs, (row) => {
    const parsed = JobSchema.safeParse(row);
    return parsed.success ? parsed.data : null;
  }, "jobicy");
  const matches = items.filter((job) => containsText(plain(job.companyName), search.company)
    // Jobicy's tag search is broad; titles and industries keep leads on topic.
    && matchesQuery(search.query, plain(job.jobTitle), ...(job.jobIndustry ?? [])));
  const leads = matches.slice(0, search.limit).map((job) => toLead(job, current.url, current.retrievedAt));
  const hasMore = !exhausted && Boolean(current.data.nextCursor) && current.data.hasMore !== false;
  return {
    source: "jobicy", readiness: "ready", leads,
    pagination: openEndedPagination(page, PAGE_SIZE, matches.length, leads.length, hasMore),
    attribution: ATTRIBUTION,
    limitations: [
      ...LIMITATIONS, ...skippedNotice(skipped),
      ...(matches.length < items.length ? ["Some listings on this page did not match the query or company locally; later pages may hold more."] : []),
    ],
  };
}
