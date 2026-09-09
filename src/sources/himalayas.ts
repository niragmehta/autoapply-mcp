import { z } from "zod";
import { AppError } from "../util/errors.js";
import { fetchJson } from "./http.js";
import {
  HttpUrlSchema, OptionalSourceUrlSchema, SourceTimestampSchema, SOURCE_MIN_INTERVAL_MS,
  TRUNCATED_PAGE_NOTICE, leadSalary, parseSourceResponse, parseSourceSearchInput, sourcePagination, sourcePublishedAt,
} from "./leadTypes.js";
import type { JobLead, SourceAttribution, SourceSearchInput, SourceSearchResult } from "./leadTypes.js";

const ENDPOINT = "https://himalayas.app/jobs/api/search";
const CountrySchema = z.union([z.string().min(1), z.object({
  name: z.string().min(1), alpha2: z.string().optional(), slug: z.string().optional(),
})]);

// The live API uses country strings and numeric UTC offsets; OpenAPI also documents objects/strings.
const HimalayasJobSchema = z.object({
  guid: z.string().min(1),
  title: z.string().min(1),
  companyName: z.string().min(1),
  description: z.string().nullish(),
  excerpt: z.string().nullish(),
  applicationLink: OptionalSourceUrlSchema,
  pubDate: SourceTimestampSchema,
  locationRestrictions: z.array(CountrySchema).nullish(),
  timezoneRestrictions: z.array(z.union([z.string(), z.number().min(-14).max(14)])).nullish(),
  minSalary: z.number().nonnegative().nullish(),
  maxSalary: z.number().nonnegative().nullish(),
  currency: z.string().nullish(),
  salaryPeriod: z.string().nullish(),
});
const HimalayasResponseSchema = z.object({
  updatedAt: SourceTimestampSchema,
  offset: z.number().int().nonnegative(),
  limit: z.number().int().positive().max(100),
  totalCount: z.number().int().nonnegative(),
  jobs: z.array(HimalayasJobSchema).max(100),
}).refine((page) => page.jobs.length <= page.limit && page.jobs.length <= page.totalCount, {
  message: "Inconsistent search pagination.",
});
type HimalayasJob = z.infer<typeof HimalayasJobSchema>;

const ATTRIBUTION: SourceAttribution = {
  label: "Himalayas",
  url: "https://himalayas.app",
  changes: "Fields normalized into unverified job leads; original descriptions and application links retained.",
  requirements: [
    "Credit Himalayas as the original source and link back to the original Himalayas listing when available.",
    "Do not submit or republish Himalayas jobs onto third-party job websites.",
  ],
};
const LIMITATIONS = [
  "Verify each lead on the employer's own careers site before preparing an application; aggregate metadata is not employer verification.",
  "One filtered search page is fetched. Search is page-based; the separate browse feed uses cursors and a maximum of 20 jobs.",
  "Search has no city/location filter; use country. Company accepts canonical Himalayas company slugs.",
  "Data may be cached for 24 hours. Salary fields are aggregator-reported, not independently verified or annualized.",
  "Attribute Himalayas and link back; do not republish these listings to third-party job sites.",
] as const;

function restrictions(job: HimalayasJob): { locations: string[]; locationRestrictions: string[] } {
  const names = (job.locationRestrictions ?? []).map((country) => typeof country === "string" ? country : country.name);
  const locations = job.locationRestrictions == null
    ? ["Remote — location restrictions unspecified"]
    : names.length === 0 ? ["Remote — Worldwide"] : names.map((name) => `Remote — ${name}`);
  return { locations, locationRestrictions: names };
}

function toLead(job: HimalayasJob, endpoint: string, retrievedAt: string): JobLead {
  const guidUrl = HttpUrlSchema.safeParse(job.guid);
  return {
    source: "himalayas",
    sourceId: job.guid,
    sourceUrl: guidUrl.success ? guidUrl.data : endpoint,
    title: job.title,
    company: job.companyName,
    ...restrictions(job),
    timezoneRestrictions: (job.timezoneRestrictions ?? []).map((offset) =>
      typeof offset === "string" ? offset : `UTC${offset >= 0 ? "+" : ""}${offset}`),
    description: job.description ?? job.excerpt ?? "",
    applyUrl: job.applicationLink || undefined,
    salary: leadSalary(job.minSalary, job.maxSalary, job.currency, job.salaryPeriod),
    publishedAt: sourcePublishedAt(job.pubDate),
    provenance: { kind: "aggregator", endpoint, retrievedAt, publishedAtRaw: job.pubDate ?? undefined },
    mustVerifyEmployer: true,
  };
}

export async function searchHimalayas(input: SourceSearchInput): Promise<SourceSearchResult> {
  const search = parseSourceSearchInput(input);
  if (search.location) {
    throw new AppError("source_filter_unsupported", "Himalayas search supports country, not a city/location filter.");
  }
  const url = new URL(ENDPOINT);
  url.search = new URLSearchParams({
    q: search.query, page: String(search.page ?? 1),
    ...(search.country ? { country: search.country } : {}),
    ...(search.company ? { company: search.company } : {}),
  }).toString();
  const data = parseSourceResponse(HimalayasResponseSchema, await fetchJson<unknown>(url.href, {
    allowedHosts: ["himalayas.app"], minIntervalMs: SOURCE_MIN_INTERVAL_MS,
  }), "himalayas");
  const retrievedAt = new Date().toISOString();
  const leads = data.jobs.slice(0, search.limit).map((job) => toLead(job, url.href, retrievedAt));
  const pagination = sourcePagination(
    search.page ?? 1, data.limit, data.jobs.length, leads.length, data.totalCount,
  );
  return {
    source: "himalayas", readiness: "ready", leads, pagination, attribution: ATTRIBUTION,
    limitations: [...LIMITATIONS, ...(pagination.truncated ? [TRUNCATED_PAGE_NOTICE] : [])],
  };
}
