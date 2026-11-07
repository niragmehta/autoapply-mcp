import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { getWorkspace } from "../src/config/load.js";
import { computeManifestHash, createBatch, listBatchItems } from "../src/db/repositories/batches.js";
import { listQueue } from "../src/db/repositories/jobs.js";
import { OutcomeKindSchema } from "../src/domain/policies/followup.js";
import { CLOSED_REASON, FEATURE_IDS } from "./dashboardFeatureSeed.js";
import { bearer, http, jsonBody, startFixture, type Fixture } from "./dashboardFixture.js";

/**
 * Pipeline features in the dashboard API: dismissing and restoring jobs with
 * counts that agree with list_queue, liveness and legitimacy on a job, the
 * after-applying summary, the outcome taxonomy, and closed postings in
 * submit results.
 */

let fixture: Fixture;
let port: number;

const get = async <T = Record<string, unknown>>(path: string) => {
  const response = await http(port, path, { headers: bearer() });
  expect(response.status, `${path}: ${response.text.slice(0, 300)}`).toBe(200);
  return response.json<T>();
};

const send = (method: string, path: string, body: unknown) => http(port, path, { method, ...jsonBody(port, body) });

type JobsPage = { total: number; rows: Array<{ id: string; dismissal: { reason: string } | null; roleApplied: boolean; liveness: { status: string } | null }> };

beforeAll(async () => {
  fixture = await startFixture("dashboard-pipeline", {
    features: true,
    // Submission re-checks liveness; the closed posting's fresh stored verdict answers without the network.
    campaign: { hygiene: { liveness: { beforePrepare: false, beforeSubmit: true } } },
  });
  port = fixture.port;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await fixture.close();
});

describe("job dismissal", () => {
  it("counts the unprepared queue the way list_queue does: by fingerprint, without dismissed roles", async () => {
    const status = await get<{ jobs: { queueDepth: number; dismissed: number } }>("/api/status");
    expect(status.jobs.queueDepth).toBe(1);
    expect(status.jobs.queueDepth).toBe(listQueue(getWorkspace().db, { limit: 1000 }).length);
    expect(status.jobs.dismissed).toBe(0);

    const unprepared = await get<JobsPage>("/api/jobs?decision=accept&hasApplication=no");
    expect(unprepared.rows.map((row) => row.id)).toEqual([FEATURE_IDS.queueJob]);
    const duplicate = (await get<JobsPage>("/api/jobs?q=Senior")).rows.find((row) => row.id === FEATURE_IDS.duplicateJob);
    expect(duplicate?.roleApplied).toBe(true);
  });

  it("dismisses with a reason, hides the role by default and shows it under the Dismissed filter", async () => {
    const dismissed = await send("POST", `/api/jobs/${FEATURE_IDS.queueJob}/dismiss`, { reason: "on-site only" });
    expect(dismissed.status).toBe(200);
    expect(dismissed.json()).toMatchObject({ jobId: FEATURE_IDS.queueJob, dismissed: true, reason: "on-site only" });

    const visible = await get<JobsPage>("/api/jobs?pageSize=200");
    expect(visible.rows.some((row) => row.id === FEATURE_IDS.queueJob)).toBe(false);
    const only = await get<JobsPage>("/api/jobs?dismissed=only");
    expect(only.rows).toEqual([expect.objectContaining({ id: FEATURE_IDS.queueJob, dismissal: expect.objectContaining({ reason: "on-site only" }) })]);
    const included = await get<JobsPage>("/api/jobs?dismissed=include&pageSize=200");
    expect(included.total).toBe(visible.total + 1);

    const status = await get<{ jobs: { queueDepth: number; dismissed: number }; nextActions: Array<{ id: string }> }>("/api/status");
    expect(status.jobs).toMatchObject({ queueDepth: 0, dismissed: 1 });
    expect(status.jobs.queueDepth).toBe(listQueue(getWorkspace().db, { limit: 1000 }).length);
    expect(status.nextActions.some((action) => action.id === "prepare")).toBe(false);

    const list = await get<{ jobs: Array<{ jobId: string; reason: string }> }>("/api/jobs/dismissed");
    expect(list.jobs).toEqual([expect.objectContaining({ jobId: FEATURE_IDS.queueJob, reason: "on-site only" })]);
    const detail = await get<{ dismissal: { reason: string } | null }>(`/api/jobs/${FEATURE_IDS.queueJob}`);
    expect(detail.dismissal?.reason).toBe("on-site only");
  });

  it("restores a dismissed role", async () => {
    const restored = await send("POST", `/api/jobs/${FEATURE_IDS.queueJob}/restore`, {});
    expect(restored.status).toBe(200);
    expect(restored.json()).toMatchObject({ restored: true });
    expect((await get<{ jobs: { queueDepth: number } }>("/api/status")).jobs.queueDepth).toBe(1);
  });

  it("dismisses and restores in bulk, reporting each refusal separately", async () => {
    const bulk = await send("POST", "/api/jobs/dismiss", { jobIds: [FEATURE_IDS.queueJob, "job_acme", "job_missing"], reason: "not now" });
    expect(bulk.status).toBe(200);
    const result = bulk.json<{ dismissed: Array<{ jobId: string }>; failed: Array<{ jobId: string; code: string }> }>();
    expect(result.dismissed.map((entry) => entry.jobId)).toEqual([FEATURE_IDS.queueJob]);
    expect(result.failed).toEqual([
      expect.objectContaining({ jobId: "job_acme", code: "already_submitted" }),
      expect.objectContaining({ jobId: "job_missing", code: "job_not_found" }),
    ]);
    const back = await send("POST", "/api/jobs/restore", { jobIds: [FEATURE_IDS.queueJob] });
    expect(back.json<{ restored: Array<{ restored: boolean }> }>().restored).toEqual([expect.objectContaining({ restored: true })]);
  });

  it("refuses to dismiss a submitted application's job, validates input, and needs the same-origin check", async () => {
    const sent = await send("POST", "/api/jobs/job_acme/dismiss", {});
    expect(sent.status).toBe(409);
    expect(sent.json<{ error: { code: string } }>().error.code).toBe("already_submitted");
    expect((await send("POST", `/api/jobs/${FEATURE_IDS.queueJob}/dismiss`, { reason: "x".repeat(501) })).status).toBe(400);
    expect((await send("POST", "/api/jobs/dismiss", { jobIds: [] })).status).toBe(400);
    expect((await send("POST", "/api/jobs/job_missing/dismiss", {})).status).toBe(404);
    const crossSite = await http(port, `/api/jobs/${FEATURE_IDS.queueJob}/dismiss`, {
      method: "POST",
      ...jsonBody(port, {}, { origin: "https://evil.example" }),
    });
    expect(crossSite.status).toBe(403);
  });
});

