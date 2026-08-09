import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase, type Db } from "../src/db/database.js";
import {
  countJobs,
  findDuplicates,
  getEvaluation,
  getJob,
  listQueue,
  rejectionBreakdown,
  saveEvaluation,
  tierBreakdown,
  upsertJobs,
} from "../src/db/repositories/jobs.js";
import {
  countSubmittedSince,
  getApplicationByJob,
  lastSubmissionAt,
  latestApproval,
  listApplications,
  listOutcomes,
  recordApproval,
  recordOutcome,
  saveApplication,
} from "../src/db/repositories/applications.js";
import { appendEvent, listEvents } from "../src/db/repositories/events.js";
import { evaluateAndStore } from "../src/pipeline.js";
import type { Application, Evaluation } from "../src/domain/job.js";
import { makeCampaign, makeJob, makeProfile } from "./factories.js";

let db: Db;

beforeEach(() => {
  db = openDatabase(":memory:");
});

function evaluation(jobId: string, overrides: Partial<Evaluation> = {}): Evaluation {
  return {
    jobId,
    decision: "accept",
    gate: { passed: true, rule: null, reason: "ok", evidence: "" },
    trackId: "ai-security",
    score: 90,
    tier: "A",
    components: [],
    flags: [],
    evaluatedAt: new Date().toISOString(),
    ...overrides,
  };
}

function application(jobId: string, overrides: Partial<Application> = {}): Application {
  return {
    id: "app_1",
    jobId,
    status: "approved",
    resumeId: "ai-security",
    resumePath: "/tmp/r.pdf",
    packetHash: "hash-1",
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
  };
}

describe("jobs repository", () => {
  it("inserts new jobs and updates existing ones", () => {
    const job = makeJob();
    expect(upsertJobs(db, [job])).toEqual({ inserted: 1, updated: 0 });
    expect(upsertJobs(db, [{ ...job, title: "Updated Title" }])).toEqual({ inserted: 0, updated: 1 });
    expect(countJobs(db)).toBe(1);
    expect(getJob(db, job.id)?.title).toBe("Updated Title");
  });

  it("round-trips structured fields", () => {
    const job = makeJob();
    upsertJobs(db, [job]);
    const stored = getJob(db, job.id);
    expect(stored?.locationsRaw).toEqual(job.locationsRaw);
    expect(stored?.compensation?.max).toBe(280000);
    expect(stored?.locationClass).toBe("bay-area");
  });

  it("finds duplicate roles by fingerprint", () => {
    const a = makeJob({ id: "job_a", externalId: "a" });
    const b = makeJob({ id: "job_b", externalId: "b", ats: "lever" });
    upsertJobs(db, [a, b]);
    expect(findDuplicates(db, a.fingerprint, a.id).map((job) => job.id)).toEqual(["job_b"]);
  });

  it("stores and reads evaluations", () => {
    const job = makeJob();
    upsertJobs(db, [job]);
    saveEvaluation(db, evaluation(job.id));
    expect(getEvaluation(db, job.id)?.score).toBe(90);
    expect(getEvaluation(db, job.id)?.tier).toBe("A");
  });
});

describe("queue", () => {
  it("returns accepted jobs ranked by score", () => {
    const high = makeJob({ id: "job_high", externalId: "1", fingerprint: "fp_high" });
    const low = makeJob({ id: "job_low", externalId: "2", fingerprint: "fp_low" });
    upsertJobs(db, [high, low]);
    saveEvaluation(db, evaluation(high.id, { score: 95 }));
    saveEvaluation(db, evaluation(low.id, { score: 70, tier: "C" }));

    const queue = listQueue(db, { minScore: 60 });
    expect(queue.map((item) => item.job.id)).toEqual(["job_high", "job_low"]);
  });

  it("excludes rejected jobs", () => {
    const job = makeJob();
    upsertJobs(db, [job]);
    saveEvaluation(db, evaluation(job.id, { decision: "reject", score: 0, tier: "none" }));
    expect(listQueue(db)).toHaveLength(0);
  });

  it("excludes a role already applied to, even on a different board", () => {
    const applied = makeJob({ id: "job_applied", externalId: "1" });
    const sameRoleElsewhere = makeJob({ id: "job_other", externalId: "2", ats: "lever" });
    upsertJobs(db, [applied, sameRoleElsewhere]);
    saveEvaluation(db, evaluation(applied.id));
    saveEvaluation(db, evaluation(sameRoleElsewhere.id));
    saveApplication(db, application(applied.id));

    expect(listQueue(db).map((item) => item.job.id)).toEqual([]);
  });

  it("filters by tier and track", () => {
    const job = makeJob();
    upsertJobs(db, [job]);
    saveEvaluation(db, evaluation(job.id, { tier: "B", trackId: "software" }));
    expect(listQueue(db, { tiers: ["A"] })).toHaveLength(0);
    expect(listQueue(db, { tiers: ["B"], trackId: "software" })).toHaveLength(1);
  });

  it("caps how many roles one company may take", () => {
    const jobs = ["a", "b", "c", "d"].map((suffix) =>
      makeJob({ id: `job_${suffix}`, externalId: suffix, fingerprint: `fp_${suffix}` }),
    );
    const elsewhere = makeJob({
      id: "job_other",
      externalId: "e",
      fingerprint: "fp_e",
      companyName: "Other Co",
    });
    upsertJobs(db, [...jobs, elsewhere]);
    for (const job of [...jobs, elsewhere]) saveEvaluation(db, evaluation(job.id));

    const capped = listQueue(db, { maxPerCompany: 3 });
    expect(capped.filter((item) => item.job.companyName === jobs[0].companyName)).toHaveLength(3);
    // The cap is per company, so an unrelated employer is unaffected.
    expect(capped.map((item) => item.job.id)).toContain("job_other");
    expect(listQueue(db, {})).toHaveLength(5);
  });

  it("counts applications already on file against a company's ceiling", () => {
    const jobs = ["a", "b", "c"].map((suffix) =>
      makeJob({ id: `job_${suffix}`, externalId: suffix, fingerprint: `fp_${suffix}` }),
    );
    upsertJobs(db, jobs);
    for (const job of jobs) saveEvaluation(db, evaluation(job.id));
    saveApplication(db, application(jobs[0].id, { id: "app_held" }));

    // One slot is spent, and that role is already excluded as applied to, so
    // only one of the two remaining roles may be taken.
    expect(listQueue(db, { maxPerCompany: 2 })).toHaveLength(1);
  });

  it("frees a slot when an application is withdrawn", () => {
    const jobs = ["a", "b", "c"].map((suffix) =>
      makeJob({ id: `job_${suffix}`, externalId: suffix, fingerprint: `fp_${suffix}` }),
    );
    upsertJobs(db, jobs);
    for (const job of jobs) saveEvaluation(db, evaluation(job.id));
    saveApplication(db, application(jobs[0].id, { id: "app_gone", status: "skipped" }));

    expect(listQueue(db, { maxPerCompany: 2 })).toHaveLength(2);
  });

  it("summarizes rejections and tiers", () => {
    const job = makeJob();
    upsertJobs(db, [job]);
    saveEvaluation(db, evaluation(job.id, {
      decision: "reject",
      gate: { passed: false, rule: "location-not-allowed", reason: "nope", evidence: "" },
    }));
    expect(rejectionBreakdown(db)[0]).toEqual({ rule: "location-not-allowed", count: 1 });
    expect(tierBreakdown(db)).toHaveLength(0);
  });
});

