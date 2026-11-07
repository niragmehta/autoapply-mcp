import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "../src/config/load.js";
import { loadCampaign } from "../src/config/load.js";
import { openDatabase, type Db } from "../src/db/database.js";
import { recordApproval, saveApplication } from "../src/db/repositories/applications.js";
import { listRunLogs } from "../src/db/repositories/runs.js";
import { saveEvaluation, upsertJobs } from "../src/db/repositories/jobs.js";
import type { Application, Job } from "../src/domain/job.js";
import { RunQueue } from "../src/runner/queue.js";
import { registerBuiltinTasks } from "../src/runner/tasks/index.js";
import { RunCancelledError } from "../src/runner/types.js";
import { AppError } from "../src/util/errors.js";
import { makeCampaign, makeJob, makeProfile } from "./factories.js";

/** Built-in run tasks against stubbed services: the runner's own decisions are what is under test. */

vi.mock("../src/services/applications.js", () => ({
  previewApplication: vi.fn(),
  approveApplication: vi.fn(),
  submitApplication: vi.fn(),
  prepareApplication: vi.fn(),
}));
vi.mock("../src/services/discovery.js", () => ({ runDiscovery: vi.fn() }));

const services = await import("../src/services/applications.js");
const discovery = await import("../src/services/discovery.js");
const preview = vi.mocked(services.previewApplication);
const approve = vi.mocked(services.approveApplication);
const submit = vi.mocked(services.submitApplication);
const prepare = vi.mocked(services.prepareApplication);
const runDiscovery = vi.mocked(discovery.runDiscovery);

let home: string;
let db: Db;
let queue: RunQueue;
let sleeps: number[];

function writeCampaign(overrides: Record<string, unknown> = {}): void {
  const campaign = {
    version: 1,
    name: "test-campaign",
    tracks: [{ id: "ai-security", label: "AI Security", titleIncludes: ["security engineer"], resumeId: "ai-security" }],
    locations: { allow: ["bay-area", "canada"] },
    compensation: { currency: "USD", floors: { US: 200000 } },
    submission: { mode: "auto", allowedCompanies: ["Other Co"], minDelaySeconds: 0 },
    ...overrides,
  };
  writeFileSync(join(home, "campaign.json"), JSON.stringify(campaign));
}

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
    companies: [
      { name: "Acme", ats: "greenhouse", board: "acme", tier: "A", tags: [], active: true, region: "global", query: "" },
      { name: "Globex", ats: "lever", board: "globex", tier: "B", tags: [], active: true, region: "global", query: "" },
      { name: "Initech", ats: "ashby", board: "initech", tier: "B", tags: [], active: false, region: "global", query: "" },
    ],
    db,
  };
}

function seedApplication(id: string, job: Partial<Job>, overrides: Partial<Application> = {}): void {
  const stored = makeJob({ id: `job_${id}`, fingerprint: `fp_${id}`, externalId: id, ...job });
  upsertJobs(db, [stored]);
  saveApplication(db, {
    id,
    jobId: stored.id,
    status: "awaiting_approval",
    resumeId: "ai-security",
    resumePath: "resume.pdf",
    packetHash: `hash_${id}`,
    coverLetter: "",
    answers: [],
    blockedQuestions: [],
    createdAt: new Date().toISOString(),
    approvedAt: null,
    submittedAt: null,
    submissionMode: null,
    confirmationRef: null,
    artifactPath: null,
    notes: "",
    ...overrides,
  });
}

function previewFor(applicationId: string, unresolved: string[] = []) {
  return {
    applicationId,
    status: "awaiting_approval" as const,
    packetHash: `hash_${applicationId}`,
    storedHashStale: false,
    unresolvedRequired: unresolved,
    text: "packet",
  };
}

function browserResult(status: "submitted" | "prepared" | "aborted", extra: Record<string, unknown> = {}) {
  return {
    kind: "browser" as const,
    applicationId: "x",
    mode: "auto" as const,
    nextStep: "",
    result: {
      status,
      reason: status === "aborted" ? "captcha" : "",
      filledFields: [],
      unmatchedRequired: [],
      unusedAnswers: [],
      screenshotPath: join("artifacts", "app-confirmation-1.png"),
      finalUrl: "https://example.com/done",
      confirmationText: "Thank you for applying",
      captchaDetected: false,
      ...extra,
    },
  };
}

