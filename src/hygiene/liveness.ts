import type { Workspace } from "../config/load.js";
import { getApplication } from "../db/repositories/applications.js";
import { getJob } from "../db/repositories/jobs.js";
import {
  latestLiveness as latestStoredLiveness,
  listingPresence,
  recordLiveness,
  type ListingPresence,
  type LivenessRecord,
} from "../db/repositories/liveness.js";
import type { Db } from "../db/database.js";
import { CompanySchema } from "../domain/campaign.js";
import type { Job } from "../domain/job.js";
import { adapterFor, hasAdapter } from "../sources/registry.js";
import type { PostingCheck, SourceAdapter } from "../sources/types.js";
import { toErrorMessage } from "../util/errors.js";
import { classifyPostingPage } from "./livenessPage.js";
import { fetchPostingPage } from "./pageFetch.js";

/**
 * Posting liveness: is this posting still taking applications?
 *
 * Order: the ATS adapter's own check, which reads the posting through the
 * ATS API; then, when the adapter has none or its answer is inconclusive, the
 * posting page itself. Every verdict is stored, and a fresh one is reused
 * instead of asking again.
 *
 * `unknown` never blocks anything. A network error, a bot wall or a page that
 * renders in the browser all read as unknown, and only `closed` - backed by a
 * 404, a redirect to the board index, the ATS saying so, or the page saying so -
 * stops an application.
 */

export type LivenessVerdict = PostingCheck & {
  jobId: string;
  checkedAt: string;
  /** True when a stored verdict younger than the allowed age was returned. */
  reused: boolean;
  /** Whether the board's latest discovery fetch still listed the posting. */
  listing: ListingPresence;
};

export type LivenessOptions = {
  /** Reuse a stored verdict younger than this; defaults to campaign.hygiene.liveness.maxAgeHours. */
  maxAgeHours?: number;
  /** Check now even when a fresh verdict is stored. */
  force?: boolean;
  now?: Date;
};

/** An inconclusive verdict is retried sooner than a definite one: the cause is often transient. */
const UNKNOWN_REUSE_HOURS = 1;
/** Before a submission run, a verdict is only reused if it is this recent. */
const PREFLIGHT_MAX_AGE_HOURS = 1;

export { latestStoredLiveness as latestLiveness };
export type { LivenessRecord, ListingPresence };

function ageHours(checkedAt: string, now: Date): number {
  const at = Date.parse(checkedAt);
  return Number.isFinite(at) ? (now.getTime() - at) / 3_600_000 : Number.POSITIVE_INFINITY;
}

function reusable(record: LivenessRecord, maxAgeHours: number, now: Date): boolean {
  const limit = record.status === "unknown" ? Math.min(maxAgeHours, UNKNOWN_REUSE_HOURS) : maxAgeHours;
  const age = ageHours(record.checkedAt, now);
  return age >= 0 && age < limit;
}

function boardUrlFor(job: Job, adapter: SourceAdapter | null): string | null {
  if (!adapter) return null;
  try {
    return adapter.boardUrl(CompanySchema.parse({ name: job.companyName || "unknown", ats: job.ats, board: job.board }));
  } catch {
    return null;
  }
}

