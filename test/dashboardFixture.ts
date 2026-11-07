import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getWorkspace, resetWorkspaceCache } from "../src/config/load.js";
import { openDatabase } from "../src/db/database.js";
import { saveApplication } from "../src/db/repositories/applications.js";
import { saveEvaluation, upsertJobs } from "../src/db/repositories/jobs.js";
import type { DraftAnswer } from "../src/domain/job.js";
import { startDashboard, type DashboardHandle } from "../src/dashboard/server.js";
import { RunQueue } from "../src/runner/queue.js";
import { registerBuiltinTasks } from "../src/runner/tasks/index.js";
import { invalidateWorkspace } from "../src/runner/workspace.js";
import { seedFeatureData } from "./dashboardFeatureSeed.js";
import { fixtureResumePath, makeJob } from "./factories.js";

/** A temporary AUTOAPPLY_HOME with synthetic data, and a dashboard serving it on an ephemeral port. */

export const TOKEN = "test-token-0123456789abcdefghijklmnop";
export const SECRET_VALUE = "hunter2-should-never-appear";

const profile = {
  version: 1,
  identity: {
    fullName: "Alex Candidate",
    headline: "Security Software Engineer",
    email: "alex@example.com",
    phone: "555-0100",
    location: { city: "Vancouver", region: "BC", country: "Canada" },
    links: { linkedin: "https://linkedin.com/in/alex" },
  },
  workAuthorization: {
    citizenships: ["Canada"],
    authorizedIn: ["CA"],
    requiresSponsorshipIn: ["US"],
    statement: "Canadian citizen; US roles require employer support for work authorization.",
    alwaysReviewManually: true,
  },
  compensation: { currency: "USD", targetTotal: 300000, minimumTotal: 200000, disclosurePolicy: "decline" },
  resumes: [{ id: "ai-security", label: "AI Security", path: fixtureResumePath(), tracks: ["ai-security"], isDefault: true }],
  skills: [{ name: "Python", level: "strong", tags: ["language"] }],
  facts: [{ id: "guardrails", statement: "Built an AI guardrail framework.", tags: ["ai security"] }],
  answers: [],
};

const campaign = {
  version: 1,
  name: "dashboard-test-campaign",
  tracks: [{ id: "ai-security", label: "AI Security", allocation: 1, titleIncludes: ["security engineer"], resumeId: "ai-security" }],
  locations: { allow: ["bay-area", "canada"] },
  compensation: { currency: "USD", floors: { US: 200000 } },
  submission: { mode: "auto", dailyLimit: 20, minDelaySeconds: 0, allowedCompanies: ["Acme"] },
  runner: { roundCap: { max: 2, since: "2020-01-01T00:00:00Z" } },
  // Liveness checks fetch the posting; tests never touch the network.
  hygiene: { liveness: { beforePrepare: false, beforeSubmit: false } },
};

const companies = {
  version: 1,
  companies: [
    { name: "Acme", ats: "greenhouse", board: "acme", tier: "A" },
    { name: "Globex", ats: "lever", board: "globex", tier: "B" },
  ],
};

function answer(overrides: Partial<DraftAnswer>): DraftAnswer {
  return {
    questionKey: "q",
    label: "Question",
    answer: "",
    source: "profile",
    citation: "",
    requiresHuman: false,
    required: true,
    category: "general",
    guidance: "",
    ...overrides,
  };
}

export type Fixture = {
  home: string;
  dashboard: DashboardHandle;
  queue: RunQueue;
  port: number;
  close(): Promise<void>;
};

function seed(): void {
  const { db } = getWorkspace();
  const now = new Date().toISOString();
  const jobs = [
    makeJob({ id: "job_acme", fingerprint: "fp_acme", externalId: "1", companyName: "Acme", title: "Senior Security Engineer" }),
    makeJob({ id: "job_globex", fingerprint: "fp_globex", externalId: "2", companyName: "Globex", title: "Staff Security Engineer", ats: "lever" }),
    makeJob({ id: "job_reject", fingerprint: "fp_reject", externalId: "3", companyName: "Acme", title: "Security Engineering Intern" }),
  ];
  upsertJobs(db, jobs);
  const evaluate = (jobId: string, decision: "accept" | "reject", score: number, tier: "A" | "B" | "none") =>
    saveEvaluation(db, {
      jobId,
      decision,
      gate: { passed: decision === "accept", rule: decision === "accept" ? null : "seniority", reason: decision === "accept" ? "" : "intern role", evidence: "" },
      trackId: "ai-security",
      score,
      tier,
      components: [{ dimension: "roleAlignment", weight: 25, earned: 20, rationale: "title matches the track", evidence: [] }],
      flags: [],
      evaluatedAt: now,
    });
  evaluate("job_acme", "accept", 88, "A");
  evaluate("job_globex", "accept", 77, "B");
  evaluate("job_reject", "reject", 10, "none");
  const base = {
    resumeId: "ai-security",
    resumePath: fixtureResumePath(),
    packetHash: "",
    coverLetter: "",
    blockedQuestions: [],
    createdAt: now,
    approvedAt: null,
    submittedAt: null,
    submissionMode: null,
    confirmationRef: null,
    artifactPath: null,
    notes: "",
  };
  saveApplication(db, {
    ...base,
    id: "app_held",
    jobId: "job_globex",
    status: "needs_human",
    answers: [
      answer({ questionKey: "email", label: "Email", answer: "alex@example.com" }),
      answer({ questionKey: "sponsor", label: "Will you require visa sponsorship?", requiresHuman: true, category: "sponsorship", guidance: "Answer from your own situation." }),
    ],
  });
  saveApplication(db, {
    ...base,
    id: "app_sent",
    jobId: "job_acme",
    status: "submitted",
    submittedAt: now,
    submissionMode: "auto",
    answers: [answer({ questionKey: "email", label: "Email", answer: "alex@example.com" })],
  });
}

