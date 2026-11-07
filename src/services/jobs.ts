import type { Workspace } from "../config/load.js";
import { getApplicationByJob, latestApproval } from "../db/repositories/applications.js";
import { skipPendingBatchItems } from "../db/repositories/batches.js";
import { deleteDismissal, getDismissal, listDismissals, saveDismissal, type DismissedJob } from "../db/repositories/dismissals.js";
import { appendEvent } from "../db/repositories/events.js";
import { getJob } from "../db/repositories/jobs.js";
import type { Db } from "../db/database.js";
import type { Application, Job } from "../domain/job.js";
import { AppError } from "../util/errors.js";
import { approveApplication, loadApplicationContext } from "./applications.js";

const MAX_REASON_LENGTH = 500;

export type DismissInput = { jobId: string; reason?: string };

export type DismissResult = {
  jobId: string;
  company: string;
  title: string;
  /** False when the posting was already dismissed. */
  dismissed: boolean;
  reason: string;
  /** The unsent application that was set to skipped, if there was one. */
  skippedApplicationId: string | null;
  /** Prepared batch items it was taken out of. */
  batchItemsSkipped: number;
};

function requireJob(db: Db, jobId: string): Job {
  const job = getJob(db, jobId);
  if (!job) throw new AppError("job_not_found", `no job ${jobId}`);
  return job;
}

/**
 * Records the dismissal as a human rejection of the current packet. The
 * submission guards read the latest approval, not the status, so an approval
 * given before the dismissal would otherwise still let the packet be sent.
 */
function rejectUnsentApplication(workspace: Workspace, application: Application, reason: string): boolean {
  const latest = latestApproval(workspace.db, application.id);
  if (application.status === "skipped" && latest?.decision !== "approved") return false;
  const { currentHash } = loadApplicationContext(workspace, application.id);
  approveApplication(workspace, {
    applicationId: application.id,
    packetHash: currentHash,
    decision: "rejected",
    note: reason ? `job dismissed: ${reason}` : "job dismissed",
  });
  return true;
}

/**
 * Rules a posting out by hand: it, and the same role on any other board, leave
 * the queue. An application drafted for it but never sent is rejected, which
 * voids any earlier approval and takes it out of prepared batches; a sent one
 * is refused, since the employer already has it.
 */
export function dismissJob(workspace: Workspace, input: DismissInput, now = new Date()): DismissResult {
  const { db } = workspace;
  const job = requireJob(db, input.jobId);
  const application = getApplicationByJob(db, job.id);
  if (application?.status === "submitted") {
    throw new AppError(
      "already_submitted",
      `application ${application.id} was already submitted; record an outcome such as withdrawn with record_outcome instead`,
    );
  }

  const reason = (input.reason ?? "").trim().slice(0, MAX_REASON_LENGTH);
  const existing = getDismissal(db, job.fingerprint);
  const kept = existing && !reason ? existing.reason : reason;
  saveDismissal(db, { fingerprint: job.fingerprint, jobId: job.id, reason: kept, dismissedAt: existing?.dismissedAt ?? now.toISOString() });

  const skippedApplicationId = application && rejectUnsentApplication(workspace, application, kept) ? application.id : null;
  const batchItemsSkipped = application ? skipPendingBatchItems(db, application.id, kept ? `job dismissed: ${kept}` : "job dismissed") : 0;
  if (!existing || skippedApplicationId || batchItemsSkipped > 0) {
    appendEvent(db, "job.dismissed", job.id, { reason: kept, fingerprint: job.fingerprint, skippedApplicationId, batchItemsSkipped });
  }

  return { jobId: job.id, company: job.companyName, title: job.title, dismissed: !existing, reason: kept, skippedApplicationId, batchItemsSkipped };
}

/** Puts a dismissed posting back in the queue. A skipped application stays skipped until prepared again. */
export function restoreJob(workspace: Workspace, jobId: string) {
  const job = requireJob(workspace.db, jobId);
  const restored = deleteDismissal(workspace.db, job.fingerprint);
  if (restored) appendEvent(workspace.db, "job.restored", job.id, { fingerprint: job.fingerprint });
  return {
    jobId: job.id,
    company: job.companyName,
    title: job.title,
    restored,
    nextStep: restored ? "Back in list_queue. prepare_application drafts it again." : "It was not dismissed.",
  };
}

export function listDismissedJobs(db: Db, limit = 200): DismissedJob[] {
  return listDismissals(db, limit);
}
