import type { Workspace } from "../config/load.js";
import { getApplication } from "../db/repositories/applications.js";
import {
  batchSummary,
  computeManifestHash,
  createBatch,
  getBatch,
  latestBatch,
  listBatchItems,
  listBatches,
  setBatchItemState,
  setBatchStatus,
  type Batch,
  type BatchItem,
} from "../db/repositories/batches.js";
import { appendEvent } from "../db/repositories/events.js";
import { getJob, listQueue } from "../db/repositories/jobs.js";
import { autoFillableFields } from "../drafting/personal.js";
import { AppError, isAppError, toErrorMessage } from "../util/errors.js";
import { newId, nowIso } from "../util/hash.js";
import { logger } from "../util/logger.js";
import { approveApplication, loadApplicationContext, prepareApplication, submitApplication, type SubmissionMode } from "./applications.js";

/**
 * Batch operations.
 *
 * Running a campaign one job at a time does not scale to a hundred
 * applications, but volume must not erode the approval boundary. A batch
 * therefore runs every application through the same services as the
 * single-application path, and adds one guard: approval binds to a manifest
 * hash covering the whole set, so a batch cannot grow or change between
 * review and submission.
 */

export type BatchFilter = {
  tiers?: string[];
  trackIds?: string[];
  locationClasses?: string[];
  companies?: string[];
  minScore?: number;
  minCompensation?: number;
  allowUnknownCompensation?: boolean;
  limit?: number;
};

type OutstandingQuestion = { label: string; category: string; suggested: string; guidance: string };

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Pacing can still refuse after a wait that lands a moment early; retry a couple of times before calling it blocked. */
const MAX_PACING_WAITS = 2;

function requireBatch(workspace: Workspace, batchId: string): Batch {
  const batch = getBatch(workspace.db, batchId);
  if (!batch) throw new AppError("batch_not_found", `no batch ${batchId}`);
  return batch;
}

/** One count per blocking category, so the biggest blockers are obvious. */
function countReasons(items: readonly BatchItem[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const item of items) {
    for (const part of item.detail.split(" | ")) {
      const key = part.split(":")[0]?.trim() ?? "";
      if (key.length > 0) counts[key] = (counts[key] ?? 0) + 1;
    }
  }
  return counts;
}

/**
 * The same question recurs across employers, so listing it once with its
 * suggestion turns many blocked applications into one decision.
 */
function recurringQuestions(outstanding: ReadonlyArray<readonly OutstandingQuestion[]>) {
  const counts = new Map<string, OutstandingQuestion & { count: number }>();
  for (const questions of outstanding) {
    for (const question of questions) {
      const existing = counts.get(question.label);
      counts.set(question.label, existing ? { ...existing, count: existing.count + 1 } : { ...question, count: 1 });
    }
  }
  return [...counts.values()].sort((a, b) => b.count - a.count).slice(0, 15);
}

/** Drafts an application for every queued job matching the filter, through the single-application service. */
export async function prepareBatch(workspace: Workspace, filter: BatchFilter) {
  const tiers = filter.tiers ?? ["A", "B"];
  const maxBatchSize = workspace.campaign.submission.maxBatchSize;
  const limit = Math.min(filter.limit ?? maxBatchSize, maxBatchSize);
  const queue = listQueue(workspace.db, {
    minScore: filter.minScore ?? 0,
    tiers,
    trackIds: filter.trackIds,
    locationClasses: filter.locationClasses,
    companies: filter.companies,
    minCompensation: filter.minCompensation,
    allowUnknownCompensation: filter.allowUnknownCompensation ?? false,
    fx: workspace.campaign.compensation.fx,
    maxPerCompany: workspace.campaign.submission.maxPerCompany,
    limit,
  });
  if (queue.length === 0) {
    throw new AppError(
      "empty_selection",
      "no queued jobs match that filter. Run discover_jobs, or relax the tier, score or compensation constraints.",
    );
  }

  const batchId = newId("batch");
  const items: BatchItem[] = [];
  const failures: Array<{ jobId: string; error: string }> = [];
  const outstanding: OutstandingQuestion[][] = [];

  for (const entry of queue) {
    try {
      const prepared = await prepareApplication(workspace, { jobId: entry.job.id });
      outstanding.push(prepared.questionsNeedingHuman);
      const blocked = prepared.status === "needs_human";
      // Keep each reason whole; truncating the joined string would split a
      // category mid-word and corrupt the grouped counts.
      const reasons = [
        ...(prepared.resumeBlocker ? [`resume: ${prepared.resumeBlocker}`] : []),
        ...prepared.questionsNeedingHuman.map((question) => `${question.category}: ${question.label.slice(0, 70)}`),
      ];
      items.push({
        batchId,
        applicationId: prepared.applicationId,
        jobId: entry.job.id,
        packetHash: prepared.packetHash,
        state: blocked ? "needs_human" : "ready",
        detail: blocked ? reasons.slice(0, 8).join(" | ") : "",
      });
    } catch (error) {
      failures.push({ jobId: entry.job.id, error: toErrorMessage(error) });
      logger.warn("batch prepare failed", { jobId: entry.job.id, error: toErrorMessage(error) });
    }
  }

  const ready = items.filter((item) => item.state === "ready");
  const manifestHash = computeManifestHash(ready);
  createBatch(
    workspace.db,
    { id: batchId, createdAt: nowIso(), filter: { ...filter, tiers }, manifestHash, status: "prepared", approvedAt: null, note: "" },
    items,
  );
  appendEvent(workspace.db, "batch.prepared", batchId, { selected: queue.length, ready: ready.length });

  const blockedItems = items.filter((item) => item.state === "needs_human");
  return {
    batchId,
    selected: queue.length,
    prepared: items.length,
    readyToApprove: ready.length,
    needsHuman: blockedItems.length,
    failures,
    manifestHash,
    blockingReasons: countReasons(blockedItems),
    recurringQuestions: recurringQuestions(outstanding),
    autoFilledPersonalFields: autoFillableFields(workspace.profile),
    companies: [...new Set(queue.map((entry) => entry.job.companyName))],
    nextStep:
      ready.length === 0
        ? "Every application needs a human decision first. Use preview_batch to see the grouped questions, add answers to profile.answers or profile.personal with autoFill enabled, then run prepare_batch again."
        : `Review with preview_batch, then approve_batch with manifestHash ${manifestHash}.`,
  };
}

