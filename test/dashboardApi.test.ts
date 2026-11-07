import { readFileSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { SECRET_VALUE, bearer, http, jsonBody, startFixture, type Fixture } from "./dashboardFixture.js";
import { fixtureResumePath } from "./factories.js";

/** The dashboard's JSON API against a seeded workspace: each endpoint calls the shared services. */

let fixture: Fixture;
let port: number;

const get = async <T = Record<string, unknown>>(path: string) => {
  const response = await http(port, path, { headers: bearer() });
  expect(response.status, `${path}: ${response.text.slice(0, 300)}`).toBe(200);
  return response.json<T>();
};

const send = (method: string, path: string, body: unknown) => http(port, path, { method, ...jsonBody(port, body) });

beforeAll(async () => {
  fixture = await startFixture("dashboard-api");
  port = fixture.port;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(async () => {
  await fixture.close();
});

describe("status and meta", () => {
  it("summarises the campaign: funnel, held work, today and the round", async () => {
    const status = await get<{
      funnel: Array<{ id: string; count: number }>;
      applications: { needsHuman: number; submitted: number };
      jobs: { acceptedByTier: Record<string, number>; queueDepth: number };
      today: { submitted: number; dailyLimit: number };
      round: { max: number; submitted: number; companies: Array<{ company: string; submitted: number }> };
      nextActions: Array<{ id: string; count: number }>;
    }>("/api/status");
    expect(Object.fromEntries(status.funnel.map((station) => [station.id, station.count]))).toMatchObject({
      discovered: 3,
      accepted: 2,
      prepared: 2,
      submitted: 1,
    });
    expect(status.jobs.acceptedByTier).toEqual({ A: 1, B: 1, C: 0 });
    expect(status.applications.needsHuman).toBe(1);
    expect(status.today).toMatchObject({ submitted: 1, dailyLimit: 20 });
    expect(status.round).toMatchObject({ max: 2, submitted: 1, companies: [{ company: "Acme", submitted: 1 }] });
    expect(status.nextActions.find((action) => action.id === "needs-human")?.count).toBe(1);
  });

  it("lists the enumerations filter controls need", async () => {
    const meta = await get<{ tracks: Array<{ id: string }>; companies: string[]; runTypes: Array<{ type: string }> }>("/api/meta");
    expect(meta.tracks.map((track) => track.id)).toEqual(["ai-security"]);
    expect(meta.companies).toEqual(["Acme", "Globex"]);
    expect(meta.runTypes.map((type) => type.type)).toEqual(expect.arrayContaining(["discovery", "prepare", "submit"]));
  });
});

describe("jobs", () => {
  it("filters, sorts and pages in SQL", async () => {
    const accepted = await get<{ total: number; rows: Array<{ id: string; application: unknown }> }>("/api/jobs?decision=accept&sort=score&dir=desc");
    expect(accepted.total).toBe(2);
    expect(accepted.rows.map((row) => row.id)).toEqual(["job_acme", "job_globex"]);

    const search = await get<{ rows: Array<{ id: string }> }>("/api/jobs?q=intern");
    expect(search.rows.map((row) => row.id)).toEqual(["job_reject"]);

    const unapplied = await get<{ total: number }>("/api/jobs?hasApplication=no");
    expect(unapplied.total).toBe(1);

    const paged = await get<{ total: number; pages: number; rows: unknown[] }>("/api/jobs?pageSize=1&page=2&sort=company&dir=asc");
    expect(paged).toMatchObject({ total: 3, pages: 3 });
    expect(paged.rows).toHaveLength(1);
  });

  it("explains one job with its evaluation and application", async () => {
    const detail = await get<{ evaluation: { score: number; components: unknown[] }; application: { id: string } }>("/api/jobs/job_acme");
    expect(detail.evaluation.score).toBe(88);
    expect(detail.evaluation.components).toHaveLength(1);
    expect(detail.application.id).toBe("app_sent");
    expect((await http(port, "/api/jobs/job_nope", { headers: bearer() })).status).toBe(404);
  });

  it("refuses to prepare a rejected job unless forced, with the service's own code", async () => {
    const refused = await send("POST", "/api/jobs/job_reject/prepare", {});
    expect(refused.status).toBe(409);
    expect(refused.json<{ error: { code: string } }>().error.code).toBe("job_not_accepted");
  });
});

describe("applications", () => {
  it("lists applications with unresolved counts", async () => {
    const held = await get<{ rows: Array<{ id: string; unresolved: number; company: string }> }>("/api/applications?status=needs_human");
    expect(held.rows).toEqual([expect.objectContaining({ id: "app_held", unresolved: 1, company: "Globex" })]);
  });

  it("shows the packet, the blocked answers and the screenshots", async () => {
    const detail = await get<{
      preview: { text: string; unresolvedRequired: string[]; packetHash: string };
      answers: Array<{ questionKey: string; blocked: boolean }>;
      artifacts: Array<{ name: string; stage: string }>;
    }>("/api/applications/app_held");
    expect(detail.preview.text).toContain("Company:   Globex");
    expect(detail.preview.unresolvedRequired).toEqual(["Will you require visa sponsorship?"]);
    expect(detail.answers.find((answer) => answer.questionKey === "sponsor")?.blocked).toBe(true);
    expect(detail.artifacts).toEqual([expect.objectContaining({ name: "app_held-captcha-1730000000000.png", stage: "captcha" })]);
  });

  it("shortens the home folder in the packet text it shows", async () => {
    // Pretend the resume's folder is the home folder, so the check does not depend on where the OS keeps temp files.
    const saved = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
    const resumeDir = dirname(fixtureResumePath());
    process.env.HOME = resumeDir;
    process.env.USERPROFILE = resumeDir;
    try {
      const detail = await get<{ preview: { text: string } }>("/api/applications/app_held");
      expect(detail.preview.text).toContain(`~${sep}resume.pdf`);
      expect(detail.preview.text).not.toContain(resumeDir);
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
    }
  });

  it("refuses browser submission outside a run and approval of a stale hash", async () => {
    const auto = await send("POST", "/api/applications/app_held/submit", { mode: "auto" });
    expect(auto.status).toBe(409);
    expect(auto.json<{ error: { code: string } }>().error.code).toBe("use_submit_run");
    const stale = await send("POST", "/api/applications/app_held/approve", { packetHash: "0".repeat(64) });
    expect(stale.status).toBe(409);
    expect(stale.json<{ error: { code: string } }>().error.code).toBe("packet_hash_mismatch");
  });

  it("records an outcome", async () => {
    const recorded = await send("POST", "/api/applications/app_sent/outcome", { status: "interview", detail: "phone screen booked" });
    expect(recorded.status).toBe(201);
    expect(recorded.json<{ history: Array<{ status: string }> }>().history.map((entry) => entry.status)).toEqual(["interview"]);
    const status = await get<{ outcomes: { responded: number } }>("/api/status");
    expect(status.outcomes.responded).toBe(1);
  });
});

describe("needs human", () => {
  it("groups held applications by question and answers them in bulk", async () => {
    const queue = await get<{
      applications: number;
      questions: Array<{ label: string; applications: Array<{ applicationId: string; questionKey: string; screenshot: string | null }> }>;
    }>("/api/needs-human");
    expect(queue.applications).toBe(1);
    expect(queue.questions[0]).toMatchObject({
      label: "Will you require visa sponsorship?",
      applications: [{ applicationId: "app_held", questionKey: "sponsor", screenshot: "app_held-captcha-1730000000000.png" }],
    });

    const answered = await send("POST", "/api/needs-human/answers", {
      items: [
        { applicationId: "app_held", questionKey: "sponsor", answer: "Yes" },
        { applicationId: "app_ghost", questionKey: "sponsor", answer: "Yes" },
      ],
    });
    expect(answered.status).toBe(200);
    expect(answered.json()).toMatchObject({ updated: 1, failed: 1 });

    const detail = await get<{ application: { status: string }; preview: { unresolvedRequired: string[] } }>("/api/applications/app_held");
    expect(detail.application.status).toBe("awaiting_approval");
    expect(detail.preview.unresolvedRequired).toEqual([]);
  });
});

describe("companies", () => {
  it("toggles a board in companies.json", async () => {
    const patched = await send("PATCH", "/api/companies/globex", { active: false, tags: ["paused"] });
    expect(patched.status).toBe(200);
    const saved = JSON.parse(readFileSync(join(fixture.home, "companies.json"), "utf8"));
    expect(saved.companies.find((company: { name: string }) => company.name === "Globex")).toMatchObject({ active: false, tags: ["paused"] });
    const list = await get<{ active: number; companies: Array<{ name: string; stats: { jobs: number } }> }>("/api/companies");
    expect(list.active).toBe(1);
    expect(list.companies.find((company) => company.name === "Acme")?.stats.jobs).toBe(2);
    expect((await send("PATCH", "/api/companies/Nobody", { active: true })).status).toBe(404);
    expect((await send("PATCH", "/api/companies/Acme", {})).status).toBe(400);
  });

  it("saves a new board only after it verifies", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const href = String(url);
        const jobs = href.includes("initech") ? [{ id: 1, title: "Security Engineer", absolute_url: "https://job-boards.greenhouse.io/initech/jobs/1", location: { name: "Remote" }, content: "" }] : [];
        return new Response(JSON.stringify({ jobs }), { status: 200, headers: { "content-type": "application/json" } });
      }),
    );
    const empty = await send("POST", "/api/companies", { name: "Hooli", ats: "greenhouse", board: "hooli" });
    expect(empty.status).toBe(422);
    expect(empty.json()).toMatchObject({ saved: false });

    const added = await send("POST", "/api/companies", { name: "Initech", ats: "greenhouse", board: "initech", tier: "C" });
    expect(added.status).toBe(201);
    expect(added.json()).toMatchObject({ saved: true, action: "added", postings: 1 });
    const saved = JSON.parse(readFileSync(join(fixture.home, "companies.json"), "utf8"));
    expect(saved.companies.map((company: { name: string }) => company.name)).toContain("Initech");
  });
});