describe("applications repository", () => {
  it("keeps one application per job and updates in place", () => {
    const job = makeJob();
    upsertJobs(db, [job]);
    saveApplication(db, application(job.id));
    saveApplication(db, application(job.id, { status: "submitted", submittedAt: new Date().toISOString() }));
    expect(listApplications(db)).toHaveLength(1);
    expect(getApplicationByJob(db, job.id)?.status).toBe("submitted");
  });

  it("tracks approvals bound to a packet hash", () => {
    const job = makeJob();
    upsertJobs(db, [job]);
    saveApplication(db, application(job.id));
    recordApproval(db, { id: "apr_1", applicationId: "app_1", packetHash: "hash-1", decision: "approved", note: "" });
    expect(latestApproval(db, "app_1")?.packetHash).toBe("hash-1");
  });

  it("counts submissions for pacing and limits", () => {
    const job = makeJob();
    upsertJobs(db, [job]);
    const submittedAt = new Date().toISOString();
    saveApplication(db, application(job.id, { status: "submitted", submittedAt }));
    expect(countSubmittedSince(db, new Date(Date.now() - 3600_000).toISOString())).toBe(1);
    expect(lastSubmissionAt(db)).toBe(submittedAt);
  });

  it("records outcome history", () => {
    const job = makeJob();
    upsertJobs(db, [job]);
    saveApplication(db, application(job.id));
    recordOutcome(db, "app_1", "recruiter_screen", "call booked");
    recordOutcome(db, "app_1", "rejected", "");
    expect(listOutcomes(db, "app_1").map((entry) => entry.status)).toEqual(["recruiter_screen", "rejected"]);
  });
});

describe("audit log", () => {
  it("appends events and redacts payloads", () => {
    appendEvent(db, "submission.submitted", "app_1", { email: "alex@example.com" });
    const events = listEvents(db, "submission.submitted");
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).not.toContain("alex@example.com");
  });
});

describe("evaluateAndStore", () => {
  it("stores evaluations and summarizes the batch", () => {
    const good = makeJob({ id: "job_good", externalId: "1", fingerprint: "fp_good" });
    const intern = makeJob({ id: "job_intern", externalId: "2", fingerprint: "fp_intern", title: "Security Intern" });
    upsertJobs(db, [good, intern]);

    const summary = evaluateAndStore(db, [good, intern], makeCampaign(), makeProfile());
    expect(summary.evaluated).toBe(2);
    expect(summary.rejected).toBe(1);
    expect(summary.topRejectionRules[0]?.rule).toBe("seniority-rejected");
    expect(getEvaluation(db, good.id)?.decision).toBe("accept");
  });

  it("flags duplicate roles", () => {
    const a = makeJob({ id: "job_a", externalId: "1" });
    const b = makeJob({ id: "job_b", externalId: "2", ats: "lever" });
    upsertJobs(db, [a, b]);
    const summary = evaluateAndStore(db, [a, b], makeCampaign(), makeProfile());
    expect(summary.duplicates).toBe(2);
    expect(getEvaluation(db, a.id)?.flags.some((flag) => flag.startsWith("duplicate-role"))).toBe(true);
  });
});
