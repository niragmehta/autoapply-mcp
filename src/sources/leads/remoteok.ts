import { z } from "zod";
import { fetchJson } from "../http.js";
import {
  OptionalSourceUrlSchema, SOURCE_MIN_INTERVAL_MS, SourceTimestampSchema, leadSalary, parseSourceResponse,
  parseSourceSearchInput,
} from "../leadTypes.js";
import type { JobLead, SourceAttribution, SourceSearchInput, SourceSearchResult } from "../leadTypes.js";
import { absoluteDate } from "../smb/dates.js";
import { matchesQuery } from "../smb/query.js";
import {
  buildLead, cachedFetch, containsText, httpsUrl, matchesCountry, pageSlice, parseRows, repairMojibake, skippedNotice,
} from "./common.js";

/**
 * Remote OK public API: the newest ~100 remote jobs in one JSON array.
 * https://remoteok.com/api
 *
 * The API has no search parameters, so every filter runs locally over the
 * cached feed. Its first element is a legal notice, not a job.
 *
 * Endpoint behaviour adapted from career-ops (MIT).
 */

const ENDPOINT = "https://remoteok.com/api";
const HOSTS = ["remoteok.com"];
const CACHE_TTL_MS = 15 * 60_000;

const JobSchema = z.object({
  id: z.union([z.string().min(1), z.number().int().nonnegative()]).transform(String),
  position: z.string().trim().min(1),
  company: z.string().nullish(),
  url: OptionalSourceUrlSchema,
  apply_url: OptionalSourceUrlSchema,
  description: z.string().nullish(),
  location: z.string().nullish(),
  tags: z.array(z.string()).nullish(),
  date: SourceTimestampSchema,
  epoch: z.number().nullish(),
  salary_min: z.number().nonnegative().nullish(),
  salary_max: z.number().nonnegative().nullish(),
});
type RemoteOkJob = z.infer<typeof JobSchema>;

const ATTRIBUTION: SourceAttribution = {
  label: "Remote OK",
  url: "https://remoteok.com",
  changes: "Fields normalized into unverified job leads; double-encoded text repaired; original listing links retained.",
  requirements: [
    "Link back to each listing's Remote OK URL with a followed link (no nofollow) and mention Remote OK as the source.",
    "Do not use the Remote OK logo without written permission.",
  ],
};
const LIMITATIONS = [
  "Remote OK's API returns only its newest ~100 jobs. Query, country, location and company filters run locally on that feed.",
  "The feed is cached for 15 minutes; repeat searches do not refetch it.",
  "Salary bounds are aggregator-reported without currency or period; zero means not stated.",
  "Remote OK's robots.txt signals ai-train=no: use listings for search and reference only, never model training.",
  "Verify each lead on the employer's own careers site before preparing an application.",
] as const;

function toLead(job: RemoteOkJob, retrievedAt: string): JobLead {
  const sourceUrl = httpsUrl(job.url, HOSTS) ?? `https://remoteok.com/remote-jobs/${job.id}`;
  const location = repairMojibake(job.location?.trim() ?? "");
  return buildLead("remoteok", ENDPOINT, retrievedAt, {
    sourceId: job.id,
    sourceUrl,
    title: repairMojibake(job.position),
    company: repairMojibake(job.company?.trim() ?? ""),
    locations: location ? [location] : [],
    locationRestrictions: location ? [location] : [],
    timezoneRestrictions: [],
    description: repairMojibake(job.description ?? ""),
    salary: leadSalary(job.salary_min || null, job.salary_max || null, undefined),
    publishedAt: absoluteDate(job.date ?? job.epoch) ?? undefined,
    applyUrl: httpsUrl(job.apply_url) ?? sourceUrl,
    publishedAtRaw: job.date ?? job.epoch ?? undefined,
  });
}

export async function searchRemoteOk(input: SourceSearchInput): Promise<SourceSearchResult> {
  const search = parseSourceSearchInput(input);
  const { value, retrievedAt } = await cachedFetch(ENDPOINT, CACHE_TTL_MS, () =>
    fetchJson<unknown>(ENDPOINT, { allowedHosts: HOSTS, minIntervalMs: SOURCE_MIN_INTERVAL_MS }));
  const rows = parseSourceResponse(z.array(z.unknown()), value, "remoteok")
    .filter((row) => !(row && typeof row === "object" && "legal" in row));
  const { items, skipped } = parseRows(rows, (row) => {
    const parsed = JobSchema.safeParse(row);
    return parsed.success ? parsed.data : null;
  }, "remoteok");
  const matches = items.filter((job) => {
    const location = repairMojibake(job.location ?? "");
    return matchesQuery(search.query, repairMojibake(job.position), ...(job.tags ?? []))
      && matchesCountry(location, search.country)
      && containsText(location, search.location)
      && containsText(repairMojibake(job.company ?? ""), search.company);
  }).map((job) => toLead(job, retrievedAt));
  const { items: leads, pagination } = pageSlice(matches, search.page ?? 1, search.limit);
  return {
    source: "remoteok", readiness: "ready", leads, pagination, attribution: ATTRIBUTION,
    limitations: [...LIMITATIONS, ...skippedNotice(skipped)],
  };
}