function messages(runId: string): string[] {
  return listRunLogs(db, runId).map((line) => line.message);
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "autoapply-runtasks-"));
  writeCampaign();
  db = openDatabase(":memory:");
  sleeps = [];
  queue = new RunQueue({
    db,
    workspace,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  registerBuiltinTasks(queue);
  preview.mockImplementation((_workspace, applicationId) => previewFor(applicationId));
  approve.mockImplementation(((_workspace: Workspace, input: { applicationId: string; packetHash: string }) => {
    recordApproval(db, { id: `apr_${input.applicationId}`, applicationId: input.applicationId, packetHash: input.packetHash, decision: "approved", note: "" });
    return { applicationId: input.applicationId, decision: "approved", status: "approved", packetHash: input.packetHash, nextStep: "" };
  }) as never);
  submit.mockResolvedValue(browserResult("submitted") as never);
});

afterEach(async () => {
  await queue.shutdown(0);
  vi.resetAllMocks();
  rmSync(home, { recursive: true, force: true });
});

describe("submit run", () => {
  it("approves an unapproved packet at its current hash, submits it and paces between attempts", async () => {
    seedApplication("app_one", { companyName: "Acme" });
    seedApplication("app_two", { companyName: "Globex", ats: "ashby" });
    const id = queue.enqueue("submit", { applicationIds: ["app_one", "app_two"], paceSeconds: 7 });
    const run = await queue.wait(id);

    expect(run.status).toBe("succeeded");
    expect(run.summary).toMatchObject({ requested: 2, sent: 2, failed: 0, skipped: 0 });
    expect(approve).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({
      applicationId: "app_one",
      packetHash: "hash_app_one",
      note: `approved via submit run ${id}`,
    }));
    expect(submit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ applicationId: "app_one", mode: "auto", headless: true }));
    // Ashby flags headless submissions as spam, so it always gets a window.
    expect(submit).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ applicationId: "app_two", headless: false }));
    expect(sleeps).toEqual([7000]);
    expect(messages(id).some((line) => line.startsWith("SENT app_one Acme") && line.includes("shot: app-confirmation-1.png"))).toBe(true);
  });

  it("does not re-approve a packet already approved at the same hash", async () => {
    seedApplication("app_one", { companyName: "Acme" }, { status: "approved" });
    recordApproval(db, { id: "apr_1", applicationId: "app_one", packetHash: "hash_app_one", decision: "approved", note: "" });
    await queue.wait(queue.enqueue("submit", { applicationIds: ["app_one"] }));
    expect(approve).not.toHaveBeenCalled();
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("skips already-submitted applications and unresolved required answers without guessing", async () => {
    seedApplication("app_done", { companyName: "Acme" }, { status: "submitted", submittedAt: new Date().toISOString() });
    seedApplication("app_open", { companyName: "Globex" });
    preview.mockImplementation((_workspace, applicationId) => previewFor(applicationId, ["Will you require sponsorship?"]));
    const id = queue.enqueue("submit", { applicationIds: ["app_done", "app_open"] });
    const run = await queue.wait(id);

    expect(run.summary).toMatchObject({ alreadySubmitted: 1, skipped: 1, sent: 0 });
    expect(approve).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    expect(messages(id)).toContain("SKIP app_open Globex | Senior Security Engineer - unresolved: Will you require sponsorship?");
    expect(sleeps).toEqual([]);
  });

  it("enforces the per-company round cap with normalised company names", async () => {
    writeCampaign({ runner: { roundCap: { max: 1, since: "2020-01-01T00:00:00Z" } } });
    seedApplication("app_prior", { companyName: "Acme, Inc." }, { status: "submitted", submittedAt: "2026-01-02T00:00:00.000Z" });
    seedApplication("app_next", { companyName: "ACME" });
    seedApplication("app_other", { companyName: "Globex" });
    const id = queue.enqueue("submit", { applicationIds: ["app_next", "app_other"] });
    const run = await queue.wait(id);

    expect(run.summary).toMatchObject({ skipped: 1, sent: 1 });
    expect(messages(id).some((line) => line.includes("SKIP app_next ACME") && line.includes("round cap: 1 already submitted"))).toBe(true);
    expect(submit).toHaveBeenCalledTimes(1);
  });

  it("waits out the pacing guard and retries, within a bound", async () => {
    seedApplication("app_one", { companyName: "Acme" });
    submit
      .mockRejectedValueOnce(new AppError("pacing", "minimum 45s between submissions; wait 40s", { waitSeconds: 40 }))
      .mockRejectedValueOnce(new AppError("pacing", "minimum 45s between submissions; wait 3s"))
      .mockResolvedValueOnce(browserResult("submitted") as never);
    const id = queue.enqueue("submit", { applicationIds: ["app_one"] });
    const run = await queue.wait(id);

    expect(run.summary).toMatchObject({ sent: 1 });
    expect(submit).toHaveBeenCalledTimes(3);
    expect(sleeps).toEqual([42_000, 5_000]);
    expect(messages(id)).toContain("Pacing: waiting 40s before retrying app_one.");
  });

  it("gives up after repeated pacing denials", async () => {
    seedApplication("app_one", { companyName: "Acme" });
    submit.mockRejectedValue(new AppError("pacing", "wait 1s", { waitSeconds: 1 }));
    const run = await queue.wait(queue.enqueue("submit", { applicationIds: ["app_one"] }));
    expect(submit).toHaveBeenCalledTimes(9);
    expect(run.summary).toMatchObject({ failed: 1 });
  });

  it("allowlists the company just in time when autoAllowlist is on", async () => {
    writeCampaign({ runner: { autoAllowlist: true } });
    seedApplication("app_one", { companyName: "Acme" });
    const id = queue.enqueue("submit", { applicationIds: ["app_one"] });
    await queue.wait(id);

    const saved = JSON.parse(readFileSync(join(home, "campaign.json"), "utf8"));
    expect(saved.submission.allowedCompanies).toEqual(["Other Co", "Acme"]);
    expect(messages(id)).toContain("Allowlisted Acme for auto submission (campaign.runner.autoAllowlist).");
  });

  it("leaves an empty allowlist alone, since it already permits every company", async () => {
    writeCampaign({ runner: { autoAllowlist: true }, submission: { mode: "auto", allowedCompanies: [] } });
    seedApplication("app_one", { companyName: "Acme" });
    await queue.wait(queue.enqueue("submit", { applicationIds: ["app_one"] }));
    const saved = JSON.parse(readFileSync(join(home, "campaign.json"), "utf8"));
    expect(saved.submission.allowedCompanies).toEqual([]);
  });

  it("skips an application whose packet changed since the reviewed hash", async () => {
    seedApplication("app_one", { companyName: "Acme" });
    const id = queue.enqueue("submit", { applicationIds: ["app_one"], packetHashes: { app_one: "hash_reviewed_earlier" } });
    await queue.wait(id);
    expect(approve).not.toHaveBeenCalled();
    expect(submit).not.toHaveBeenCalled();
    expect(messages(id).some((line) => line.includes("content changed since it was reviewed"))).toBe(true);
  });

  it("stops the whole run when the daily limit is reached", async () => {
    seedApplication("app_one", { companyName: "Acme" });
    seedApplication("app_two", { companyName: "Globex" });
    submit.mockRejectedValue(new AppError("daily_limit_reached", "daily submission limit of 25 reached"));
    const id = queue.enqueue("submit", { applicationIds: ["app_one", "app_two"] });
    const run = await queue.wait(id);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(run.summary).toMatchObject({ failed: 1, stoppedEarly: "[daily_limit_reached] daily submission limit of 25 reached" });
  });

  it("skips a posting the service finds closed and carries on with the next", async () => {
    seedApplication("app_closed", { companyName: "Acme" });
    seedApplication("app_open", { companyName: "Globex" });
    submit.mockImplementation(async (_workspace, input) => {
      if (input.applicationId === "app_closed") throw new AppError("posting_closed", "Acme is no longer taking applications");
      return browserResult("submitted") as never;
    });
    const id = queue.enqueue("submit", { applicationIds: ["app_closed", "app_open"] });
    const run = await queue.wait(id);
    expect(run.summary).toMatchObject({ skipped: 1, sent: 1, failed: 0 });
    expect((run.summary as { items: Array<{ applicationId: string }> }).items.find((item) => item.applicationId === "app_closed"))
      .toMatchObject({ outcome: "skipped", code: "posting_closed", attempted: false });
    expect(messages(id).some((line) => line.includes("SKIP app_closed") && line.includes("no longer taking applications"))).toBe(true);
  });

  it("reports a browser abort as a failure with its reason and screenshot", async () => {
    seedApplication("app_one", { companyName: "Acme" });
    submit.mockResolvedValue(browserResult("aborted") as never);
    const id = queue.enqueue("submit", { applicationIds: ["app_one"] });
    const run = await queue.wait(id);
    expect(run.summary).toMatchObject({ failed: 1 });
    expect(messages(id).some((line) => line.startsWith("FAIL app_one Acme") && line.includes("captcha"))).toBe(true);
  });

  it("stops between items when cancelled during the pace wait", async () => {
    seedApplication("app_one", { companyName: "Acme" });
    seedApplication("app_two", { companyName: "Globex" });
    let runId = "";
    // The pace wait is where a cancel lands: the sleep rejects as soon as the run is cancelled.
    const cancelling: RunQueue = new RunQueue({
      db,
      workspace,
      sleep: async (_ms, signal) => {
        cancelling.cancel(runId);
        if (signal.aborted) throw new RunCancelledError();
      },
    });
    registerBuiltinTasks(cancelling);
    runId = cancelling.enqueue("submit", { applicationIds: ["app_one", "app_two"], paceSeconds: 5 });
    const run = await cancelling.wait(runId);
    await cancelling.shutdown(0);

    expect(run.status).toBe("cancelled");
    expect(run.summary).toMatchObject({ requested: 2, sent: 1 });
    expect(submit).toHaveBeenCalledTimes(1);
  });
});