describe("runs, events and health", () => {
  it("starts, lists, inspects and cancels runs", async () => {
    const started = await send("POST", "/api/runs", { type: "echo", params: { lines: 2, holdMs: 200 } });
    expect(started.status).toBe(201);
    const { runId } = started.json<{ runId: string }>();
    const cancelled = await send("POST", `/api/runs/${runId}/cancel`, {});
    expect(cancelled.json()).toMatchObject({ runId, outcome: "signalled" });
    await fixture.queue.wait(runId);

    const detail = await get<{ run: { status: string; hostedHere: boolean }; logs: Array<{ message: string }> }>(`/api/runs/${runId}`);
    expect(detail.run.status).toBe("cancelled");
    expect(detail.logs.map((line) => line.message)).toContain("Run cancelled.");
    const list = await get<{ runs: Array<{ id: string }> }>("/api/runs?status=cancelled");
    expect(list.runs.map((run) => run.id)).toContain(runId);
    const logs = await get<{ logs: Array<{ seq: number }> }>(`/api/runs/${runId}/logs?afterSeq=1`);
    expect(logs.logs[0]?.seq).toBe(2);
  });

  it("pages the audit log", async () => {
    const events = await get<{ events: Array<{ type: string }> }>("/api/events?limit=5");
    expect(events.events.length).toBeGreaterThan(0);
    const outcomes = await get<{ events: Array<{ type: string }> }>("/api/events?type=outcome.recorded");
    expect(outcomes.events.every((event) => event.type === "outcome.recorded")).toBe(true);
  });

  it("reports health with secret names but never their values", async () => {
    const response = await http(port, "/api/health", { headers: bearer() });
    expect(response.status).toBe(200);
    expect(response.text).not.toContain(SECRET_VALUE);
    const health = response.json<{
      checks: Array<{ id: string; ok: boolean }>;
      secrets: { file: boolean; inFile: string[] };
      imap: { configured: boolean };
      database: { counts: Record<string, number> };
      config: { campaign: { name: string } };
    }>();
    expect(health.secrets).toMatchObject({ file: true, inFile: ["AUTOAPPLY_TEST_SECRET"] });
    expect(health.checks.find((check) => check.id === "campaign")?.ok).toBe(true);
    expect(health.imap.configured).toBe(false);
    expect(health.database.counts.jobs).toBe(3);
    expect(health.config.campaign.name).toBe("dashboard-test-campaign");
  });
});
