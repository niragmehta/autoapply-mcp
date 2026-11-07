import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resetWorkspaceCache } from "../src/config/load.js";
import { registerOnboardingPrompts } from "../src/prompts/onboarding.js";
import { registerOnboardingTools } from "../src/tools/onboarding.js";
import { registerSourcingTools } from "../src/tools/sourcing.js";
import { fixtureResumePath } from "./factories.js";

/**
 * The onboarding and sourcing tools through a real MCP client, on a bare
 * server holding only these registrations. Fictional data; no network.
 */

let home: string;
let client: Client;
const saved: Record<string, string | undefined> = {};

const profile = {
  version: 1,
  identity: { fullName: "Alex Candidate", email: "alex@example.com", phone: "555-0100", location: { city: "Vancouver", country: "Canada" } },
  workAuthorization: { citizenships: ["Canada"], authorizedIn: ["CA"], requiresSponsorshipIn: ["US"], statement: "Canadian citizen." },
  compensation: { targetTotal: 250000, minimumTotal: 200000 },
  resumes: [{ id: "general", label: "General", path: fixtureResumePath(), isDefault: true }],
};

const campaign = {
  version: 1,
  name: "tools-campaign",
  tracks: [{ id: "platform", label: "Platform", resumeId: "general", titleIncludes: ["platform engineer"] }],
  locations: { allow: ["canada", "bay-area"] },
  compensation: { floors: { US: 200000, CA: 150000 } },
};

async function call(name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = ((result.content as Array<{ text: string }>) ?? []).map((entry) => entry.text).join("\n");
  return { isError: result.isError === true, text, json: () => JSON.parse(text) as Record<string, any> };
}

beforeAll(async () => {
  home = mkdtempSync(join(tmpdir(), "autoapply-tools-"));
  writeFileSync(join(home, "profile.json"), JSON.stringify(profile, null, 2));
  writeFileSync(join(home, "campaign.json"), JSON.stringify(campaign, null, 2));
  writeFileSync(join(home, "companies.json"), JSON.stringify({ version: 1, companies: [] }));
  for (const key of [
    "AUTOAPPLY_HOME",
    "AUTOAPPLY_PROFILE",
    "AUTOAPPLY_CAMPAIGN",
    "AUTOAPPLY_COMPANIES",
    "AUTOAPPLY_DB",
    "AUTOAPPLY_SECRETS",
    "AUTOAPPLY_LOG_LEVEL",
    // Never let a test reach a real mailbox configured in the developer's shell.
    "AUTOAPPLY_OTP_IMAP_USER",
    "AUTOAPPLY_OTP_IMAP_PASSWORD",
    "AUTOAPPLY_OTP_IMAP_HOST",
  ]) {
    saved[key] = process.env[key];
    delete process.env[key];
  }
  process.env.AUTOAPPLY_HOME = home;
  process.env.AUTOAPPLY_LOG_LEVEL = "error";
  resetWorkspaceCache();

  const server = new McpServer({ name: "test", version: "1.0.0" }, { capabilities: { tools: {}, prompts: {} } });
  registerOnboardingTools(server);
  registerSourcingTools(server);
  registerOnboardingPrompts(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
});

afterAll(async () => {
  await client.close();
  resetWorkspaceCache();
  for (const [key, value] of Object.entries(saved)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

describe("onboarding and sourcing tools", () => {
  it("registers the tools and prompts", async () => {
    const tools = (await client.listTools()).tools.map((tool) => tool.name).sort();
    expect(tools).toEqual([
      "accept_company_proposals",
      "fetch_funded_companies",
      "harvest_status",
      "import_job_alert",
      "import_resume_text",
      "list_leads",
      "profile_status",
      "propose_companies",
      "scan_alert_inbox",
      "set_lead_status",
      "update_campaign",
      "update_profile",
    ]);
    const prompts = (await client.listPrompts()).prompts.map((prompt) => prompt.name).sort();
    expect(prompts).toEqual(["campaign_setup", "onboard"]);
    const onboard = await client.getPrompt({ name: "onboard", arguments: { focus: "work authorization" } });
    const text = (onboard.messages[0]!.content as { text: string }).text;
    expect(text).toContain("profile_status");
    expect(text).toContain("Never assume");
    expect(text).toContain("Start with this section: work authorization.");
  });

  it("reports readiness, then applies a confirmed edit and reloads", async () => {
    const before = (await call("profile_status")).json();
    expect(before.ready).toBe(false);
    expect(before.identity.email).toBe("a***@example.com");
    expect(JSON.stringify(before)).not.toContain("555-0100");

    const edit = await call("update_profile", { ops: [{ op: "set", path: "/identity/fullName", value: "Jordan Rivers" }, { op: "set", path: "/identity/phone", value: "+1 604 555 2368" }] });
    expect(edit.isError).toBe(false);
    expect(edit.json()).toMatchObject({ unchanged: false, reloaded: true, changed: [{ op: "set", path: "/identity/fullName" }, { op: "set", path: "/identity/phone" }] });
    expect(edit.text).not.toContain("555 2368");
    expect(JSON.parse(readFileSync(join(home, "profile.json"), "utf8")).identity.fullName).toBe("Jordan Rivers");

    const after = (await call("profile_status")).json();
    expect(after.placeholders.hits.map((hit: { path: string }) => hit.path)).not.toContain("/identity/fullName");

    const refused = await call("update_profile", { ops: [{ op: "set", path: "/personal/dateOfBirth/value", value: "1990-01-01" }] });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("patch_path_not_allowed");

    const campaignEdit = await call("update_campaign", { ops: [{ op: "set", path: "/freshnessDays", value: 30 }] });
    expect(campaignEdit.json()).toMatchObject({ unchanged: false, reloaded: true });
  });

  it("extracts a resume scaffold without writing anything", async () => {
    const result = await call("import_resume_text", {
      text: "EXPERIENCE\nPlatform Engineer | Initech | Toronto, ON | Jan 2020 - Present\n- Cut deploy time by 50%\n\nSKILLS\nGo, Kubernetes",
    });
    expect(result.json()).toMatchObject({
      experience: [expect.objectContaining({ title: "Platform Engineer", company: "Initech", start: "2020-01", end: "present" })],
      skills: [{ name: "Go" }, { name: "Kubernetes" }],
    });
    expect(result.json().guidance[0]).toContain("Nothing was saved");
  });

  it("imports an alert, lists leads and reports harvesting", async () => {
    const imported = await call("import_job_alert", {
      text: "Senior Platform Engineer\nAcme Robotics\nRemote\nView job: https://www.linkedin.com/comm/jobs/view/4012345678/?trackingId=x",
    });
    expect(imported.json()).toMatchObject({ found: 1, added: 1 });
    const leads = (await call("list_leads", { source: "linkedin-alert" })).json();
    expect(leads.leads).toEqual([expect.objectContaining({ title: "Senior Platform Engineer", company: "Acme Robotics", url: "https://www.linkedin.com/jobs/view/4012345678" })]);
    const status = (await call("harvest_status")).json();
    expect(status.boards).toEqual([]);
    expect(status.nextSteps[0]).toContain("npm run harvest");
    const inbox = await call("scan_alert_inbox", {});
    expect(inbox.isError).toBe(true);
    expect(inbox.text).toContain("inbox_not_configured");
  });
});