describe("liveness and legitimacy", () => {
  it("shows the stored verdict on rows and the history and signals on the detail", async () => {
    const rows = await get<JobsPage>("/api/jobs?q=Senior&pageSize=50");
    expect(rows.rows.find((row) => row.id === "job_acme")?.liveness?.status).toBe("open");

    const detail = await get<{
      liveness: { history: Array<{ status: string }> };
      legitimacy: { tier: string; signals: unknown[]; repost: { postings: number } | null; error: string | null };
    }>(`/api/jobs/${FEATURE_IDS.repostJob}`);
    expect(detail.liveness.history).toEqual([]);
    expect(detail.legitimacy.error).toBeNull();
    expect(["high", "caution", "suspicious"]).toContain(detail.legitimacy.tier);
    expect(detail.legitimacy.repost?.postings).toBe(2);
  });

  it("checks a posting now and stores the verdict", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ id: 10 }), { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const checked = await send("POST", `/api/jobs/${FEATURE_IDS.queueJob}/liveness`, {});
    expect(checked.status).toBe(200);
    const body = checked.json<{ verdict: { status: string; via: string; reused: boolean }; legitimacy: { tier: string } }>();
    expect(body.verdict).toMatchObject({ status: "open", via: "api", reused: false });
    expect(fetchMock).toHaveBeenCalled();
    const detail = await get<{ liveness: { history: Array<{ status: string }> } }>(`/api/jobs/${FEATURE_IDS.queueJob}`);
    expect(detail.liveness.history[0]?.status).toBe("open");
    expect((await send("POST", "/api/jobs/job_missing/liveness", {})).status).toBe(404);
    expect((await send("POST", `/api/jobs/${FEATURE_IDS.queueJob}/liveness`, { force: "yes" })).status).toBe(400);
  });
});

describe("after applying, on the overview", () => {
  it("summarises replies, follow-ups, interviews, offers and proposals, and turns them into next actions", async () => {
    const status = await get<{
      afterApply: Record<string, unknown>;
      nextActions: Array<{ id: string; count: number; href: string }>;
    }>("/api/status");
    expect(status.afterApply).toMatchObject({
      repliesToReview: 2,
      followUpsDue: 1,
      interviewsThisWeek: 1,
      activeOffers: 1,
      offersDueThisWeek: 1,
      newLeads: 2,
      pendingProposals: 1,
    });
    expect(status.afterApply.nextInterview).toMatchObject({ company: "Acme" });
    const ids = status.nextActions.map((action) => action.id);
    expect(ids).toEqual(expect.arrayContaining(["replies", "follow-ups", "interviews", "offers", "proposals"]));
    expect(status.nextActions.find((action) => action.id === "replies")).toMatchObject({ count: 2, href: "/inbox" });
  });
});

