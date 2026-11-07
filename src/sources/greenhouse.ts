import type { Company } from "../domain/campaign.js";
import type { CompensationRange, Job } from "../domain/job.js";
import { AppError, toErrorMessage } from "../util/errors.js";
import { fetchJson } from "./http.js";
import { asString, normalizeJob } from "./normalize.js";
import type { PostingCheck, PostingRef, SourceAdapter } from "./types.js";

/**
 * Greenhouse Job Board API (public, unauthenticated for reads).
 * https://developers.greenhouse.io/job-board.html
 *
 * Application submission through the API needs an employer-issued board key,
 * so candidates apply through the hosted form instead.
 */

const BASE = "https://boards-api.greenhouse.io/v1/boards";
const BOARD_TOKEN = /^[A-Za-z0-9_-]{1,100}$/;
const JOB_ID = /^\d{1,20}$/;
/** Liveness must answer quickly; unknown is an acceptable result, a long stall is not. */
const LIVENESS_REQUEST = { retries: 1, timeoutMs: 12_000 } as const;

type GreenhouseOffice = { name?: unknown; location?: unknown };
type GreenhousePayRange = { min_cents?: unknown; max_cents?: unknown; currency_type?: unknown; title?: unknown };
type GreenhouseJob = {
  id?: unknown;
  title?: unknown;
  updated_at?: unknown;
  first_published?: unknown;
  absolute_url?: unknown;
  content?: unknown;
  location?: { name?: unknown };
  offices?: GreenhouseOffice[];
  pay_input_ranges?: GreenhousePayRange[];
  metadata?: unknown;
};

function collectLocations(job: GreenhouseJob): string[] {
  const primary = asString(job.location?.name);
  const offices = (job.offices ?? [])
    .map((office) => asString(office.location) || asString(office.name))
    .filter((value) => value.length > 0 && value.toLowerCase() !== "n/a");
  return [...new Set([primary, ...offices].filter((value) => value.length > 0))];
}

function structuredPay(job: GreenhouseJob): CompensationRange | null {
  const range = job.pay_input_ranges?.[0];
  if (!range) return null;
  const minCents = typeof range.min_cents === "number" ? range.min_cents : null;
  const maxCents = typeof range.max_cents === "number" ? range.max_cents : null;
  if (minCents === null && maxCents === null) return null;
  return {
    min: minCents === null ? null : minCents / 100,
    max: maxCents === null ? null : maxCents / 100,
    currency: (asString(range.currency_type, "USD") || "USD").toUpperCase().slice(0, 3),
    period: "year",
    source: "ats-structured",
    raw: asString(range.title, "greenhouse pay_input_ranges"),
  };
}

/**
 * Many employers point their Greenhouse board at their own careers site, so
 * `absolute_url` lands on a marketing page rather than a form — and on a host
 * outside the submission allowlist. Greenhouse still hosts the real
 * application at its embed endpoint, so prefer that whenever the posting id is
 * known. Falls back to the board's own URL when it is already a Greenhouse one.
 */
export function hostedApplyUrl(board: string, externalId: string, absoluteUrl: string): string {
  if (!externalId) return absoluteUrl;
  if (isGreenhouseApplicationUrl(absoluteUrl)) return absoluteUrl;
  return `https://job-boards.greenhouse.io/embed/job_app?for=${encodeURIComponent(board)}&token=${encodeURIComponent(externalId)}`;
}

function isGreenhouseApplicationUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return host === "boards.greenhouse.io" || host === "job-boards.greenhouse.io";
  } catch {
    return false;
  }
}

