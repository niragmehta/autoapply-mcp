import { beforeEach, describe, expect, it } from "vitest";
import type { Workspace } from "../src/config/load.js";
import { getApplication, latestApproval } from "../src/db/repositories/applications.js";
import { createBatch, listBatchItems } from "../src/db/repositories/batches.js";
import { listEvents } from "../src/db/repositories/events.js";
import { listQueue, saveEvaluation, upsertJobs } from "../src/db/repositories/jobs.js";
import { approveApplication, loadApplicationContext } from "../src/services/applications.js";
import { dismissJob, listDismissedJobs, restoreJob } from "../src/services/jobs.js";
import { checkSubmissionAllowed } from "../src/submission/guards.js";
import { makeWorkspace, seedApplication } from "./afterApplyFixtures.js";
import { makeJob } from "./factories.js";

let workspace: Workspace;

function seedAccepted(id: string, fingerprint: string, score = 90): void {
  upsertJobs(workspace.db, [makeJob({ id, fingerprint, externalId: id, companyName: "Acme", title: `Engineer ${id}` })]);
  saveEvaluation(workspace.db, {
    jobId: id,
    decision: "accept",
    gate: { passed: true, rule: null, reason: "ok", evidence: "" },
    trackId: "ai-security",
    score,
    tier: "A",
    components: [],
    flags: [],
    evaluatedAt: "2026-09-01T00:00:00.000Z",
  });
}

const queueIds = () => listQueue(workspace.db, { limit: 50 }).map((item) => item.job.id);

beforeEach(() => {
  workspace = makeWorkspace();
});

describe("dismissing a job from the queue", () => {
  it("removes it, and the same role on another board, from the queue", () => {
    seedAccepted("job_a", "fp_shared", 92);
    seedAccepted("job_b", "fp_shared", 91);
    seedAccepted("job_c", "fp_other", 90);

    const result = dismissJob(workspace, { jobId: "job_a", reason: "on-site only" });

    expect(result).toMatchObject({ jobId: "job_a", dismissed: true, reason: "on-site only", skippedApplicationId: null });
    expect(queueIds()).toEqual(["job_c"]);
    expect(listDismissedJobs(workspace.db)).toEqual([
      expect.objectContaining({ jobId: "job_a", company: "Acme", title: "Engineer job_a", reason: "on-site only" }),
    ]);
    expect(listEvents(workspace.db, "job.dismissed")).toHaveLength(1);
  });

  it("skips an application that was drafted but never sent", () => {
    seedApplication(workspace.db, { id: "app_a", company: "Acme", title: "Engineer", status: "awaiting_approval", submittedAt: null });

    const result = dismissJob(workspace, { jobId: "job_app_a" });

    expect(result.skippedApplicationId).toBe("app_a");
    expect(getApplication(workspace.db, "app_a")?.status).toBe("skipped");
  });

  it("voids an earlier approval, so the dismissed packet can no longer pass the submission guards", () => {
    seedApplication(workspace.db, { id: "app_a", company: "Acme", title: "Engineer", status: "awaiting_approval", submittedAt: null });
    const { currentHash } = loadApplicationContext(workspace, "app_a");
    approveApplication(workspace, { applicationId: "app_a", packetHash: currentHash });

    dismissJob(workspace, { jobId: "job_app_a", reason: "relocation required" });

    const { application, job } = loadApplicationContext(workspace, "app_a");
    const approval = latestApproval(workspace.db, "app_a");
    expect(approval).toMatchObject({ decision: "rejected", packetHash: currentHash, note: "job dismissed: relocation required" });
    const guard = checkSubmissionAllowed({
      application,
      job,
      campaign: workspace.campaign,
      approval,
      submittedToday: 0,
      companyApplicationCount: 0,
      lastSubmissionAt: null,
      requestedMode: "manual",
    });
    expect(guard).toMatchObject({ allowed: false, code: "not_approved" });
  });

  it("takes the application out of a prepared batch, so batch approval cannot revive it", () => {
    seedApplication(workspace.db, { id: "app_a", company: "Acme", title: "Engineer", status: "awaiting_approval", submittedAt: null });
    createBatch(
      workspace.db,
      { id: "batch_1", createdAt: "2026-09-01T00:00:00.000Z", filter: {}, manifestHash: "m", status: "prepared", approvedAt: null, note: "" },
      [{ batchId: "batch_1", applicationId: "app_a", jobId: "job_app_a", packetHash: "hash_app_a", state: "ready", detail: "" }],
    );

    const result = dismissJob(workspace, { jobId: "job_app_a" });

    expect(result.batchItemsSkipped).toBe(1);
    expect(listBatchItems(workspace.db, "batch_1", "ready")).toEqual([]);
    expect(listBatchItems(workspace.db, "batch_1")[0]).toMatchObject({ state: "skipped", detail: "job dismissed" });
  });

  it("refuses a job whose application was already submitted", () => {
    seedApplication(workspace.db, { id: "app_a", company: "Acme", title: "Engineer" });

    expect(() => dismissJob(workspace, { jobId: "job_app_a" })).toThrow(/already submitted/);
  });

  it("is idempotent, keeping the first reason unless a new one is given", () => {
    seedAccepted("job_a", "fp_a");
    dismissJob(workspace, { jobId: "job_a", reason: "first" });

    expect(dismissJob(workspace, { jobId: "job_a" })).toMatchObject({ dismissed: false, reason: "first" });
    expect(dismissJob(workspace, { jobId: "job_a", reason: "second" })).toMatchObject({ dismissed: false, reason: "second" });
    expect(listDismissedJobs(workspace.db)).toHaveLength(1);
  });

  it("restores a dismissed job to the queue", () => {
    seedAccepted("job_a", "fp_a");
    dismissJob(workspace, { jobId: "job_a" });

    expect(restoreJob(workspace, "job_a")).toMatchObject({ jobId: "job_a", restored: true });
    expect(queueIds()).toEqual(["job_a"]);
    expect(restoreJob(workspace, "job_a")).toMatchObject({ restored: false });
  });

  it("rejects an unknown job", () => {
    expect(() => dismissJob(workspace, { jobId: "job_missing" })).toThrow(/no job job_missing/);
  });
});
