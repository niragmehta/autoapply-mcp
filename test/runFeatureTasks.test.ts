import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "../src/config/load.js";
import { loadCampaign } from "../src/config/load.js";
import { openDatabase, type Db } from "../src/db/database.js";
import { saveApplication } from "../src/db/repositories/applications.js";
import { saveEvaluation, upsertJobs } from "../src/db/repositories/jobs.js";
import { listRunLogs } from "../src/db/repositories/runs.js";
import { RunQueue } from "../src/runner/queue.js";
import { registerBuiltinTasks } from "../src/runner/tasks/index.js";
import { makeJob, makeProfile } from "./factories.js";

/** The feature run types against stubbed services: what is under test is how each run chooses its work and reports it. */

vi.mock("../src/hygiene/liveness.js", () => ({ checkLiveness: vi.fn() }));
vi.mock("../src/followup/stale.js", () => ({ closeStaleApplications: vi.fn() }));
vi.mock("../src/inbox/scan.js", () => ({ scanInbox: vi.fn() }));

const liveness = vi.mocked((await import("../src/hygiene/liveness.js")).checkLiveness);
const closeStale = vi.mocked((await import("../src/followup/stale.js")).closeStaleApplications);
const scanInbox = vi.mocked((await import("../src/inbox/scan.js")).scanInbox);

let home: string;
let db: Db;
let queue: RunQueue;

function workspace(): Workspace {
  return {
    paths: {
      home,
      profile: join(home, "profile.json"),
      campaign: join(home, "campaign.json"),
      companies: join(home, "companies.json"),
      database: ":memory:",
      artifacts: join(home, "artifacts"),
      resumeSource: join(home, "resume.json"),
      fonts: join(home, "fonts"),
      documents: join(home, "documents"),
      reports: join(home, "reports"),
      exports: join(home, "exports"),
      secrets: join(home, ".env"),
    },
    profile: makeProfile(),
    campaign: loadCampaign(join(home, "campaign.json")),
    companies: [],
    db,
  };
}

function seedJob(id: string, company: string, applicationStatus?: "awaiting_approval" | "approved" | "submitted"): void {
  upsertJobs(db, [makeJob({ id, fingerprint: `fp_${id}`, externalId: id, companyName: company, title: `Engineer ${id}` })]);
  saveEvaluation(db, {
    jobId: id,
    decision: "accept",
    gate: { passed: true, rule: null, reason: "ok", evidence: "" },
    trackId: "ai-security",
    score: 90,
    tier: "A",
    components: [],
    flags: [],
    evaluatedAt: "2026-09-01T00:00:00.000Z",
  });
  if (!applicationStatus) return;
  saveApplication(db, {
    id: `app_${id}`,
    jobId: id,
    status: applicationStatus,
    resumeId: "ai-security",
    resumePath: "resume.pdf",
    packetHash: `hash_${id}`,
    coverLetter: "",
    answers: [],
    blockedQuestions: [],
    createdAt: "2026-09-01T00:00:00.000Z",
    approvedAt: null,
    submittedAt: applicationStatus === "submitted" ? "2026-09-02T00:00:00.000Z" : null,
    submissionMode: null,
    confirmationRef: null,
    artifactPath: null,
    notes: "",
  });
}

function verdict(jobId: string, status: "open" | "closed" | "unknown") {
  return { jobId, status, via: "api" as const, detail: status === "closed" ? "404 from the board" : "", checkedAt: "2026-09-03T00:00:00.000Z", reused: false };
}

const messages = (runId: string) => listRunLogs(db, runId).map((line) => line.message);

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "autoapply-featuretasks-"));
  writeFileSync(
    join(home, "campaign.json"),
    JSON.stringify({
      version: 1,
      name: "test-campaign",
      tracks: [{ id: "ai-security", label: "AI Security", titleIncludes: ["security engineer"], resumeId: "ai-security" }],
      locations: { allow: ["bay-area"] },
      compensation: { currency: "USD", floors: { US: 200000 } },
    }),
  );
  db = openDatabase(":memory:");
  queue = new RunQueue({ db, workspace, sleep: async () => {} });
  registerBuiltinTasks(queue);
});

