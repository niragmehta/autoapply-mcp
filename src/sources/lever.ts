import type { Company } from "../domain/campaign.js";
import type { CompensationRange, Job, WorkplaceType } from "../domain/job.js";
import { AppError, toErrorMessage } from "../util/errors.js";
import { fetchJson } from "./http.js";
import { asString, epochToIso, normalizeJob } from "./normalize.js";
import { leverDescription, type LeverDescription } from "./leverDescription.js";
import type { PostingCheck, PostingRef, SourceAdapter } from "./types.js";

/**
 * Lever Postings API (public).
 * https://github.com/lever/postings-api
 *
 * Postings are public; applications go through the Lever-hosted form.
 */

const BOARD_TOKEN = /^[A-Za-z0-9_.-]{1,100}$/;
const POSTING_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Liveness must answer quickly; unknown is an acceptable result, a long stall is not. */
const LIVENESS_REQUEST = { retries: 1, timeoutMs: 12_000 } as const;

function base(company: Company): string {
  return company.region === "eu" ? "https://api.eu.lever.co/v0/postings" : "https://api.lever.co/v0/postings";
}

type LeverSalary = { min?: unknown; max?: unknown; currency?: unknown; interval?: unknown };
type LeverPosting = LeverDescription & {
  id?: unknown;
  text?: unknown;
  hostedUrl?: unknown;
  applyUrl?: unknown;
  createdAt?: unknown;
  workplaceType?: unknown;
  salaryRange?: LeverSalary;
  categories?: {
    location?: unknown;
    allLocations?: unknown;
    commitment?: unknown;
    team?: unknown;
    department?: unknown;
  };
};

const INTERVAL_MAP: Record<string, CompensationRange["period"]> = {
  "per-year-salary": "year",
  "per-month-salary": "month",
  "per-hour-wage": "hour",
};

function structuredPay(posting: LeverPosting): CompensationRange | null {
  const salary = posting.salaryRange;
  if (!salary) return null;
  const min = typeof salary.min === "number" ? salary.min : null;
  const max = typeof salary.max === "number" ? salary.max : null;
  if (min === null && max === null) return null;
  return {
    min,
    max,
    currency: (asString(salary.currency, "USD") || "USD").toUpperCase().slice(0, 3),
    period: INTERVAL_MAP[asString(salary.interval).toLowerCase()] ?? "year",
    source: "ats-structured",
    raw: `lever salaryRange ${asString(salary.interval)}`,
  };
}

function workplaceType(posting: LeverPosting): WorkplaceType {
  const value = asString(posting.workplaceType).toLowerCase();
  if (value === "remote" || value === "hybrid" || value === "onsite") return value;
  return "unknown";
}

function locations(posting: LeverPosting): string[] {
  const all = Array.isArray(posting.categories?.allLocations)
    ? posting.categories.allLocations.filter((item): item is string => typeof item === "string")
    : [];
  const primary = asString(posting.categories?.location);
  return [...new Set([primary, ...all].filter((value) => value.length > 0))];
}

export const leverAdapter: SourceAdapter = {
  kind: "lever",

  listUrl(company: Company): string {
    return `${base(company)}/${encodeURIComponent(company.board)}?mode=json`;
  },

  boardUrl(company: Company): string {
    const host = company.region === "eu" ? "https://jobs.eu.lever.co" : "https://jobs.lever.co";
    return `${host}/${encodeURIComponent(company.board)}`;
  },

  async listJobs(company: Company, capturedAt: string): Promise<Job[]> {
    const postings = await fetchJson<LeverPosting[]>(this.listUrl(company));
    if (!Array.isArray(postings)) return [];
    return postings.map((posting) => toJob(company, posting, capturedAt));
  },

  probeUrls(slug: string): string[] {
    return [
      `https://api.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json&limit=1`,
      `https://api.eu.lever.co/v0/postings/${encodeURIComponent(slug)}?mode=json&limit=1`,
    ];
  },

  /**
   * A 404 from the postings API is not a closure on its own: Lever hides
   * confidential postings from the API while their hosted page stays live. It
   * is reported as unknown, so liveness reads the hosted page next.
   */
  async checkPosting(job: Job): Promise<PostingCheck> {
    const region = /(^|\.)eu\.lever\.co$/i.test(hostOf(job.url)) ? "eu" : "global";
    try {
      const posting = await fetchJson<LeverPosting>(postingUrl(region, job.board, job.externalId), LIVENESS_REQUEST);
      return asString(posting.id) === job.externalId
        ? { status: "open", via: "api", detail: "Lever still publishes the posting" }
        : { status: "unknown", via: "api", detail: "Lever answered without this posting's id" };
    } catch (error) {
      if (error instanceof AppError && error.code === "not_found") {
        return { status: "unknown", via: "api", detail: "Lever's public API no longer lists the posting (404); confidential postings are hidden from it too" };
      }
      return { status: "unknown", via: "api", detail: `Lever check failed: ${toErrorMessage(error)}` };
    }
  },

  /** jobs.lever.co/{board}/{id} and jobs.eu.lever.co/{board}/{id}, with or without /apply. */
  parsePostingUrl(url: URL): PostingRef | null {
    const host = url.hostname.toLowerCase();
    if (host !== "jobs.lever.co" && host !== "jobs.eu.lever.co") return null;
    const [board, id, rest] = url.pathname.split("/").filter((segment) => segment.length > 0);
    if (!board || !id || (rest !== undefined && rest !== "apply")) return null;
    if (!BOARD_TOKEN.test(board) || !POSTING_ID.test(id)) return null;
    return { board, externalId: id, region: host === "jobs.eu.lever.co" ? "eu" : "global" };
  },

  async fetchPosting(company: Company, externalId: string, capturedAt: string): Promise<Job | null> {
    if (!POSTING_ID.test(externalId)) throw new AppError("invalid_posting_id", `Lever posting ids are UUIDs, got: ${externalId}`);
    try {
      const posting = await fetchJson<LeverPosting>(postingUrl(company.region, company.board, externalId));
      return toJob(company, posting, capturedAt);
    } catch (error) {
      if (error instanceof AppError && error.code === "not_found") return null;
      throw error;
    }
  },
};

function hostOf(value: string): string {
  try {
    return new URL(value).hostname;
  } catch {
    return "";
  }
}

function postingUrl(region: Company["region"], board: string, externalId: string): string {
  const api = region === "eu" ? "https://api.eu.lever.co/v0/postings" : "https://api.lever.co/v0/postings";
  return `${api}/${encodeURIComponent(board)}/${encodeURIComponent(externalId)}?mode=json`;
}

function toJob(company: Company, posting: LeverPosting, capturedAt: string): Job {
  return normalizeJob(
    {
      company,
      externalId: asString(posting.id),
      title: asString(posting.text),
      locations: locations(posting),
      url: asString(posting.hostedUrl),
      applyUrl: asString(posting.applyUrl) || asString(posting.hostedUrl),
      descriptionPlain: leverDescription(posting),
      postedAt: epochToIso(posting.createdAt),
      workplaceType: workplaceType(posting),
      employmentType: asString(posting.categories?.commitment),
      structuredCompensation: structuredPay(posting),
    },
    capturedAt,
  );
}
