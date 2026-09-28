import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { getWorkspace, resetWorkspaceCache } from "../src/config/load.js";
import { saveApplication, countSubmittedSince } from "../src/db/repositories/applications.js";
import { saveEvaluation, upsertJobs } from "../src/db/repositories/jobs.js";
import { startOfDayIso } from "../src/submission/guards.js";
import { runApplicationForm } from "../src/submission/browser.js";
import { fixtureResumePath, makeCampaign, makeJob, makeProfile } from "./factories.js";

vi.mock("../src/submission/browser.js", () => ({
  runApplicationForm: vi.fn(async () => ({
    status: "submitted", reason: "test receipt", filledFields: [], unmatchedRequired: [], unusedAnswers: [],
    screenshotPath: "test-receipt.png", finalUrl: "https://job-boards.greenhouse.io/testcorp/confirmation",
    confirmationText: "Your application was received", captchaDetected: false,
  })),
}));

let home: string;
let client: Client;
const campaign = makeCampaign({
  submission: { mode: "auto", dailyLimit: 20, maxBatchSize: 3, maxPerCompany: 3,
    minDelaySeconds: 0, allowedCompanies: ["Test Corp"] },
});

async function call(name: string, args: Record<string, unknown> = {}) {
  const response = await client.callTool({ name, arguments: args });
  expect(response.isError, JSON.stringify(response.content)).not.toBe(true);
  const content = response.content;
  if (!Array.isArray(content)) throw new Error("Expected MCP text content");
  const text = content.find((item) => item.type === "text");
  if (!text || typeof text.text !== "string") throw new Error("Missing MCP text result");
  return JSON.parse(text.text);
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "autoapply-unlimited-"));
  vi.stubEnv("AUTOAPPLY_HOME", home);
  vi.stubEnv("AUTOAPPLY_MIN_INTERVAL_MS", "0");
  vi.stubEnv("AUTOAPPLY_LOG_LEVEL", "error");
  for (const key of ["AUTOAPPLY_PROFILE", "AUTOAPPLY_CAMPAIGN", "AUTOAPPLY_COMPANIES", "AUTOAPPLY_DB"]) {
    vi.stubEnv(key, undefined);
  }
  writeFileSync(join(home, "profile.json"), JSON.stringify(makeProfile()));
  writeFileSync(join(home, "campaign.json"), JSON.stringify(campaign));
  writeFileSync(join(home, "companies.json"), JSON.stringify({ version: 1, companies: [] }));
  resetWorkspaceCache();
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    questions: [
      { label: "First Name", required: true, fields: [{ name: "first_name", type: "input_text" }] },
      { label: "Email", required: true, fields: [{ name: "email", type: "input_text" }] },
    ],
    compliance: [],
  }), { headers: { "content-type": "application/json" } })));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "unlimited-batch-test", version: "1.0.0" });
  await Promise.all([client.connect(clientTransport), createServer().connect(serverTransport)]);
});

