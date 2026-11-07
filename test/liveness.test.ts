import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveApplication } from "../src/db/repositories/applications.js";
import { latestLivenessFor, listingPresence, livenessHistory, recordLiveness } from "../src/db/repositories/liveness.js";
import { checkLiveness, checkLivenessMany, latestLiveness, livenessPreflight, livenessSummary } from "../src/hygiene/liveness.js";
import { prepareApplication } from "../src/services/applications.js";
import { makeJob } from "./factories.js";
import { makeWorkspace, setSeen, storeJobs, type TestWorkspace } from "./hygieneFixtures.js";

let workspace: TestWorkspace;

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

function stub(route: (url: string) => Response | Promise<Response>) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL) => {
      const href = typeof url === "string" ? url : url.toString();
      calls.push(href);
      return route(href);
    }),
  );
  return calls;
}

const job = makeJob({ id: "job_live", ats: "greenhouse", board: "acme", externalId: "4001", url: "https://job-boards.greenhouse.io/acme/jobs/4001" });

beforeEach(() => {
  process.env.AUTOAPPLY_MIN_INTERVAL_MS = "0";
  workspace = makeWorkspace();
  storeJobs(workspace, [job]);
});

afterEach(() => {
  vi.unstubAllGlobals();
  workspace.cleanup();
});

describe("checkLiveness", () => {
  it("asks the ATS first, stores the verdict and reuses it while fresh", async () => {
    const calls = stub(() => json({ id: 4001 }));
    const first = await checkLiveness(workspace, job);
    expect(first).toMatchObject({ status: "open", via: "api", reused: false, jobId: job.id });
    expect(calls).toHaveLength(1);

    const second = await checkLiveness(workspace, job);
    expect(second).toMatchObject({ status: "open", reused: true });
    expect(calls).toHaveLength(1);

    await checkLiveness(workspace, job, { force: true });
    expect(calls).toHaveLength(2);
    expect(livenessHistory(workspace.db, job.id)).toHaveLength(2);
    expect(latestLiveness(workspace.db, job.id)?.status).toBe("open");
  });

  it("re-checks an old verdict and retries an unknown one sooner", async () => {
    const calls = stub(() => json({ id: 4001 }));
    const twoHoursAgo = new Date(Date.now() - 2 * 3_600_000).toISOString();
    recordLiveness(workspace.db, { jobId: job.id, status: "unknown", via: "api", detail: "timeout", checkedAt: twoHoursAgo });
    expect((await checkLiveness(workspace, job)).reused).toBe(false);
    expect(calls).toHaveLength(1);

    const dayOld = new Date(Date.now() - 30 * 3_600_000).toISOString();
    recordLiveness(workspace.db, { jobId: job.id, status: "open", via: "api", detail: "old", checkedAt: dayOld });
    expect((await checkLiveness(workspace, job, { maxAgeHours: 48 })).reused).toBe(true);
  });

  it("reads the posting page when the ATS answer is inconclusive", async () => {
    stub((url) => (url.includes("boards-api") ? json({}, 403) : new Response("gone", { status: 404 })));
    expect(await checkLiveness(workspace, job)).toMatchObject({ status: "closed", via: "page" });
  });

  it("stays unknown on network failure and keeps both explanations", async () => {
    stub(() => {
      throw new TypeError("fetch failed");
    });
    const verdict = await checkLiveness(workspace, job);
    expect(verdict.status).toBe("unknown");
    expect(verdict.detail).toContain("page:");
  }, 15_000);

  it("reads the page directly for postings with no ATS check", async () => {
    const external = makeJob({ id: "job_ext", ats: "external", board: "careers.example.com", url: "https://careers.example.com/jobs/77777" });
    storeJobs(workspace, [external]);
    stub(() => new Response("<h1>This job is no longer available</h1>", { status: 200 }));
    expect(await checkLiveness(workspace, external)).toMatchObject({ status: "closed", via: "page" });
  });

  it("refuses to fetch a private host and reports unknown", async () => {
    const internal = makeJob({ id: "job_int", ats: "external", board: "intranet", url: "https://192.168.1.10/jobs/1", applyUrl: "https://192.168.1.10/jobs/1" });
    storeJobs(workspace, [internal]);
    const calls = stub(() => json({}));
    const verdict = await checkLiveness(workspace, internal);
    expect(verdict.status).toBe("unknown");
    expect(verdict.detail).toContain("private_host");
    expect(calls).toHaveLength(0);
  });

  it("checks several postings and reports ids it does not know", async () => {
    stub(() => json({ id: 4001 }));
    const result = await checkLivenessMany(workspace, [job.id, "job_missing", job.id]);
    expect(result).toMatchObject({ checked: 1, open: 1, missing: ["job_missing"] });
    expect(latestLivenessFor(workspace.db, [job.id]).get(job.id)?.status).toBe("open");
    expect(livenessSummary(workspace.db, job.id)?.ageHours).toBeGreaterThanOrEqual(0);
  });
});

