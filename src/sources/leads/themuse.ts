import { z } from "zod";
import { AppError } from "../../util/errors.js";
import { fetchJson } from "../http.js";
import { SOURCE_MIN_INTERVAL_MS, parseSourceResponse, parseSourceSearchInput, sourcePagination } from "../leadTypes.js";
import type { JobLead, SourceAttribution, SourceSearchInput, SourceSearchResult } from "../leadTypes.js";
import { absoluteDate } from "../smb/dates.js";
import { buildLead, cachedFetch, httpsUrl, parseRows, skippedNotice, unsupportedFilter } from "./common.js";
import { MUSE_CATEGORIES } from "./museCategories.js";

/**
 * The Muse public jobs API.
 * https://www.themuse.com/developers/api/v2
 *
 * The API has no keyword search: it filters by category, company and
 * location only. The query must therefore name a Muse category (for example
 * "Software Engineering"); anything else is rejected rather than silently
 * returning unrelated jobs. Unregistered use is limited to 500 requests an
 * hour and is meant for testing; set AUTOAPPLY_THEMUSE_API_KEY after
 * registering an app. The key is sent as the documented `api_key` query
 * parameter and is never echoed in results or errors.
 *
 * Endpoint behaviour adapted from career-ops (MIT).
 */

const ENDPOINT = "https://www.themuse.com/api/public/jobs";
const HOSTS = ["www.themuse.com"];
const CACHE_TTL_MS = 10 * 60_000;
const PAGE_SIZE = 20;

const JobSchema = z.object({
  id: z.union([z.number().int().nonnegative(), z.string().min(1)]).transform(String),
  name: z.string().trim().min(1),
  contents: z.string().nullish(),
  publication_date: z.string().nullish(),
  locations: z.array(z.object({ name: z.string() })).nullish(),
  categories: z.array(z.object({ name: z.string() })).nullish(),
  levels: z.array(z.object({ name: z.string() })).nullish(),
  refs: z.object({ landing_page: z.string().nullish() }).nullish(),
  company: z.object({ name: z.string().nullish() }).nullish(),
});
const PageSchema = z.object({
  page: z.number().int().nonnegative(),
  page_count: z.number().int().nonnegative(),
  total: z.number().int().nonnegative().optional(),
  results: z.array(z.unknown()),
});
type MuseJob = z.infer<typeof JobSchema>;

const ATTRIBUTION: SourceAttribution = {
  label: "The Muse",
  url: "https://www.themuse.com",
  changes: "Fields normalized into unverified job leads; original landing pages retained.",
  requirements: [
    "Credit The Muse and link each listing to its The Muse landing page.",
    "Use of the API is subject to The Muse API terms; register an app for anything beyond testing.",
  ],
};
const LIMITATIONS = [
  "No keyword search: query must be a Muse category such as \"Software Engineering\" or \"Data Science\".",
  "Location uses The Muse's own names, e.g. \"San Francisco, CA\" or \"Flexible / Remote\". Country is not supported.",
  "Unregistered requests are limited to 500 an hour and meant for testing; set AUTOAPPLY_THEMUSE_API_KEY for ongoing use.",
  "Verify each lead on the employer's own careers site before preparing an application.",
] as const;

function category(query: string): string {
  const match = MUSE_CATEGORIES.find((name) => name.toLowerCase() === query.trim().toLowerCase());
  if (!match) {
    throw unsupportedFilter("The Muse", "keyword query",
      `Its API has no keyword search; query must be one of its categories: ${MUSE_CATEGORIES.join(", ")}.`);
  }
  return match;
}

function toLead(job: MuseJob, endpoint: string, retrievedAt: string): JobLead {
  const locations = (job.locations ?? []).map((location) => location.name.trim()).filter(Boolean);
  return buildLead("themuse", endpoint, retrievedAt, {
    sourceId: job.id,
    sourceUrl: httpsUrl(job.refs?.landing_page, ["themuse.com"]) ?? `https://www.themuse.com/jobs?job=${job.id}`,
    title: job.name,
    company: job.company?.name?.trim() ?? "",
    locations,
    locationRestrictions: [],
    timezoneRestrictions: [],
    description: job.contents ?? "",
    publishedAt: absoluteDate(job.publication_date) ?? undefined,
    publishedAtRaw: job.publication_date ?? undefined,
  });
}

async function request(url: URL): Promise<unknown> {
  const key = process.env.AUTOAPPLY_THEMUSE_API_KEY?.trim();
  const target = new URL(url.href);
  if (key) target.searchParams.set("api_key", key);
  try {
    return await fetchJson<unknown>(target.href, { allowedHosts: HOSTS, minIntervalMs: SOURCE_MIN_INTERVAL_MS });
  } catch (error) {
    // Transport errors embed the request URL, which may carry the API key.
    throw new AppError(error instanceof AppError ? error.code : "source_request_failed", "The Muse request failed.", {
      status: error instanceof AppError ? error.details.status : undefined,
    });
  }
}

export async function searchTheMuse(input: SourceSearchInput): Promise<SourceSearchResult> {
  const search = parseSourceSearchInput(input);
  const url = new URL(ENDPOINT);
  url.search = new URLSearchParams({
    page: String((search.page ?? 1) - 1),
    category: category(search.query),
    ...(search.location ? { location: search.location } : {}),
    ...(search.company ? { company: search.company } : {}),
  }).toString();
  const { value, retrievedAt } = await cachedFetch(url.href, CACHE_TTL_MS, () => request(url));
  const data = parseSourceResponse(PageSchema, value, "themuse");
  const { items, skipped } = parseRows(data.results, (row) => {
    const parsed = JobSchema.safeParse(row);
    return parsed.success ? parsed.data : null;
  }, "themuse");
  const leads = items.slice(0, search.limit).map((job) => toLead(job, url.href, retrievedAt));
  const pagination = sourcePagination(search.page ?? 1, PAGE_SIZE, items.length, leads.length,
    data.total ?? data.page_count * PAGE_SIZE, data.page_count);
  return {
    source: "themuse", readiness: "ready", leads, pagination, attribution: ATTRIBUTION,
    limitations: [...LIMITATIONS, ...skippedNotice(skipped)],
  };
}
