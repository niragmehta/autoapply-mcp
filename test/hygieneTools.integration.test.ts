import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { resetWorkspaceCache } from "../src/config/load.js";
import { makeCampaign, makeProfile } from "./factories.js";
import { SAMPLE_JD } from "./hygieneFixtures.js";

/** The hygiene and evaluation tools and prompts through a real MCP client. */

let home: string;
let client: Client;
let discoveredJobId = "";

const posting = {
  id: 7001,
  title: "Senior Security Engineer",
  first_published: new Date().toISOString(),
  absolute_url: "https://job-boards.greenhouse.io/acme/jobs/7001",
  content: `${SAMPLE_JD}\nYou will build AI security guardrails with policy enforcement.`.replace(/\n/g, "<br>"),
  location: { name: "San Francisco, CA" },
  pay_input_ranges: [{ min_cents: 24000000, max_cents: 30000000, currency_type: "USD" }],
};

function stubFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL) => {
      const href = typeof url === "string" ? url : url.toString();
      const body = href.includes("/jobs/7001") ? posting : { jobs: [posting] };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }),
  );
}

async function call(name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = ((result.content as Array<{ text: string }>) ?? []).map((entry) => entry.text).join("\n");
  return { isError: result.isError === true, text };
}

const parse = (text: string) => JSON.parse(text) as Record<string, any>;

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "autoapply-eval-"));
  writeFileSync(join(home, "profile.json"), JSON.stringify(makeProfile()));
  writeFileSync(join(home, "campaign.json"), JSON.stringify(makeCampaign()));
  writeFileSync(join(home, "companies.json"), JSON.stringify({ version: 1, companies: [{ name: "Acme", ats: "greenhouse", board: "acme", tier: "A" }] }));
  process.env.AUTOAPPLY_HOME = home;
  process.env.AUTOAPPLY_MIN_INTERVAL_MS = "0";
  process.env.AUTOAPPLY_LOG_LEVEL = "error";
  for (const key of ["AUTOAPPLY_PROFILE", "AUTOAPPLY_CAMPAIGN", "AUTOAPPLY_COMPANIES", "AUTOAPPLY_DB", "AUTOAPPLY_REPORTS"]) delete process.env[key];
  resetWorkspaceCache();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "evaluation-test", version: "1.0.0" });
  await Promise.all([client.connect(clientTransport), createServer().connect(serverTransport)]);
});

afterEach(() => vi.unstubAllGlobals());

afterAll(() => {
  resetWorkspaceCache();
  rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

describe("hygiene and evaluation tools", () => {
  it("registers the tools and prompts", async () => {
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    for (const name of [
      "check_liveness", "find_reposts", "posting_legitimacy", "blacklist_company", "list_blacklist",
      "evaluate_job", "evaluate_posting", "save_evaluation_report", "get_evaluation_report", "list_evaluation_reports",
    ]) {
      expect(names).toContain(name);
    }
    const prompts = (await client.listPrompts()).prompts.map((prompt) => prompt.name);
    expect(prompts).toEqual(expect.arrayContaining(["evaluate_job", "triage_queue"]));
    const prompt = await client.getPrompt({ name: "evaluate_job", arguments: { jobId: "job_123" } });
    const text = (prompt.messages[0]?.content as { text: string }).text;
    expect(text).toContain('evaluate_job {"jobId":"job_123"}');
    expect(text).toContain("4.5 or more");
    const triage = await client.getPrompt({ name: "triage_queue", arguments: { limit: "5" } });
    expect((triage.messages[0]?.content as { text: string }).text).toContain('list_queue {"limit": 5}');
  });

  it("checks liveness, assesses legitimacy, evaluates and saves a report", async () => {
    stubFetch();
    await call("discover_jobs");
    const queue = parse((await call("list_queue", { minScore: 0 })).text);
    const jobId = String(queue.jobs[0].jobId);
    discoveredJobId = jobId;

    const liveness = parse((await call("check_liveness", {})).text);
    expect(liveness).toMatchObject({ checked: 1, open: 1 });
    expect(liveness.verdicts[0]).toMatchObject({ jobId, status: "open", via: "api" });

    const legitimacy = parse((await call("posting_legitimacy", { jobId })).text);
    expect(legitimacy.tier).toBe("high");
    expect(legitimacy.liveness.status).toBe("open");

    expect(parse((await call("find_reposts")).text).count).toBe(0);

    const evaluated = await call("evaluate_job", { jobId });
    expect(evaluated.isError).toBe(false);
    expect(evaluated.text).toContain("UNTRUSTED THIRD-PARTY CONTENT");
    const scaffold = JSON.parse(evaluated.text.slice(0, evaluated.text.indexOf("\n\n====")))?.scaffold;
    expect(scaffold.requirements.length).toBeGreaterThan(0);

    const saved = await call("save_evaluation_report", {
      jobId,
      summary: "Strong security fit with Kubernetes and cloud gaps to address.",
      verdict: scaffold.scorecard.verdict,
    });
    expect(saved.isError, saved.text).toBe(false);
    const savedReport = parse(saved.text);
    expect(existsSync(savedReport.markdownPath)).toBe(true);

    const report = parse((await call("get_evaluation_report", { jobId })).text);
    expect(report.markdown).toContain("## G) Posting legitimacy");
    expect(report.scaffold).toBeUndefined();
    expect(parse((await call("list_evaluation_reports")).text).count).toBe(1);

    const mismatch = await call("save_evaluation_report", { jobId, summary: "Summary long enough to be valid here.", verdict: "strong-apply", score: 4.9 });
    expect(mismatch.isError).toBe(true);
  });

  it("evaluates pasted text and refuses an empty request", async () => {
    const pasted = await call("evaluate_posting", { text: SAMPLE_JD, company: "Example Robotics", title: "Senior Security Engineer", includeDescription: false });
    expect(parse(pasted.text)).toMatchObject({ source: "pasted-text", ats: "external" });
    const empty = await call("evaluate_posting", {});
    expect(empty.isError).toBe(true);
    expect(empty.text).toContain("missing_argument");
  });

  it("records a do-not-apply decision and removes the company from the queue", async () => {
    stubFetch();
    const added = parse((await call("blacklist_company", { company: "Acme", reason: "declined an offer there" })).text);
    expect(added.added).toHaveLength(1);
    expect(added.reevaluated).toBeGreaterThan(0);
    expect(parse((await call("list_blacklist")).text).entries[0]).toMatchObject({ scope: "company", value: "Acme" });
    expect(parse((await call("list_queue", { minScore: 0 })).text).jobs).toHaveLength(0);
    const explained = parse((await call("explain_job", { jobId: discoveredJobId, includeDescription: false })).text);
    expect(explained.evaluation.gate.rule).toBe("blacklisted");
  });
});
