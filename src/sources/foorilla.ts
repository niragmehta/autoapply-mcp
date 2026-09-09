import { z } from "zod";
import { AppError } from "../util/errors.js";
import { fetchJson } from "./http.js";
import {
  OptionalSourceUrlSchema, SourceTimestampSchema, SOURCE_MIN_INTERVAL_MS,
  TRUNCATED_PAGE_NOTICE, leadSalary, parseSourceResponse, parseSourceSearchInput, sourcePagination, sourcePublishedAt,
} from "./leadTypes.js";
import type { JobLead, SourceAttribution, SourceSearchInput, SourceSearchResult } from "./leadTypes.js";

const ENDPOINT = "https://foorilla.com/api/v1/hiring/job/";
const FoorillaJobSchema = z.object({
  id: z.number().int().positive(),
  title: z.string().min(1),
  company: z.object({ name: z.string().min(1) }),
  location: z.string().nullish(),
  countries: z.array(z.object({ name: z.string().min(1) })).nullish(),
  published: SourceTimestampSchema,
  apply_url: OptionalSourceUrlSchema,
  salary_min: z.number().nonnegative().nullish(),
  salary_max: z.number().nonnegative().nullish(),
  salary_currency: z.string().nullish(),
});
const FoorillaResponseSchema = z.object({
  results: z.array(FoorillaJobSchema).max(100),
  count: z.number().int().nonnegative(),
  pages: z.number().int().nonnegative(),
  page: z.number().int().positive(),
  page_size: z.number().int().positive().max(1000),
}).refine((page) =>
  page.results.length <= page.count && page.results.length <= page.page_size && (page.count === 0 || page.pages > 0), {
  message: "Inconsistent search pagination.",
});
type FoorillaJob = z.infer<typeof FoorillaJobSchema>;

const ATTRIBUTION: SourceAttribution = {
  label: "Foorilla",
  url: "https://foorilla.com",
  license: "CC BY-SA 4.0",
  licenseUrl: "https://creativecommons.org/licenses/by-sa/4.0/",
  changes: "Fields normalized into unverified job leads; estimated and converted salaries omitted.",
  requirements: [
    "Credit Foorilla, link to the source and CC BY-SA 4.0 license, and indicate normalization changes.",
    "Comply with the CC BY-SA 4.0 share-alike requirements when sharing adapted data.",
    "Attribution guidance: https://foorilla.com/api/list/attribution/",
  ],
};
const LIMITATIONS = [
  "Requires an authorized API key and active PRO+ subscription. No account creation, purchase or login is automated.",
  "Verify each lead on the employer's careers site; this connector neither stores verified jobs nor follows application links.",
  "The documented job schema does not supply a job description or pay period. Neither is invented; estimated/converted salary fields are excluded.",
  "Source URLs identify documented API detail resources, not invented public job-page or ATS URLs.",
  "Title, location and company are partial-string filters. Country uses Foorilla's internal numeric taxonomy IDs, not ISO country codes.",
  "At most one filtered page is fetched per call, with a 100-lead client cap and a minimum 700ms per-host interval.",
] as const;

function toLead(job: FoorillaJob, endpoint: string, retrievedAt: string): JobLead {
  return {
    source: "foorilla",
    sourceId: String(job.id),
    sourceUrl: `${ENDPOINT}${job.id}`,
    title: job.title,
    company: job.company.name,
    locations: job.location ? [job.location] : [],
    locationRestrictions: (job.countries ?? []).map((country) => country.name),
    timezoneRestrictions: [],
    description: "",
    applyUrl: job.apply_url || undefined,
    salary: leadSalary(job.salary_min, job.salary_max, job.salary_currency),
    publishedAt: sourcePublishedAt(job.published),
    provenance: { kind: "aggregator", endpoint, retrievedAt, publishedAtRaw: job.published ?? undefined },
    mustVerifyEmployer: true,
  };
}

async function requestJobs(url: string, apiKey: string): Promise<unknown> {
  try {
    return await fetchJson<unknown>(url, {
      allowedHosts: ["foorilla.com"],
      headers: { "Api-Key": apiKey },
      minIntervalMs: SOURCE_MIN_INTERVAL_MS,
    });
  } catch (error) {
    if (error instanceof AppError && [401, 403].includes(Number(error.details.status))) {
      throw new AppError("source_auth_required", "Foorilla requires a valid API key and active PRO+ subscription.");
    }
    // A transport implementation may include request headers in errors; never propagate their values.
    throw new AppError(error instanceof AppError ? error.code : "source_request_failed", "Foorilla request failed.");
  }
}

export async function searchFoorilla(input: SourceSearchInput): Promise<SourceSearchResult> {
  const search = parseSourceSearchInput(input);
  const apiKey = process.env.AUTOAPPLY_FOORILLA_API_KEY?.trim();
  if (!apiKey) {
    throw new AppError("source_auth_required", "Set AUTOAPPLY_FOORILLA_API_KEY for an authorized Foorilla PRO+ account.");
  }
  if (search.country) {
    throw new AppError("source_filter_unsupported", "Foorilla country filters require internal taxonomy IDs. Use location text instead.");
  }
  const url = new URL(ENDPOINT);
  url.search = new URLSearchParams({
    title: search.query, page: String(search.page ?? 1), page_size: String(search.limit),
    ...(search.location ? { location: search.location } : {}),
    ...(search.company ? { company: search.company } : {}),
  }).toString();
  const data = parseSourceResponse(FoorillaResponseSchema, await requestJobs(url.href, apiKey), "foorilla");
  const retrievedAt = new Date().toISOString();
  const leads = data.results.slice(0, search.limit).map((job) => toLead(job, url.href, retrievedAt));
  const pagination = sourcePagination(data.page, data.page_size, data.results.length, leads.length, data.count, data.pages);
  return {
    source: "foorilla", readiness: "ready", leads, pagination, attribution: ATTRIBUTION,
    limitations: [...LIMITATIONS, ...(pagination.truncated ? [TRUNCATED_PAGE_NOTICE] : [])],
  };
}
