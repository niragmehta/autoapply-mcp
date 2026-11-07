import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { TOOLSET_NAMES, parseToolsets } from "../src/toolsets.js";

afterEach(() => {
  vi.unstubAllEnvs();
});

async function listed(server: ReturnType<typeof createServer>) {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "toolsets-test", version: "1.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  const tools = (await client.listTools()).tools.map((tool) => tool.name);
  const prompts = (await client.listPrompts()).prompts.map((prompt) => prompt.name);
  const instructions = client.getInstructions() ?? "";
  await client.close();
  return { tools, prompts, instructions };
}

describe("choosing toolsets", () => {
  it("enables every toolset when nothing is configured", () => {
    expect(parseToolsets(undefined)).toEqual([...TOOLSET_NAMES]);
    expect(parseToolsets("")).toEqual([...TOOLSET_NAMES]);
    expect(parseToolsets(" all ")).toEqual([...TOOLSET_NAMES]);
  });

  it("always keeps core, ignores case, spacing and repeats, and keeps a stable order", () => {
    expect(parseToolsets("Career, followup ,career")).toEqual(["core", "followup", "career"]);
    expect(parseToolsets("core")).toEqual(["core"]);
  });

  it("fails fast on an unknown toolset, naming the valid ones", () => {
    expect(() => parseToolsets("core,inbox")).toThrow(/unknown toolset "inbox".*screening/);
  });
});

describe("a server limited to some toolsets", () => {
  it("registers only the core workflow, its guide prompt and matching instructions", async () => {
    const { tools, prompts, instructions } = await listed(createServer({ toolsets: ["core"] }));

    expect(tools).toContain("discover_jobs");
    expect(tools).toContain("submit_batch");
    expect(tools).not.toContain("check_liveness");
    expect(tools).not.toContain("save_story");
    expect(tools).toHaveLength(22);
    expect(prompts).toEqual(["autoapply_guide"]);
    expect(instructions).toContain("Enabled toolsets: core.");
    expect(instructions).not.toContain("tailor_resume");
  });

  it("reads AUTOAPPLY_TOOLSETS when no list is passed", async () => {
    vi.stubEnv("AUTOAPPLY_TOOLSETS", "core,career");
    const { tools, prompts } = await listed(createServer());

    expect(tools).toContain("save_story");
    expect(tools).not.toContain("scan_inbox");
    expect(prompts).toContain("autoapply_guide");
    expect(prompts.length).toBeGreaterThan(1);
  });
});