describe("listingPresence", () => {
  it("compares a posting with the board's latest full fetch", () => {
    const others = ["a", "b", "c"].map((suffix) =>
      makeJob({ id: `job_${suffix}`, ats: "greenhouse", board: "acme", externalId: suffix, fingerprint: suffix }),
    );
    storeJobs(workspace, others);
    setSeen(workspace, job.id, "2026-09-01T00:00:00.000Z", "2026-09-01T00:00:00.000Z");
    setSeen(workspace, "job_a", "2026-09-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z");
    setSeen(workspace, "job_b", "2026-09-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z");
    // A single pasted posting refreshed later is not a board fetch.
    setSeen(workspace, "job_c", "2026-10-05T00:00:00.000Z", "2026-10-05T00:00:00.000Z");

    expect(listingPresence(workspace.db, job)).toMatchObject({ status: "absent", boardFetchedAt: "2026-10-01T00:00:00.000Z" });
    expect(listingPresence(workspace.db, others[0]!).status).toBe("listed");
    expect(listingPresence(workspace.db, others[2]!).status).toBe("listed");
    expect(listingPresence(workspace.db, makeJob({ id: "job_x", ats: "external" })).status).toBe("unknown");
  });
});

describe("livenessPreflight", () => {
  beforeEach(() => {
    saveApplication(workspace.db, {
      id: "app_1", jobId: job.id, status: "approved", resumeId: "ai-security", resumePath: "resume.pdf", packetHash: "h",
      coverLetter: "", answers: [], blockedQuestions: [], createdAt: new Date().toISOString(), approvedAt: null,
      submittedAt: null, submissionMode: null, confirmationRef: null, artifactPath: null, notes: "",
    });
  });

  it("blocks only a closed posting", async () => {
    stub(() => json({ status: 404 }, 404));
    expect(await livenessPreflight(workspace, "app_1")).toMatchObject({ ok: false });
  });

  it("lets an unknown verdict through with its reason", async () => {
    stub((url) => (url.includes("boards-api") ? json({}, 403) : new Response("", { status: 503 })));
    const result = await livenessPreflight(workspace, "app_1");
    expect(result.ok).toBe(true);
    expect(result.reason).toMatch(/unconfirmed/);
  });

  it("skips the check when the campaign turns it off, and fails a missing application", async () => {
    const calls = stub(() => json({}));
    const relaxed = { ...workspace, campaign: { ...workspace.campaign, hygiene: { ...workspace.campaign.hygiene, liveness: { ...workspace.campaign.hygiene.liveness, beforeSubmit: false } } } };
    expect(await livenessPreflight(relaxed, "app_1")).toEqual({ ok: true });
    expect(calls).toHaveLength(0);
    expect((await livenessPreflight(workspace, "app_missing")).ok).toBe(false);
  });
});

describe("prepareApplication", () => {
  it("refuses a closed posting before drafting anything", async () => {
    stub(() => json({ status: 404, error: "Job not found" }, 404));
    await expect(prepareApplication(workspace, { jobId: job.id })).rejects.toMatchObject({ code: "posting_closed" });
  });
});