describe("outcome taxonomy", () => {
  it("serves the outcome kinds from the follow-up policy, assessment included", async () => {
    const meta = await get<{ outcomeStatuses: string[]; outcomes: { kinds: string[]; responses: string[]; progress: string[]; terminal: string[]; rank: Record<string, number> } }>(
      "/api/meta",
    );
    expect(meta.outcomes.kinds).toEqual(OutcomeKindSchema.options);
    expect(meta.outcomeStatuses).toEqual(OutcomeKindSchema.options);
    expect(meta.outcomes.kinds).toContain("assessment");
    expect(meta.outcomes.responses).toEqual(["recruiter_screen", "assessment", "interview", "offer", "rejected"]);
    expect(meta.outcomes.rank.acknowledged).toBe(1);
    expect(meta.outcomes.rank.rejected).toBe(0);
    const status = await get<{ outcomes: { taxonomy: { responses: string[] } } }>("/api/status");
    expect(status.outcomes.taxonomy.responses).toEqual(meta.outcomes.responses);
  });

  it("records an assessment outcome and counts it as a response", async () => {
    const before = (await get<{ outcomes: { responded: number } }>("/api/status")).outcomes.responded;
    const recorded = await send("POST", `/api/applications/${FEATURE_IDS.followUpApplication}/outcome`, { status: "assessment", detail: "take-home sent" });
    expect(recorded.status).toBe(201);
    expect(recorded.json()).toMatchObject({ kind: "assessment" });
    expect((await get<{ outcomes: { responded: number } }>("/api/status")).outcomes.responded).toBe(before + 1);
    expect((await send("POST", "/api/applications/app_sent/outcome", { status: "hired" })).status).toBe(400);
  });
});

describe("closed postings in submit results", () => {
  it("counts skipped items carrying code posting_closed, and infers nothing from wording or audit events", async () => {
    const detail = await get<{ run: { summary: { postingClosed: number; items: Array<{ applicationId: string; code?: string; outcome: string }> } } }>(
      `/api/runs/${FEATURE_IDS.submitRun}`,
    );
    expect(detail.run.summary.postingClosed).toBe(1);
    const codes = Object.fromEntries(detail.run.summary.items.map((item) => [item.applicationId, item.code ?? null]));
    expect(codes).toEqual({ [FEATURE_IDS.closedApplication]: "posting_closed", app_held: null, app_sent: null });
    expect(detail.run.summary.items[0]).toMatchObject({ outcome: "skipped", reason: CLOSED_REASON });

    const list = await get<{ runs: Array<{ id: string; summary: { postingClosed?: number } | null }> }>("/api/runs?type=submit");
    expect(list.runs.find((run) => run.id === FEATURE_IDS.submitRun)?.summary?.postingClosed).toBe(1);
    const propose = await get<{ runs: Array<{ summary: Record<string, unknown> | null }> }>("/api/runs?type=propose");
    expect(propose.runs[0]?.summary).not.toHaveProperty("postingClosed");
  });

  it("reports posting_closed with its own code when a packet is requested for a closed posting", async () => {
    const application = await get<{ preview: { packetHash: string }; liveness: { status: string } | null }>(`/api/applications/${FEATURE_IDS.closedApplication}`);
    expect(application.liveness?.status).toBe("closed");
    const approved = await send("POST", `/api/applications/${FEATURE_IDS.closedApplication}/approve`, { packetHash: application.preview.packetHash });
    expect(approved.status).toBe(200);
    const manual = await send("POST", `/api/applications/${FEATURE_IDS.closedApplication}/submit`, { mode: "manual" });
    expect(manual.status).toBe(409);
    const error = manual.json<{ error: { code: string; message: string } }>().error;
    expect(error.code).toBe("posting_closed");
    expect(error.message).toContain("no longer taking applications");
  });
});

describe("dismissing a role with an approved application", () => {
  it("skips the application, voids its approval by a rejection of its packet, and takes it out of prepared batches", async () => {
    const before = await get<{ approval: { decision: string } | null; preview: { packetHash: string } }>(`/api/applications/${FEATURE_IDS.closedApplication}`);
    expect(before.approval?.decision).toBe("approved");
    const db = getWorkspace().db;
    const item = {
      batchId: "bat_dismissal",
      applicationId: FEATURE_IDS.closedApplication,
      jobId: FEATURE_IDS.closedJob,
      packetHash: before.preview.packetHash,
      state: "ready" as const,
      detail: "",
    };
    createBatch(
      db,
      { id: "bat_dismissal", createdAt: new Date().toISOString(), filter: {}, manifestHash: computeManifestHash([item]), status: "prepared", approvedAt: null, note: "" },
      [item],
    );

    const dismissed = await send("POST", `/api/jobs/${FEATURE_IDS.closedJob}/dismiss`, { reason: "posting closed" });
    expect(dismissed.status).toBe(200);
    expect(dismissed.json()).toMatchObject({ skippedApplicationId: FEATURE_IDS.closedApplication, batchItemsSkipped: 1 });
    expect(listBatchItems(db, "bat_dismissal")).toEqual([expect.objectContaining({ state: "skipped", detail: "job dismissed: posting closed" })]);

    const after = await get<{
      application: { status: string };
      approval: { decision: string; note: string } | null;
      events: Array<{ type: string; payload: Record<string, unknown> }>;
    }>(`/api/applications/${FEATURE_IDS.closedApplication}`);
    expect(after.application.status).toBe("skipped");
    expect(after.approval).toMatchObject({ decision: "rejected", note: "job dismissed: posting closed" });
    expect(after.events).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "job.dismissed", payload: expect.objectContaining({ reason: "posting closed", batchItemsSkipped: 1 }) }),
        expect.objectContaining({ type: "application.approval", payload: expect.objectContaining({ decision: "rejected" }) }),
      ]),
    );
  });
});