export type FixtureOptions = {
  /** Also seed the after-applying features (see dashboardFeatureSeed.ts). */
  features?: boolean;
  /** Top-level campaign.json keys to replace. */
  campaign?: Record<string, unknown>;
};

export async function startFixture(prefix: string, options: FixtureOptions = {}): Promise<Fixture> {
  const home = mkdtempSync(join(tmpdir(), `autoapply-${prefix}-`));
  writeFileSync(join(home, "profile.json"), JSON.stringify(profile));
  writeFileSync(join(home, "campaign.json"), JSON.stringify({ ...campaign, ...(options.campaign ?? {}) }));
  writeFileSync(join(home, "companies.json"), JSON.stringify(companies));
  writeFileSync(join(home, ".env"), `AUTOAPPLY_TEST_SECRET=${SECRET_VALUE}\n`);
  mkdirSync(join(home, "artifacts"), { recursive: true });
  writeFileSync(join(home, "artifacts", "app_held-captcha-1730000000000.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));

  process.env.AUTOAPPLY_HOME = home;
  process.env.AUTOAPPLY_MIN_INTERVAL_MS = "0";
  process.env.AUTOAPPLY_LOG_LEVEL = "error";
  for (const key of [
    "AUTOAPPLY_PROFILE",
    "AUTOAPPLY_CAMPAIGN",
    "AUTOAPPLY_COMPANIES",
    "AUTOAPPLY_DB",
    "AUTOAPPLY_ARTIFACTS",
    "AUTOAPPLY_SECRETS",
    "AUTOAPPLY_DASHBOARD_TOKEN",
    "AUTOAPPLY_RESUME_SOURCE",
    "AUTOAPPLY_FONTS",
    "AUTOAPPLY_DOCUMENTS",
    "AUTOAPPLY_REPORTS",
    "AUTOAPPLY_EXPORTS",
  ]) {
    delete process.env[key];
  }
  resetWorkspaceCache();
  invalidateWorkspace();
  seed();
  if (options.features) seedFeatureData();

  const queue = new RunQueue({ db: openDatabase(getWorkspace().paths.database), sleep: async () => {} });
  registerBuiltinTasks(queue);
  queue.registerTask("echo", async (ctx, params: { lines?: number; holdMs?: number }) => {
    for (let line = 1; line <= (params.lines ?? 3); line += 1) {
      ctx.log("info", `line ${line}`, { line });
      ctx.progress(line, params.lines ?? 3);
      await new Promise((resolve) => setTimeout(resolve, params.holdMs ?? 5));
    }
    return { lines: params.lines ?? 3 };
  });
  const dashboard = await startDashboard({ port: 0, token: TOKEN, queue });
  return {
    home,
    dashboard,
    queue,
    port: dashboard.port,
    close: async () => {
      await dashboard.close();
      await queue.shutdown(0);
      queue.db.close();
      resetWorkspaceCache();
      invalidateWorkspace();
      rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    },
  };
}

export type HttpResult = { status: number; headers: IncomingHttpHeaders; text: string; json: <T = Record<string, unknown>>() => T };

/** Raw HTTP, so tests control Host, Origin and the exact request path. */
export function http(
  port: number,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: string | Buffer } = {},
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        path,
        method: options.method ?? "GET",
        headers: {
          host: `127.0.0.1:${port}`,
          ...(options.body !== undefined ? { "content-length": String(Buffer.byteLength(options.body)) } : {}),
          ...(options.headers ?? {}),
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text, json: <T,>() => JSON.parse(text) as T });
        });
      },
    );
    req.on("error", reject);
    if (options.body !== undefined) req.write(options.body);
    req.end();
  });
}

export function bearer(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${TOKEN}`, ...extra };
}

export function jsonBody(port: number, value: unknown, extra: Record<string, string> = {}) {
  return {
    headers: bearer({ "content-type": "application/json", origin: `http://127.0.0.1:${port}`, ...extra }),
    body: JSON.stringify(value),
  };
}