describe("prepare run", () => {
  function seedAccepted(id: string, company: string, tier: "A" | "B" | "C", score: number): void {
    upsertJobs(db, [makeJob({ id, fingerprint: `fp_${id}`, externalId: id, companyName: company })]);
    saveEvaluation(db, {
      jobId: id,
      decision: "accept",
      gate: { passed: true, rule: null, reason: "", evidence: "" },
      trackId: "ai-security",
      score,
      tier,
      components: [],
      flags: [],
      evaluatedAt: new Date().toISOString(),
    });
  }

  it("selects from the queue like prepare_batch and reports ready versus needs-human", async () => {
    writeCampaign({ submission: { mode: "auto", maxBatchSize: 2, maxPerCompany: 3 } });
    seedAccepted("job_a", "Acme", "A", 90);
    seedAccepted("job_b", "Globex", "B", 80);
    seedAccepted("job_c", "Hooli", "C", 70);
    seedAccepted("job_d", "Umbrella", "B", 78);
    prepare.mockImplementation((async (_workspace: Workspace, input: { jobId: string }) => ({
      applicationId: `app_${input.jobId}`,
      status: input.jobId === "job_b" ? "needs_human" : "awaiting_approval",
      questionsNeedingHuman: input.jobId === "job_b" ? [{ key: "q1", label: "Salary expectations", category: "compensation", suggested: "", guidance: "" }] : [],
      resumeBlocker: undefined,
    })) as never);

    const id = queue.enqueue("prepare", { filter: { limit: 10 } });
    const run = await queue.wait(id);

    // Tier C is excluded by default and the selection is capped at maxBatchSize.
    expect(prepare.mock.calls.map(([, input]) => input.jobId)).toEqual(["job_a", "job_b"]);
    expect(run.summary).toMatchObject({ selected: 2, ready: 1, needsHuman: 1, failed: 0 });
    expect(run.summary).toMatchObject({ recurringQuestions: [{ label: "Salary expectations", count: 1 }] });
    expect(messages(id)).toContain("Limit 10 reduced to submission.maxBatchSize (2).");
  });

  it("prepares explicit job ids and records failures per item", async () => {
    seedAccepted("job_a", "Acme", "A", 90);
    prepare.mockRejectedValueOnce(new AppError("job_not_accepted", "job was reject")).mockResolvedValueOnce({
      applicationId: "app_job_a",
      status: "awaiting_approval",
      questionsNeedingHuman: [],
      resumeBlocker: undefined,
    } as never);
    const run = await queue.wait(queue.enqueue("prepare", { jobIds: ["job_x", "job_a"] }));
    expect(run.summary).toMatchObject({ selected: 2, ready: 1, failed: 1 });
  });

  it("refuses jobIds and a filter together", () => {
    expect(() => queue.enqueue("prepare", { jobIds: ["a"], filter: {} })).toThrow(/jobIds or filter, not both/);
  });
});

