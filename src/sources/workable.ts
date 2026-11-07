import { z } from "zod";
import type { Company } from "../domain/campaign.js";
import type { Job, WorkplaceType } from "../domain/job.js";
import { AppError, toErrorMessage } from "../util/errors.js";
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

function contentIdentity(posting: Posting): string {
  const { locations, location, city, state, country, ...content } = posting;
  return JSON.stringify(content);
}

async function readBoard(company: Company) {
  const payload = parseSourcePayload(boardSchema,
    await fetchJson<unknown>(listUrl(company), { allowedHosts: ALLOWED_HOSTS }), "Workable");
  const published = payload.jobs.filter(isPublished);
  const unique = [...new Map(published.map((posting) => [posting.shortcode, posting])).values()];
  return unique.map((posting) => {
    const variants = published.filter((candidate) => candidate.shortcode === posting.shortcode);
    if (variants.some((candidate) => contentIdentity(candidate) !== contentIdentity(posting))) {
      throw new AppError("invalid_source_payload", "Workable posting variants have conflicting non-location content");
    }
    const locations = variants.map(jobLocations);
    return {
      posting,
      locations: {
        labels: [...new Set(locations.flatMap((value) => value.labels))],
        countries: [...new Set(locations.flatMap((value) => value.countries))],
      },
    };
  });
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

function normalizePosting(
  posting: Posting,
  company: Company,
  capturedAt: string,
  locations: ReturnType<typeof jobLocations>,
): Job {
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
    return (await readBoard(company)).map(({ posting, locations }) => normalizePosting(posting, company, capturedAt, locations));
  },
  async verifyBoard(company) {
    return boardVerification((await readBoard(company)).map(({ posting }) => posting.title));
  },
  probeUrls: () => [],

  /**
   * The per-job endpoint answers 404 "Job not found" for a removed posting and
   * `state: "published"` for a live one; any other state is left unknown.
   */
  async checkPosting(job) {
    try {
      const shortcode = postingIdentifier.parse(job.externalId);
      const payload = await fetchJson<{ state?: unknown }>(
        `https://apply.workable.com/api/v2/accounts/${boardToken(job.board)}/jobs/${shortcode}`,
        { allowedHosts: ALLOWED_HOSTS, retries: 1, timeoutMs: 12_000 },
      );
      const state = typeof payload.state === "string" ? payload.state : "";
      if (state === "published") return { status: "open", via: "api", detail: "Workable reports the posting published" };
      if (/^(?:closed|archived)$/i.test(state)) return { status: "closed", via: "api", detail: `Workable reports the posting ${state}` };
      return { status: "unknown", via: "api", detail: `Workable reports state "${state || "none"}"` };
    } catch (error) {
      if (error instanceof AppError && error.code === "not_found") {
        return { status: "closed", via: "api", detail: "Workable no longer has the posting (404 Job not found)" };
      }
      return { status: "unknown", via: "api", detail: `Workable check failed: ${toErrorMessage(error)}` };
    }
  },

  /** apply.workable.com/{account}/j/{shortcode}; the bare /j/{shortcode} share link names no account. */
  parsePostingUrl(url) {
    if (url.hostname.toLowerCase() !== "apply.workable.com") return null;
    const [account, marker, shortcode, rest] = url.pathname.split("/").filter((segment) => segment.length > 0);
    if (!account || marker !== "j" || !shortcode || (rest !== undefined && rest !== "apply")) return null;
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(account) || !postingIdentifier.safeParse(shortcode).success) return null;
    return { board: account, externalId: shortcode };
  },

  async fetchPosting(company, externalId, capturedAt) {
    const match = (await readBoard(company)).find(({ posting }) => posting.shortcode === externalId);
    return match ? normalizePosting(match.posting, company, capturedAt, match.locations) : null;
  },
};
