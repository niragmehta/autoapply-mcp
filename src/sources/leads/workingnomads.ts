import { z } from "zod";
import { fetchJson } from "../http.js";
import { SOURCE_MIN_INTERVAL_MS, parseSourceResponse, parseSourceSearchInput } from "../leadTypes.js";
import type { JobLead, SourceAttribution, SourceSearchInput, SourceSearchResult } from "../leadTypes.js";
import { absoluteDate } from "../smb/dates.js";
import { matchesQuery } from "../smb/query.js";
import {
  buildLead, cachedFetch, containsText, httpsUrl, matchesCountry, pageSlice, parseRows, skippedNotice,
} from "./common.js";

/**
 * Working Nomads public job feed (`/api/exposed_jobs/`): its most recent
 * remote jobs in one JSON array. There are no query parameters, so every
 * filter runs locally over the cached feed.
 *
 * Endpoint behaviour adapted from career-ops (MIT).
 */

const ENDPOINT = "https://www.workingnomads.com/api/exposed_jobs/";
const HOSTS = ["workingnomads.com"];
const CACHE_TTL_MS = 15 * 60_000;

const JobSchema = z.object({
  url: z.string().min(1),
  title: z.string().trim().min(1),
  description: z.string().nullish(),
  company_name: z.string().nullish(),
  category_name: z.string().nullish(),
  tags: z.string().nullish(),
  location: z.string().nullish(),
  pub_date: z.string().nullish(),
});
type NomadJob = z.infer<typeof JobSchema> & { sourceUrl: string };

const ATTRIBUTION: SourceAttribution = {
  label: "Working Nomads",
  url: "https://www.workingnomads.com",
  changes: "Fields normalized into unverified job leads; original listing links retained.",
  requirements: [
    "Credit Working Nomads as the source and link to its listing.",
    "Do not republish Working Nomads listings.",
  ],
};
const LIMITATIONS = [
  "Working Nomads exposes only its most recent jobs (a few dozen) without documented terms or search; all filters run locally.",
  "The feed is cached for 15 minutes; repeat searches do not refetch it.",
  "Listing links are Working Nomads redirects to the employer; they are never followed here.",
  "Verify each lead on the employer's own careers site before preparing an application.",
] as const;

function toLead(job: NomadJob, retrievedAt: string): JobLead {
  const location = job.location?.trim() ?? "";
  return buildLead("workingnomads", ENDPOINT, retrievedAt, {
    sourceId: /\/job\/go\/(\d+)/.exec(job.sourceUrl)?.[1] ?? job.sourceUrl,
    sourceUrl: job.sourceUrl,
    title: job.title,
    company: job.company_name?.trim() ?? "",
    locations: location ? [`Remote — ${location}`] : ["Remote — location restrictions unspecified"],
    locationRestrictions: location ? location.split(/\s*,\s*/).filter(Boolean) : [],
    timezoneRestrictions: [],
    description: job.description ?? "",
    publishedAt: absoluteDate(job.pub_date) ?? undefined,
    publishedAtRaw: job.pub_date ?? undefined,
  });
}

export async function searchWorkingNomads(input: SourceSearchInput): Promise<SourceSearchResult> {
  const search = parseSourceSearchInput(input);
  const { value, retrievedAt } = await cachedFetch(ENDPOINT, CACHE_TTL_MS, () =>
    fetchJson<unknown>(ENDPOINT, { allowedHosts: ["www.workingnomads.com"], minIntervalMs: SOURCE_MIN_INTERVAL_MS }));
  const { items, skipped } = parseRows(parseSourceResponse(z.array(z.unknown()), value, "workingnomads"), (row) => {
    const parsed = JobSchema.safeParse(row);
    const sourceUrl = parsed.success ? httpsUrl(parsed.data.url, HOSTS) : undefined;
    return parsed.success && sourceUrl ? { ...parsed.data, sourceUrl } : null;
  }, "workingnomads");
  const matches = items.filter((job) => {
    const location = job.location ?? "";
    return matchesQuery(search.query, job.title, job.tags, job.category_name)
      && matchesCountry(location, search.country)
      && containsText(location, search.location)
      && containsText(job.company_name ?? "", search.company)
      && containsText(job.category_name ?? "", search.category);
  }).map((job) => toLead(job, retrievedAt));
  const { items: leads, pagination } = pageSlice(matches, search.page ?? 1, search.limit);
  return {
    source: "workingnomads", readiness: "ready", leads, pagination, attribution: ATTRIBUTION,
    limitations: [...LIMITATIONS, ...skippedNotice(skipped)],
  };
}
