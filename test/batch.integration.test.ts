import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { resetWorkspaceCache } from "../src/config/load.js";
import { fixtureResumePath } from "./factories.js";

/** End-to-end batch flow: prepare many, review, approve as a set, submit. */

let home: string;
let client: Client;

const profile = {
  version: 1,
  identity: {
    fullName: "Alex Candidate",
    email: "alex@example.com",
    phone: "555-0100",
    location: { city: "Vancouver", region: "BC", country: "Canada" },
    links: {},
  },
  personal: {
    legalAgeConfirmation: { value: "Yes", autoFill: true },
    demographics: {
      gender: { value: "Decline to self-identify", autoFill: true },
      raceEthnicity: { value: "Decline to self-identify", autoFill: true },
      veteranStatus: { value: "I am not a protected veteran", autoFill: true },
      disabilityStatus: { value: "I do not wish to answer", autoFill: true },
    },
  },
  workAuthorization: {
    citizenships: ["Canada"],
    authorizedIn: ["CA"],
    requiresSponsorshipIn: ["US"],
    statement: "Canadian citizen; US roles require employer support for work authorization.",
    alwaysReviewManually: true,
  },
  compensation: { currency: "USD", targetTotal: 300000, minimumTotal: 200000, disclosurePolicy: "decline" },
  resumes: [{ id: "sec", label: "Security", path: fixtureResumePath(), tracks: ["sec"], isDefault: true }],
  skills: [{ name: "Python", level: "strong", tags: [] }],
  facts: [{ id: "f1", statement: "Built security guardrails with policy engines.", tags: ["security", "policy"] }],
  answers: [
    { key: "source", label: "How did you hear about us?", patterns: ["how did you hear"], answer: "Careers page", allowAutoFill: true },
  ],
};

const campaign = {
  version: 1,
  name: "batch-campaign",
  targetApplications: 100,
  tracks: [
    {
      id: "sec",
      label: "Security",
      allocation: 1,
      titleIncludes: ["security engineer"],
      keywords: [
        { term: "security", weight: 3 },
        { term: "policy", weight: 2 },
        { term: "python", weight: 1 },
      ],
      resumeId: "sec",
    },
  ],
  locations: { allow: ["bay-area"], workplaceTypes: ["onsite", "hybrid", "remote", "unknown"] },
  compensation: { currency: "USD", floors: { US: 200000 }, fx: { USD: 1 }, allowUnknown: true, rejectBelowFloor: true },
  scoring: { thresholds: { tierA: 80, tierB: 70, tierC: 60 } },
  submission: { mode: "manual", dailyLimit: 20, minDelaySeconds: 0 },
};

const companies = { version: 1, companies: [{ name: "Acme", ats: "greenhouse", board: "acme", tier: "A" }] };

function makeJob(id: number, title: string, payMax: number) {
  return {
    id,
    title,
    first_published: new Date().toISOString(),
    absolute_url: `https://job-boards.greenhouse.io/acme/jobs/${id}`,
    content: "Build security tooling with policy enforcement in Python.",
    location: { name: "San Francisco, CA" },
    pay_input_ranges: [{ min_cents: 20000000, max_cents: payMax, currency_type: "USD", title: "SF" }],
  };
}

// Distinct roles: identical titles would share a role fingerprint and be
// de-duplicated, which is correct behaviour but not what this test exercises.
const listPayload = {
  jobs: [
    makeJob(1, "Senior Security Engineer, Detection", 30000000),
    makeJob(2, "Senior Security Engineer, Platform", 28000000),
    makeJob(3, "Senior Security Engineer, Identity", 21000000),
  ],
};

const detailPayload = {
  questions: [
    { label: "First Name", required: true, fields: [{ name: "first_name", type: "input_text" }] },
    { label: "Email", required: true, fields: [{ name: "email", type: "input_text" }] },
    { label: "How did you hear about us?", required: false, fields: [{ name: "hear", type: "input_text" }] },
    { label: "Please select your gender", required: false, fields: [{ name: "gender", type: "multi_value_single_select" }] },
    { label: "Are you a protected veteran?", required: false, fields: [{ name: "veteran", type: "multi_value_single_select" }] },
  ],
  compliance: [],
};

function stubFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL) => {
      const href = typeof url === "string" ? url : url.toString();
      const body = /\/jobs\/\d+/.test(href) ? detailPayload : listPayload;
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
}

async function callTool(name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const content = (result.content as Array<{ type: string; text: string }>) ?? [];
  return { isError: result.isError === true, text: content.map((entry) => entry.text).join("\n") };
}

const parse = (text: string) => JSON.parse(text) as Record<string, any>;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "autoapply-batch-"));
  writeFileSync(join(home, "profile.json"), JSON.stringify(profile));
  writeFileSync(join(home, "campaign.json"), JSON.stringify(campaign));
  writeFileSync(join(home, "companies.json"), JSON.stringify(companies));

  process.env.AUTOAPPLY_HOME = home;
  process.env.AUTOAPPLY_MIN_INTERVAL_MS = "0";
  process.env.AUTOAPPLY_LOG_LEVEL = "error";
  for (const key of ["AUTOAPPLY_PROFILE", "AUTOAPPLY_CAMPAIGN", "AUTOAPPLY_COMPANIES", "AUTOAPPLY_DB"]) {
    delete process.env[key];
  }
  resetWorkspaceCache();

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "batch-test", version: "1.0.0" });
  await Promise.all([client.connect(clientTransport), createServer().connect(serverTransport)]);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

afterAll(() => {
  resetWorkspaceCache();
  rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

describe("batch workflow", () => {
  it("registers the batch tools", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((tool) => tool.name);
    for (const expected of ["prepare_batch", "preview_batch", "approve_batch", "submit_batch", "list_batches"]) {
      expect(names).toContain(expected);
    }
  });

  it("prepares, approves and submits a batch end to end", async () => {
    stubFetch();
    await callTool("discover_jobs");

    // The compensation filter must exclude the lower-paid posting.
    const prepared = parse((await callTool("prepare_batch", { tiers: ["A", "B"], minCompensation: 250000 })).text);
    expect(prepared.selected).toBe(2);
    expect(prepared.readyToApprove).toBe(2);
    expect(prepared.needsHuman).toBe(0);
    expect(prepared.autoFilledPersonalFields).toContain("personal.demographics.gender");

    const batchId = String(prepared.batchId);
    const preview = parse((await callTool("preview_batch", { batchId })).text);
    expect(preview.applications).toHaveLength(2);
    expect(preview.manifestStale).toBe(false);
    const manifestHash = String(preview.manifestHash);

    // A wrong count must not be accepted, even with the right hash.
    const wrongCount = await callTool("approve_batch", { batchId, manifestHash, expectedCount: 99 });
    expect(wrongCount.isError).toBe(true);
    expect(wrongCount.text).toContain("count_mismatch");

    // A stale manifest must not be accepted either.
    const wrongHash = await callTool("approve_batch", { batchId, manifestHash: "0".repeat(64), expectedCount: 2 });
    expect(wrongHash.isError).toBe(true);
    expect(wrongHash.text).toContain("manifest_mismatch");

    const approved = parse((await callTool("approve_batch", { batchId, manifestHash, expectedCount: 2 })).text);
    expect(approved.approved).toBe(2);

    const submitted = parse((await callTool("submit_batch", { batchId, mode: "manual" })).text);
    expect(submitted.results).toHaveLength(2);
    expect(submitted.manualPackets).toHaveLength(2);
    expect(submitted.manualPackets[0].applyUrl).toContain("job-boards.greenhouse.io");

    const batches = parse((await callTool("list_batches")).text);
    expect(batches.batches[0].batchId).toBe(batchId);
  });

  it("refuses to submit a batch that was never approved", async () => {
    stubFetch();
    // The third posting pays below the earlier filter, so no application exists
    // for it yet and it is still eligible for a fresh batch.
    const prepared = parse((await callTool("prepare_batch", { tiers: ["A", "B"], minCompensation: 205000 })).text);
    expect(prepared.readyToApprove).toBeGreaterThan(0);
    const result = await callTool("submit_batch", { batchId: prepared.batchId, mode: "manual" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("batch_not_approved");
  });

  it("reports an empty selection rather than silently doing nothing", async () => {
    const result = await callTool("prepare_batch", { tiers: ["A"], minCompensation: 99_000_000 });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("empty_selection");
  });
});