/** Every application in a batch with its readiness and outstanding questions, plus the manifest hash to approve. */
export function previewBatch(workspace: Workspace, input: { batchId?: string; includeReady?: boolean }) {
  const batch = input.batchId ? requireBatch(workspace, input.batchId) : latestBatch(workspace.db);
  if (!batch) throw new AppError("batch_not_found", "no batch found; run prepare_batch first");

  const items = listBatchItems(workspace.db, batch.id);
  const detail = items.map((item) => {
    const job = getJob(workspace.db, item.jobId);
    const application = getApplication(workspace.db, item.applicationId);
    // Carry each outstanding question with its suggestion, so one review
    // pass has everything needed to answer without reopening each job.
    const outstanding = (application?.answers ?? [])
      .filter((answer) => answer.requiresHuman)
      .map((answer) => ({ key: answer.questionKey, label: answer.label, category: answer.category, suggested: answer.answer, guidance: answer.guidance }));
    return {
      applicationId: item.applicationId,
      state: item.state,
      company: job?.companyName ?? "unknown",
      title: job?.title ?? "unknown",
      location: job?.locationClass ?? "unknown",
      compensation: job?.compensation?.raw ?? "not published",
      applyUrl: job?.applyUrl ?? "",
      blockedBy: item.detail,
      outstanding,
    };
  });

  const currentManifest = computeManifestHash(items.filter((item) => item.state === "ready"));
  return {
    batchId: batch.id,
    status: batch.status,
    createdAt: batch.createdAt,
    filter: batch.filter,
    counts: batchSummary(workspace.db, batch.id),
    manifestHash: currentManifest,
    manifestStale: currentManifest !== batch.manifestHash,
    applications: input.includeReady === false ? detail.filter((item) => item.state !== "ready") : detail,
    note: "approve_batch authorizes every 'ready' application in this manifest. Items marked needs_human are excluded.",
  };
}

export type ApproveBatchInput = { batchId: string; manifestHash: string; expectedCount: number; note?: string };

/** Approves every ready application, bound to the manifest hash and the count the person reviewed. */
export function approveBatch(workspace: Workspace, input: ApproveBatchInput) {
  const batch = requireBatch(workspace, input.batchId);
  const ready = listBatchItems(workspace.db, batch.id, "ready");
  const currentManifest = computeManifestHash(ready);
  if (input.manifestHash !== currentManifest) {
    throw new AppError(
      "manifest_mismatch",
      `manifest hash does not match the current batch contents (current: ${currentManifest}). Re-run preview_batch and approve the current manifest.`,
    );
  }
  if (input.expectedCount !== ready.length) {
    throw new AppError(
      "count_mismatch",
      `batch contains ${ready.length} ready application(s) but expectedCount was ${input.expectedCount}. Confirm the real number before approving.`,
    );
  }

  let approved = 0;
  for (const item of ready) {
    const { currentHash } = loadApplicationContext(workspace, item.applicationId);
    if (currentHash !== item.packetHash) {
      setBatchItemState(workspace.db, batch.id, item.applicationId, "needs_human", "content changed after preparation");
      continue;
    }
    approveApplication(workspace, { applicationId: item.applicationId, packetHash: currentHash, decision: "approved", note: input.note ?? `batch ${batch.id}` });
    approved += 1;
  }

  setBatchStatus(workspace.db, batch.id, "approved", nowIso(), input.note ?? "");
  appendEvent(workspace.db, "batch.approved", batch.id, { approved });
  return {
    batchId: batch.id,
    approved,
    nextStep: `Run submit_batch for ${batch.id}. Submission respects the campaign mode, daily limit and pacing.`,
  };
}

export type SubmitBatchInput = { batchId: string; mode?: SubmissionMode; maxSubmissions?: number; headless?: boolean };