describe("discovery run", () => {
  const evaluation = { evaluated: 2, accepted: 1, review: 0, rejected: 1, duplicates: 0, topRejectionRules: [] };

  it("discovers active boards in chunks with per-board progress", async () => {
    runDiscovery.mockImplementation(async (_workspace, input) => {
      const names = input?.companies ?? [];
      names.forEach((name, index) => input?.onBoard?.({ name } as never, [], index + 1, names.length));
      return {
        boardsQueried: names.length,
        postingsFetched: names.length * 2,
        newPostings: 1,
        refreshedPostings: 1,
        evaluation,
        totalStoredJobs: 10,
        boardIssues: [],
      };
    });
    const id = queue.enqueue("discovery", { chunkSize: 1 });
    const run = await queue.wait(id);

    expect(runDiscovery.mock.calls.map(([, input]) => input?.companies)).toEqual([["Acme"], ["Globex"]]);
    expect(run.summary).toMatchObject({ boards: 2, boardsQueried: 2, postingsFetched: 4, newPostings: 2 });
    expect(run.progressDone).toBe(2);
    expect(run.progressTotal).toBe(2);
  });

  it("skips inactive and unknown companies and fails when nothing is left", async () => {
    const id = queue.enqueue("discovery", { companies: ["Initech", "Nobody"] });
    const run = await queue.wait(id);
    expect(run.status).toBe("failed");
    expect(run.error).toMatch(/no active boards match/);
    expect(messages(id)).toContain("Not in companies.json, skipped: Nobody");
  });
});
