import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getWorkspace, resetWorkspaceCache } from "../src/config/load.js";
import { createServer } from "../src/server.js";
import { chromiumAvailable, docJob, exampleResumeJson, removeAllScratch, scratchDir, seedApplication } from "./documents.fixtures.js";

/** The documents tools and prompt, end to end over MCP. */

const available = await chromiumAvailable();
let client: Client;
let applicationId: string;
const ENV_KEYS = ["AUTOAPPLY_HOME", "AUTOAPPLY_PROFILE", "AUTOAPPLY_CAMPAIGN", "AUTOAPPLY_COMPANIES", "AUTOAPPLY_DB", "AUTOAPPLY_RESUME_SOURCE", "AUTOAPPLY_FONTS", "AUTOAPPLY_DOCUMENTS"];
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

const profile = {
  version: 1,
  identity: { fullName: "Alex Candidate", email: "alex@example.com", phone: "555-0100", location: { city: "Toronto", country: "Canada" } },
  workAuthorization: { citizenships: ["Canada"], authorizedIn: ["CA"], statement: "Canadian citizen." },
  compensation: { currency: "USD", targetTotal: 250000, minimumTotal: 180000 },
  resumes: [{ id: "platform", label: "Platform", path: "variants/platform.pdf", tracks: ["platform"], isDefault: true }],
  skills: [{ name: "Kubernetes", aliases: ["k8s"] }],
  facts: [{ id: "scaling", statement: "Scaled a payments API from 2k to 40k requests per second by redesigning its caching layer.", tags: ["distributed systems"] }],
};

const campaign = {
  version: 1,
  name: "documents-tools",
  tracks: [{ id: "platform", label: "Platform", allocation: 1, titleIncludes: ["platform engineer"], resumeId: "platform" }],
  locations: { allow: ["canada"] },
  compensation: { currency: "USD", floors: { CA: 100000 }, fx: { USD: 1 } },
};

async function call(name: string, args: Record<string, unknown>) {
  const result = await client.callTool({ name, arguments: args });
  const text = ((result.content as Array<{ text: string }>) ?? []).map((entry) => entry.text).join("\n");
  return { isError: result.isError === true, text };
}

beforeAll(async () => {
  const home = scratchDir("tools");
  writeFileSync(join(home, "profile.json"), JSON.stringify(profile));
  writeFileSync(join(home, "campaign.json"), JSON.stringify(campaign));
  writeFileSync(join(home, "companies.json"), JSON.stringify({ version: 1, companies: [] }));
  writeFileSync(join(home, "resume.json"), JSON.stringify(exampleResumeJson()));
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.AUTOAPPLY_HOME = home;
  process.env.AUTOAPPLY_LOG_LEVEL = "error";
  resetWorkspaceCache();
  applicationId = seedApplication(getWorkspace(), docJob()).id;

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "documents-test", version: "1.0.0" });
  await Promise.all([client.connect(clientTransport), createServer().connect(serverTransport)]);
});

afterAll(async () => {
  await client.close();
  resetWorkspaceCache();
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  removeAllScratch();
});

describe("documents tools", () => {
  it("registers the tools and the guided prompt", async () => {
    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(["tailor_resume", "cover_letter_scaffold", "save_cover_letter", "render_resume_variant", "document_status"]));
    const prompts = (await client.listPrompts()).prompts.map((prompt) => prompt.name);
    expect(prompts).toContain("tailor_application_documents");
  });

  it("walks the agent through tailoring, the letter and the preview", async () => {
    const prompt = await client.getPrompt({ name: "tailor_application_documents", arguments: { applicationId: "app_123" } });
    const text = (prompt.messages[0]?.content as { text: string }).text;
    for (const step of ["tailor_resume", "cover_letter_scaffold", "save_cover_letter", "preview_application", "fact_check_failed", '"app_123"']) {
      expect(text).toContain(step);
    }
    expect(text).toContain("Never invent experience");
  });

  it("returns a scaffold and the document status", async () => {
    const scaffold = JSON.parse((await call("cover_letter_scaffold", { applicationId })).text) as { company: string; requirements: unknown[] };
    expect(scaffold.company).toBe("Acme Freight");
    expect(scaffold.requirements.length).toBeGreaterThan(0);
    const status = JSON.parse((await call("document_status", { applicationId })).text) as { resumeSource: { present: boolean }; resume: { tailored: boolean } };
    expect(status.resumeSource.present).toBe(true);
    expect(status.resume.tailored).toBe(false);
  });

  it("returns fact_check_failed for an unsupported letter", async () => {
    const result = await call("save_cover_letter", { applicationId, text: "I spent 9 years writing Haskell at Globex." });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("[fact_check_failed]");
  });

  it.skipIf(!available)("tailors the resume through the tool", async () => {
    const result = await call("tailor_resume", { applicationId });
    expect(result.isError).toBe(false);
    const body = JSON.parse(result.text) as { path: string; pages: number; changes: unknown[] };
    expect(body.pages).toBe(1);
    expect(body.path).toContain(applicationId);
    const status = JSON.parse((await call("document_status", { applicationId })).text) as { resume: { tailored: boolean } };
    expect(status.resume.tailored).toBe(true);
  }, 60_000);

  it.skipIf(!available)("rebuilds a fixed variant through the tool", async () => {
    const result = await call("render_resume_variant", { resumeId: "platform" });
    expect(result.isError).toBe(false);
    expect(JSON.parse(result.text)).toMatchObject({ resumeId: "platform", pages: 1, variantFound: true });
  }, 60_000);
});