afterEach(async () => {
  await queue.shutdown(0);
  vi.resetAllMocks();
  rmSync(home, { recursive: true, force: true });
});

describe("liveness run", () => {
  it("checks the postings behind pending applications by default and reports closed ones with their counts", async () => {
    seedJob("job_pending", "Acme", "awaiting_approval");
    seedJob("job_approved", "Globex", "approved");
    seedJob("job_sent", "Initech", "submitted");
    seedJob("job_queued", "Umbrella");
    liveness.mockImplementation(async (_workspace, job) => verdict(job.id, job.id === "job_approved" ? "closed" : "open") as never);

    const run = await queue.wait(queue.enqueue("liveness", {}));

    expect(run.status).toBe("succeeded");
    expect(liveness.mock.calls.map(([, job]) => job.id).sort()).toEqual(["job_approved", "job_pending"]);
    expect(run.summary).toMatchObject({
      checked: 2,
      open: 1,
      closed: 1,
      unknown: 0,
      missing: 0,
      closedPostings: [{ jobId: "job_approved", company: "Globex", title: "Engineer job_approved", detail: "404 from the board" }],
    });
    expect(messages(run.id).some((line) => line.startsWith("CLOSED Globex"))).toBe(true);
  });

  it("checks named jobs, reports ids with no stored job as missing, and passes force through", async () => {
    seedJob("job_a", "Acme");
    liveness.mockImplementation(async (_workspace, job) => verdict(job.id, "unknown") as never);

    const run = await queue.wait(queue.enqueue("liveness", { jobIds: ["job_a", "job_gone"], force: true }));

    expect(run.summary).toMatchObject({ checked: 2, unknown: 1, missing: 1, closed: 0, closedPostings: [] });
    expect(liveness).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ id: "job_a" }), { force: true });
  });

  it("adds the top of the queue when asked", async () => {
    seedJob("job_queued", "Umbrella");
    liveness.mockImplementation(async (_workspace, job) => verdict(job.id, "open") as never);

    const run = await queue.wait(queue.enqueue("liveness", { applicationStatuses: [], includeQueue: true }));

    expect(run.summary).toMatchObject({ checked: 1, open: 1 });
  });
});

describe("close-stale run", () => {
  it("is a dry run unless told otherwise", async () => {
    closeStale.mockReturnValue({ dryRun: true, closed: [], skipped: [] } as never);

    const run = await queue.wait(queue.enqueue("close-stale", {}));

    expect(run.status).toBe("succeeded");
    expect(closeStale).toHaveBeenCalledWith(expect.anything(), { dryRun: true });
    expect(messages(run.id)).toContain("dry run: nothing recorded");
  });

  it("records only when dryRun is explicitly false", async () => {
    closeStale.mockReturnValue({ dryRun: false, closed: [], skipped: [] } as never);

    await queue.wait(queue.enqueue("close-stale", { dryRun: false }));

    expect(closeStale).toHaveBeenCalledWith(expect.anything(), { dryRun: false });
  });
});

describe("inbox run", () => {
  it("reports the scan counts and logs each mailbox error as a warning", async () => {
    scanInbox.mockResolvedValue({
      dryRun: true,
      timedOut: false,
      errors: ["mailbox INBOX unreadable"],
      counts: { candidates: 3, stored: 3, duplicates: 0, recorded: 1, proposed: 2, dismissed: 0 },
    } as never);

    const run = await queue.wait(queue.enqueue("inbox", { dryRun: true }));

    expect(scanInbox).toHaveBeenCalledWith(expect.anything(), { dryRun: true });
    expect(run.summary).toMatchObject({ candidates: 3, recorded: 1, proposed: 2, dryRun: true, errors: ["mailbox INBOX unreadable"] });
    expect(listRunLogs(db, run.id).find((line) => line.message === "mailbox INBOX unreadable")?.level).toBe("warn");
  });
});

describe("run parameters", () => {
  it("rejects unknown parameters before a run is queued", () => {
    expect(() => queue.enqueue("close-stale", { dryRun: false, everything: true })).toThrow();
    expect(() => queue.enqueue("liveness", { limit: 0 })).toThrow();
  });
});