afterAll(async () => {
  await client?.close();
  resetWorkspaceCache();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

it("submits after 100 daily submissions without bypassing per-run or per-company limits", async () => {
  writeFileSync(join(home, "campaign.json"), JSON.stringify({
    ...campaign, submission: { ...campaign.submission, dailyLimit: null },
  }));
  await call("reload_config");
  expect((await call("campaign_status")).dailyLimit).toBeNull();
  const { db, paths } = getWorkspace();
  expect(paths.home).toBe(home);
  const now = new Date().toISOString();
  const history = Array.from({ length: 101 }, (_, index) => makeJob({
    id: `history_${index}`, fingerprint: `history_${index}`, companyName: "Previous Employer",
  }));
  upsertJobs(db, history);
  for (const job of history) {
    saveApplication(db, {
      id: `prior_${job.id}`, jobId: job.id, status: "submitted", resumeId: "ai-security",
      resumePath: fixtureResumePath(), packetHash: "historical", coverLetter: "", answers: [],
      blockedQuestions: [], createdAt: now, approvedAt: now, submittedAt: now,
      submissionMode: "auto", confirmationRef: "historical test receipt", artifactPath: null, notes: "",
    });
  }
  const jobs = Array.from({ length: 4 }, (_, index) => makeJob({
    id: `new_${index}`, fingerprint: `new_${index}`, title: `Senior Security Engineer ${index}`,
    externalId: String(index + 10), applyUrl: `https://job-boards.greenhouse.io/testcorp/jobs/${index + 10}`,
  }));
  upsertJobs(db, jobs);
  for (const job of jobs) {
    saveEvaluation(db, { jobId: job.id, decision: "accept", gate: { passed: true, rule: null, reason: "", evidence: "" },
      trackId: "ai-security", score: 90, tier: "A", components: [], flags: [], evaluatedAt: now });
  }
  const prepared = await call("prepare_batch", { tiers: ["A"], limit: 100 });
  expect(prepared.selected).toBe(3);
  const preview = await call("preview_batch", { batchId: prepared.batchId });
  await call("approve_batch", { batchId: prepared.batchId, manifestHash: preview.manifestHash, expectedCount: 3 });
  const first = await call("submit_batch", { batchId: prepared.batchId, mode: "auto", maxSubmissions: 1 });
  expect(first.submitted).toBe(1);
  expect(first.remaining).toBe(2);
  const rest = await call("submit_batch", { batchId: prepared.batchId, mode: "auto", maxSubmissions: 100 });
  expect(rest.submitted).toBe(2);
  expect(rest.remaining).toBe(0);
  expect(vi.mocked(runApplicationForm)).toHaveBeenCalledTimes(3);
  expect(countSubmittedSince(db, startOfDayIso())).toBe(104);
  const overCompanyCap = await client.callTool({ name: "prepare_batch", arguments: { tiers: ["A"], limit: 100 } });
  expect(overCompanyCap.isError).toBe(true);
});

it("keeps unanswered required questions outside approval even when the daily ceiling is disabled", async () => {
  writeFileSync(join(home, "campaign.json"), JSON.stringify({
    ...campaign, submission: { ...campaign.submission, dailyLimit: null },
  }));
  await call("reload_config");
  const { db } = getWorkspace();
  const callsBefore = vi.mocked(runApplicationForm).mock.calls.length;
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    questions: [
      { label: "Explain your incident-response experience.", required: true, fields: [{ name: "experience", type: "input_text" }] },
      { label: "What is your expected salary?", required: true, fields: [{ name: "salary", type: "input_text" }] },
    ],
    compliance: [],
  }), { headers: { "content-type": "application/json" } })));
  const jobs = Array.from({ length: 2 }, (_, index) => makeJob({
    id: `review_${index}`, fingerprint: `review_${index}`, companyName: "Review Corp",
    title: `Senior Security Engineer Review ${index}`,
  }));
  upsertJobs(db, jobs);
  for (const job of jobs) {
    saveEvaluation(db, { jobId: job.id, decision: "accept", gate: { passed: true, rule: null, reason: "", evidence: "" },
      trackId: "ai-security", score: 90, tier: "A", components: [], flags: [], evaluatedAt: new Date().toISOString() });
  }
  const prepared = await call("prepare_batch", { companies: ["Review Corp"], tiers: ["A"] });
  expect(prepared.readyToApprove).toBe(0);
  expect(prepared.needsHuman).toBe(2);
  expect(prepared.recurringQuestions).toHaveLength(2);
  expect(prepared.recurringQuestions[0].count).toBe(2);
  const preview = await call("preview_batch", { batchId: prepared.batchId, includeReady: false });
  expect(preview.applications).toHaveLength(2);
  expect(preview.applications[0].outstanding).toHaveLength(2);
  const approval = await client.callTool({ name: "approve_batch", arguments: {
    batchId: prepared.batchId, manifestHash: preview.manifestHash, expectedCount: 1,
  } });
  expect(approval.isError).toBe(true);
  expect(vi.mocked(runApplicationForm).mock.calls.length).toBe(callsBefore);
});