type ItemResult = { applicationId: string; company: string; outcome: string; detail: string };
type ItemAttempt = {
  result: ItemResult;
  /** A browser was driven, so pacing applies before the next one. */
  attempted: boolean;
  manualPacket?: { applicationId: string; company: string; title: string; applyUrl: string };
};

async function submitBatchItem(workspace: Workspace, batchId: string, applicationId: string, input: SubmitBatchInput): Promise<ItemAttempt> {
  const { job } = loadApplicationContext(workspace, applicationId);
  const base = { applicationId, company: job.companyName };
  for (let attempt = 0; ; attempt += 1) {
    try {
      const outcome = await submitApplication(workspace, { applicationId, mode: input.mode ?? "manual", headless: input.headless });
      if (outcome.kind === "manual") {
        return {
          result: { ...base, outcome: "packet_ready", detail: job.applyUrl },
          attempted: false,
          manualPacket: { ...base, title: job.title, applyUrl: job.applyUrl },
        };
      }
      const run = outcome.result;
      if (run.status === "submitted") {
        setBatchItemState(workspace.db, batchId, applicationId, "submitted", run.finalUrl);
        return { result: { ...base, outcome: "submitted", detail: run.finalUrl }, attempted: true };
      }
      const detail = run.status === "prepared" ? `form filled, not sent: submit it, then call record_submission. ${run.reason}`.trim() : run.reason;
      setBatchItemState(workspace.db, batchId, applicationId, "needs_human", detail);
      return { result: { ...base, outcome: run.status, detail }, attempted: true };
    } catch (error) {
      if (isAppError(error) && error.code === "daily_limit_reached") {
        return { result: { ...base, outcome: "deferred", detail: error.message }, attempted: false };
      }
      const waitSeconds = isAppError(error) ? Number(error.details.waitSeconds ?? 0) : 0;
      if (isAppError(error) && error.code === "pacing" && waitSeconds > 0 && attempt < MAX_PACING_WAITS) {
        await sleep((waitSeconds + 1) * 1000);
        continue;
      }
      // A guard refusal is an AppError raised before any browser opens; anything else failed mid-run.
      const message = isAppError(error) ? error.message : toErrorMessage(error);
      setBatchItemState(workspace.db, batchId, applicationId, "failed", message);
      return { result: { ...base, outcome: isAppError(error) ? "blocked" : "failed", detail: message }, attempted: !isAppError(error) };
    }
  }
}

/** Submits the approved applications in a batch, re-running every per-application guard. */
export async function submitBatch(workspace: Workspace, input: SubmitBatchInput) {
  const batch = requireBatch(workspace, input.batchId);
  if (batch.status !== "approved" && batch.status !== "submitting") {
    throw new AppError("batch_not_approved", `batch status is "${batch.status}"; approve it before submitting`);
  }

  const mode = input.mode ?? "manual";
  const policy = workspace.campaign.submission;
  const cap = Math.min(input.maxSubmissions ?? policy.maxBatchSize, policy.maxBatchSize, policy.dailyLimit ?? Number.POSITIVE_INFINITY);
  const ready = listBatchItems(workspace.db, batch.id, "ready");
  setBatchStatus(workspace.db, batch.id, "submitting");

  const results: ItemResult[] = [];
  const manualPackets: NonNullable<ItemAttempt["manualPacket"]>[] = [];
  let submitted = 0;
  for (const item of ready) {
    if (submitted >= cap) {
      results.push({ applicationId: item.applicationId, company: "", outcome: "deferred", detail: `cap of ${cap} reached` });
      continue;
    }
    const attempt = await submitBatchItem(workspace, batch.id, item.applicationId, { ...input, mode });
    results.push(attempt.result);
    if (attempt.manualPacket) manualPackets.push(attempt.manualPacket);
    if (attempt.result.outcome === "submitted") submitted += 1;
    if (attempt.attempted && policy.minDelaySeconds > 0 && submitted < cap) await sleep(policy.minDelaySeconds * 1000);
  }

  const remaining = listBatchItems(workspace.db, batch.id, "ready").length;
  setBatchStatus(workspace.db, batch.id, remaining === 0 ? "completed" : "approved");
  appendEvent(workspace.db, "batch.submitted", batch.id, { mode, submitted, remaining });
  return {
    batchId: batch.id,
    mode,
    submitted,
    remaining,
    results,
    manualPackets: mode === "manual" ? manualPackets : undefined,
    nextStep:
      mode === "manual"
        ? "Open each apply URL, submit it, then call record_submission for that application id."
        : remaining > 0
          ? "Approved applications remain. Call submit_batch again when their submission guards allow it."
          : "Batch complete. Track responses with record_outcome.",
  };
}

export function listBatchSummaries(workspace: Workspace, limit = 10) {
  return listBatches(workspace.db, limit).map((batch) => ({
    batchId: batch.id,
    status: batch.status,
    createdAt: batch.createdAt,
    approvedAt: batch.approvedAt,
    counts: batchSummary(workspace.db, batch.id),
    filter: batch.filter,
  }));
}
