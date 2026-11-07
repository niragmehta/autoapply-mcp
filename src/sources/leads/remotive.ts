import { z } from "zod";
import { fetchJson } from "../http.js";
import { parseSourceResponse, parseSourceSearchInput } from "../leadTypes.js";
import type { JobLead, SourceAttribution, SourceSearchInput, SourceSearchResult } from "../leadTypes.js";
import { absoluteDate } from "../smb/dates.js";
import { textPay } from "../smb/pay.js";
import { isWildcardQuery, matchesQuery } from "../smb/query.js";
import {
  buildLead, cachedFetch, containsText, httpsUrl, matchesCountry, pageSlice, parseRows, salaryFromRange, skippedNotice,
} from "./common.js";

/**
 * Remotive public remote-jobs API.
 * https://github.com/remotive-com/remote-jobs-api
 *
 * `search`, `category` and `company_name` filter at the source; country and
 * location filter Remotive's "candidate required location" locally. Remotive
 * blocks clients making more than two requests a minute and advises a few
 * fetches a day, so requests are spaced 30 seconds apart and each distinct
 * search is cached for six hours.
 *
 * Endpoint behaviour adapted from career-ops (MIT).
 */

const ENDPOINT = "https://remotive.com/api/remote-jobs";
const HOSTS = ["remotive.com"];
const MIN_INTERVAL_MS = 30_000;
const CACHE_TTL_MS = 6 * 60 * 60_000;

const JobSchema = z.object({
  id: z.union([z.number().int().nonnegative(), z.string().min(1)]).transform(String),
  url: z.string().min(1),
  title: z.string().trim().min(1),
  company_name: z.string().nullish(),
  category: z.string().nullish(),
  tags: z.array(z.string()).nullish(),
  job_type: z.string().nullish(),
  publication_date: z.string().nullish(),
  candidate_required_location: z.string().nullish(),
  salary: z.string().nullish(),
  description: z.string().nullish(),
});
type RemotiveJob = z.infer<typeof JobSchema>;

const ATTRIBUTION: SourceAttribution = {
  label: "Remotive",
  url: "https://remotive.com",
  changes: "Fields normalized into unverified job leads; salary text parsed only where its unit is stated.",
  requirements: [
    "Link back to each listing's Remotive URL and mention Remotive as the source.",
    "Do not submit Remotive jobs to third-party job sites (for example Jooble, Google Jobs or LinkedIn Jobs).",
    "Do not use Remotive listings to collect sign-ups or email addresses.",
  ],
};
const LIMITATIONS = [
  "Remotive's public API lists jobs with a 24-hour delay.",
  "Query is sent as Remotive's search (which also matches descriptions) and then matched locally against titles, tags and category.",
  "Requests are spaced at least 30 seconds apart (Remotive blocks more than two a minute) and each search is cached for six hours.",
  "Country and location match the listing's candidate-required-location text locally; worldwide or unspecified listings are kept.",
  "Salary is free text; amounts are kept only when a unit is stated and are not annualized.",
  "Verify each lead on the employer's own careers site before preparing an application.",
] as const;

function toLead(job: RemotiveJob, endpoint: string, retrievedAt: string): JobLead {
  const restriction = job.candidate_required_location?.trim() ?? "";
  return buildLead("remotive", endpoint, retrievedAt, {
    sourceId: job.id,
    sourceUrl: httpsUrl(job.url, HOSTS) ?? `https://remotive.com/remote-jobs/${job.id}`,
    title: job.title,
    company: job.company_name?.trim() ?? "",
    locations: restriction ? [`Remote — ${restriction}`] : ["Remote — location restrictions unspecified"],
    locationRestrictions: restriction ? restriction.split(/\s*[,;/]\s*/).filter(Boolean) : [],
    timezoneRestrictions: [],
    description: job.description ?? "",
    salary: salaryFromRange(textPay(job.salary)),
    publishedAt: absoluteDate(job.publication_date) ?? undefined,
    publishedAtRaw: job.publication_date ?? undefined,
  });
}

export async function searchRemotive(input: SourceSearchInput): Promise<SourceSearchResult> {
  const search = parseSourceSearchInput(input);
  const url = new URL(ENDPOINT);
  url.search = new URLSearchParams({
    ...(isWildcardQuery(search.query) ? {} : { search: search.query }),
    ...(search.category ? { category: search.category } : {}),
    ...(search.company ? { company_name: search.company } : {}),
  }).toString();
  const { value, retrievedAt } = await cachedFetch(url.href, CACHE_TTL_MS, () =>
    fetchJson<unknown>(url.href, { allowedHosts: HOSTS, minIntervalMs: MIN_INTERVAL_MS }));
  const data = parseSourceResponse(z.object({ jobs: z.array(z.unknown()) }), value, "remotive");
  const { items, skipped } = parseRows(data.jobs, (row) => {
    const parsed = JobSchema.safeParse(row);
    return parsed.success ? parsed.data : null;
  }, "remotive");
  const matches = items.filter((job) => {
    const restriction = job.candidate_required_location ?? "";
    // Remotive's search also matches descriptions; titles, tags and category keep leads on topic.
    return matchesQuery(search.query, job.title, job.category, ...(job.tags ?? []))
      && matchesCountry(restriction, search.country) && containsText(restriction, search.location);
  }).map((job) => toLead(job, url.href, retrievedAt));
  const { items: leads, pagination } = pageSlice(matches, search.page ?? 1, search.limit);
  return {
    source: "remotive", readiness: "ready", leads, pagination, attribution: ATTRIBUTION,
    limitations: [...LIMITATIONS, ...skippedNotice(skipped)],
  };
}