export const greenhouseAdapter: SourceAdapter = {
  kind: "greenhouse",

  listUrl(company: Company): string {
    return `${BASE}/${encodeURIComponent(company.board)}/jobs?content=true&pay_transparency=true`;
  },

  boardUrl(company: Company): string {
    return `https://job-boards.greenhouse.io/${encodeURIComponent(company.board)}`;
  },

  async listJobs(company: Company, capturedAt: string): Promise<Job[]> {
    const payload = await fetchJson<{ jobs?: GreenhouseJob[] }>(this.listUrl(company));
    const jobs = payload.jobs ?? [];
    return jobs.map((job) => toJob(company, job, capturedAt));
  },

  probeUrls(slug: string): string[] {
    return [`${BASE}/${encodeURIComponent(slug)}/jobs`];
  },

  /** The job endpoint answers 404 "Job not found" once a posting is taken down. */
  async checkPosting(job: Job): Promise<PostingCheck> {
    try {
      const payload = await fetchJson<GreenhouseJob>(jobUrl(job.board, job.externalId), LIVENESS_REQUEST);
      return String(payload.id ?? "") === job.externalId
        ? { status: "open", via: "api", detail: "Greenhouse still publishes the posting" }
        : { status: "unknown", via: "api", detail: "Greenhouse answered without this posting's id" };
    } catch (error) {
      if (error instanceof AppError && error.code === "not_found") {
        return { status: "closed", via: "api", detail: "Greenhouse no longer publishes the posting (404 Job not found)" };
      }
      return { status: "unknown", via: "api", detail: `Greenhouse check failed: ${toErrorMessage(error)}` };
    }
  },

  /**
   * boards.greenhouse.io/{board}/jobs/{id}, the job-boards host, and the embed
   * form `/embed/job_app?for={board}&token={id}`. A careers page carrying only
   * `?gh_jid=` names no board, so it is left to the generic page reader.
   */
  parsePostingUrl(url: URL): PostingRef | null {
    const host = url.hostname.toLowerCase();
    if (host !== "boards.greenhouse.io" && host !== "job-boards.greenhouse.io") return null;
    const segments = url.pathname.split("/").filter((segment) => segment.length > 0);
    if (segments[0] === "embed" && segments[1] === "job_app") {
      const board = url.searchParams.get("for") ?? "";
      const token = url.searchParams.get("token") ?? "";
      return BOARD_TOKEN.test(board) && JOB_ID.test(token) ? { board, externalId: token } : null;
    }
    const [board, kind, id] = segments;
    if (board && kind === "jobs" && id && BOARD_TOKEN.test(board) && JOB_ID.test(id)) return { board, externalId: id };
    const ghJid = url.searchParams.get("gh_jid") ?? "";
    if (board && segments.length === 1 && BOARD_TOKEN.test(board) && JOB_ID.test(ghJid)) return { board, externalId: ghJid };
    return null;
  },

  async fetchPosting(company: Company, externalId: string, capturedAt: string): Promise<Job | null> {
    if (!JOB_ID.test(externalId)) throw new AppError("invalid_posting_id", `Greenhouse job ids are numeric, got: ${externalId}`);
    try {
      const payload = await fetchJson<GreenhouseJob>(`${jobUrl(company.board, externalId)}?pay_transparency=true`);
      return toJob(company, payload, capturedAt);
    } catch (error) {
      if (error instanceof AppError && error.code === "not_found") return null;
      throw error;
    }
  },
};

function jobUrl(board: string, externalId: string): string {
  return `${BASE}/${encodeURIComponent(board)}/jobs/${encodeURIComponent(externalId)}`;
}

function toJob(company: Company, job: GreenhouseJob, capturedAt: string): Job {
  return normalizeJob(
    {
      company,
      externalId: String(job.id ?? ""),
      title: asString(job.title),
      locations: collectLocations(job),
      url: asString(job.absolute_url),
      applyUrl: hostedApplyUrl(company.board, String(job.id ?? ""), asString(job.absolute_url)),
      descriptionHtml: asString(job.content),
      postedAt: asString(job.first_published) || asString(job.updated_at) || null,
      structuredCompensation: structuredPay(job),
    },
    capturedAt,
  );
}

export type GreenhouseQuestionField = { name?: unknown; type?: unknown; values?: unknown };
export type GreenhouseQuestion = { label?: unknown; required?: unknown; fields?: GreenhouseQuestionField[] };
/** Compliance sections group their questions under a description. */
export type GreenhouseComplianceGroup = { type?: unknown; description?: unknown; questions?: GreenhouseQuestion[] };

/**
 * Fetches one posting including its application questions, which drives the
 * answer policy engine before a submission is prepared.
 *
 * Compliance and demographic sections nest their questions one level deeper
 * than the main question list, so they are flattened here.
 */
export async function fetchGreenhouseJobDetail(
  board: string,
  jobId: string,
): Promise<{ questions: GreenhouseQuestion[]; compliance: GreenhouseQuestion[]; payRanges: GreenhousePayRange[] }> {
  const url = `${BASE}/${encodeURIComponent(board)}/jobs/${encodeURIComponent(jobId)}?questions=true&pay_transparency=true`;
  const payload = await fetchJson<{
    questions?: GreenhouseQuestion[];
    compliance?: GreenhouseComplianceGroup[];
    demographic_questions?: { questions?: GreenhouseQuestion[] };
    location_questions?: GreenhouseQuestion[];
    pay_input_ranges?: GreenhousePayRange[];
  }>(url);

  const compliance = (payload.compliance ?? []).flatMap((group) =>
    Array.isArray(group.questions) ? group.questions : [],
  );
  const demographic = payload.demographic_questions?.questions ?? [];

  return {
    questions: [...(payload.questions ?? []), ...(payload.location_questions ?? [])],
    compliance: [...compliance, ...demographic],
    payRanges: payload.pay_input_ranges ?? [],
  };
}