/** Reads the posting's own page; used when there is no ATS check or it was inconclusive. */
export async function checkPostingPage(job: Job, adapter: SourceAdapter | null = null): Promise<PostingCheck> {
  const url = [job.url, job.applyUrl].find((value) => /^https:\/\//i.test(value ?? ""));
  if (!url) return { status: "unknown", via: "page", detail: "no https posting URL to check" };
  try {
    const page = await fetchPostingPage(url);
    return classifyPostingPage({
      status: page.status,
      requestedUrl: page.requestedUrl,
      finalUrl: page.finalUrl,
      body: page.body,
      title: job.title,
      boardUrl: boardUrlFor(job, adapter),
    });
  } catch (error) {
    return { status: "unknown", via: "page", detail: `could not read the posting page: ${toErrorMessage(error)}` };
  }
}

async function runChecks(job: Job): Promise<PostingCheck> {
  const adapter = hasAdapter(job.ats) ? adapterFor(job.ats) : null;
  let api: PostingCheck | null = null;
  if (adapter?.checkPosting) {
    try {
      api = await adapter.checkPosting(job);
    } catch (error) {
      api = { status: "unknown", via: "api", detail: `ATS check failed: ${toErrorMessage(error)}` };
    }
    if (api.status !== "unknown") return api;
  }
  const page = await checkPostingPage(job, adapter);
  if (page.status !== "unknown" || !api) return page;
  return { status: "unknown", via: "api", detail: `${api.detail}; page: ${page.detail}` };
}

/** Checks one posting, reusing a fresh stored verdict unless `force` is set, and stores the result. */
export async function checkLiveness(workspace: Workspace, job: Job, options: LivenessOptions = {}): Promise<LivenessVerdict> {
  const now = options.now ?? new Date();
  const maxAgeHours = options.maxAgeHours ?? workspace.campaign.hygiene.liveness.maxAgeHours;
  const listing = listingPresence(workspace.db, job);

  if (options.force !== true) {
    const previous = latestStoredLiveness(workspace.db, job.id);
    if (previous && reusable(previous, maxAgeHours, now)) return { ...previous, reused: true, listing };
  }

  const check = await runChecks(job);
  const record: LivenessRecord = { jobId: job.id, status: check.status, via: check.via, detail: check.detail, checkedAt: now.toISOString() };
  recordLiveness(workspace.db, record);
  return { ...record, reused: false, listing };
}

export type LivenessBatchResult = {
  checked: number;
  open: number;
  closed: number;
  unknown: number;
  verdicts: Array<LivenessVerdict & { company: string; title: string }>;
  missing: string[];
};

/** Checks several stored postings one after another; ids with no stored job are reported, not thrown. */
export async function checkLivenessMany(
  workspace: Workspace,
  jobIds: readonly string[],
  options: LivenessOptions = {},
): Promise<LivenessBatchResult> {
  const verdicts: LivenessBatchResult["verdicts"] = [];
  const missing: string[] = [];
  for (const jobId of [...new Set(jobIds)]) {
    const job = getJob(workspace.db, jobId);
    if (!job) {
      missing.push(jobId);
      continue;
    }
    const verdict = await checkLiveness(workspace, job, options);
    verdicts.push({ ...verdict, company: job.companyName, title: job.title });
  }
  const count = (status: PostingCheck["status"]) => verdicts.filter((verdict) => verdict.status === status).length;
  return { checked: verdicts.length, open: count("open"), closed: count("closed"), unknown: count("unknown"), verdicts, missing };
}

/**
 * The run queue's check before it touches an application. Blocks only on a
 * closed verdict; an unknown one proceeds with its reason attached.
 */
export async function livenessPreflight(workspace: Workspace, applicationId: string): Promise<{ ok: boolean; reason?: string }> {
  const application = getApplication(workspace.db, applicationId);
  if (!application) return { ok: false, reason: `no application ${applicationId}` };
  const job = getJob(workspace.db, application.jobId);
  if (!job) return { ok: false, reason: `job ${application.jobId} is missing` };
  if (!workspace.campaign.hygiene.liveness.beforeSubmit || job.ats === "external") return { ok: true };

  const maxAgeHours = Math.min(PREFLIGHT_MAX_AGE_HOURS, workspace.campaign.hygiene.liveness.maxAgeHours);
  const verdict = await checkLiveness(workspace, job, { maxAgeHours });
  if (verdict.status === "closed") return { ok: false, reason: `posting closed: ${verdict.detail}` };
  if (verdict.status === "unknown") return { ok: true, reason: `liveness unconfirmed (${verdict.detail}); proceeding` };
  return { ok: true };
}

/** Latest stored verdict per job, for list views; the dashboard reads this without hitting the network. */
export function livenessSummary(db: Db, jobId: string): (LivenessRecord & { ageHours: number }) | null {
  const record = latestStoredLiveness(db, jobId);
  return record ? { ...record, ageHours: Math.round(ageHours(record.checkedAt, new Date()) * 10) / 10 } : null;
}
