import { z } from "zod";
import type { Company } from "../domain/campaign.js";
import type { Job, WorkplaceType } from "../domain/job.js";
import { AppError } from "../util/errors.js";
import { fetchJson } from "./http.js";
import {
  boardToken, boardVerification, locationLabel, nonEmptyText, normalizePublicJob,
  optionalText, parseSourcePayload, postingIdentifier, publishedDate,
} from "./sourceValidation.js";
import type { SourceAdapter } from "./types.js";

const ALLOWED_HOSTS = ["www.workable.com", "apply.workable.com"] as const;
const locationSchema = z.object({
  city: optionalText, region: optionalText, state: optionalText,
  country: optionalText, countryCode: optionalText, country_code: optionalText,
});
const postingSchema = z.object({
  shortcode: postingIdentifier,
  title: nonEmptyText,
  description: z.string(),
  requirements: optionalText,
  benefits: optionalText,
  locations: z.array(locationSchema).nullish(),
  location: z.union([z.string(), locationSchema]).nullish(),
  city: optionalText, state: optionalText, country: optionalText,
  telecommuting: z.boolean().optional(),
  workplace_type: optionalText,
  employment_type: optionalText,
  published_on: optionalText,
  published: z.boolean().optional(),
  active: z.boolean().optional(),
  status: optionalText,
});
const boardSchema = z.object({ jobs: z.array(postingSchema) });
type Posting = z.infer<typeof postingSchema>;

function listUrl(company: Company): string {
  return `https://www.workable.com/api/accounts/${boardToken(company.board)}?details=true`;
}

function isPublished(posting: Posting): boolean {
  return posting.published !== false && posting.active !== false
    && ![posting.state, posting.status].some((value) => /^(?:closed|archived|draft|unpublished)$/i.test(value ?? ""));
}

async function readBoard(company: Company): Promise<Posting[]> {
  const payload = parseSourcePayload(boardSchema,
    await fetchJson<unknown>(listUrl(company), { allowedHosts: ALLOWED_HOSTS }), "Workable");
  if (new Set(payload.jobs.map((job) => job.shortcode)).size !== payload.jobs.length) {
    throw new AppError("invalid_source_payload", "Workable payload contains repeated posting identifiers");
  }
  return payload.jobs.filter(isPublished);
}

function jobLocations(posting: Posting): { labels: string[]; countries: string[] } {
  const objects = posting.locations?.length ? posting.locations
    : [typeof posting.location === "object" && posting.location !== null ? posting.location
      : { city: posting.city, state: posting.state, country: posting.country }];
  const labels = objects.map((location) => locationLabel({
    ...location, region: location.region || location.state, countryCode: location.countryCode || location.country_code,
  })).filter(Boolean);
  return {
    labels: [...new Set(labels.length ? labels : typeof posting.location === "string" ? [posting.location] : [])],
    countries: objects.map((location) => location.countryCode || location.country_code || location.country || ""),
  };
}

function workplaceType(posting: Posting): WorkplaceType {
  const type = posting.workplace_type?.toLowerCase();
  if (type === "hybrid") return "hybrid";
  if (type === "remote" || posting.telecommuting === true) return "remote";
  if (type === "onsite" || type === "on-site") return "onsite";
  return "unknown";
}

function normalizePosting(posting: Posting, company: Company, capturedAt: string): Job {
  const locations = jobLocations(posting);
  const url = `https://apply.workable.com/j/${posting.shortcode}`;
  const type = workplaceType(posting);
  return normalizePublicJob({
    company, externalId: posting.shortcode, title: posting.title,
    locations: locations.labels, url, applyUrl: `${url}/apply`,
    descriptionHtml: [posting.description, posting.requirements, posting.benefits].filter(Boolean).join("\n"),
    postedAt: publishedDate(posting.published_on), workplaceType: type, isRemote: type === "remote",
    employmentType: posting.employment_type ?? undefined,
  }, capturedAt, locations.countries);
}

/** Official public account feed, not the employer-authenticated SPI API. */
export const workableAdapter: SourceAdapter = {
  kind: "workable",
  listUrl,
  boardUrl: (company) => `https://apply.workable.com/${boardToken(company.board)}/`,
  async listJobs(company, capturedAt) {
    return (await readBoard(company)).map((posting) => normalizePosting(posting, company, capturedAt));
  },
  async verifyBoard(company) {
    return boardVerification((await readBoard(company)).map((posting) => posting.title));
  },
  probeUrls: () => [],
};
