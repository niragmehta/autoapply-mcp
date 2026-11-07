import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { openDatabase } from "../src/db/database.js";
import { setRunQueue } from "../src/runner/index.js";
import { RunQueue } from "../src/runner/queue.js";
import { registerRunTools } from "../src/tools/runs.js";

/** The MCP run tools over a real client, against a queue with one harmless task. */

let client: Client;
let queue: RunQueue;

async function call(name: string, args: Record<string, unknown> = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content as Array<{ text: string }>).map((entry) => entry.text).join("\n");
  return { isError: result.isError === true, text, json: () => JSON.parse(text) as Record<string, any> };
}

beforeAll(async () => {
  queue = new RunQueue({ db: openDatabase(":memory:"), workspace: () => ({}) as never });
  queue.registerTask("echo", async (ctx, params: { lines?: number }) => {
    for (let line = 1; line <= (params.lines ?? 2); line += 1) ctx.log("info", `line ${line}`);
    return { lines: params.lines ?? 2 };
  });
  queue.registerTask("wait", async (ctx) => {
    await ctx.sleep(60_000);
    return {};
  });
  setRunQueue(queue);
  const server = new McpServer({ name: "runs-test", version: "1.0.0" });
  registerRunTools(server);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  client = new Client({ name: "test-client", version: "1.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
});

afterAll(async () => {
  setRunQueue(null);
  await queue.shutdown(0);
});

describe("run tools", () => {
  it("starts a run and reports its status, logs and listing", async () => {
    const started = await call("start_run", { type: "echo", params: { lines: 3 } });
    expect(started.isError).toBe(false);
    const { runId, note } = started.json();
    expect(note).toMatch(/stop when the client session ends/);
    await queue.wait(runId);

    const status = (await call("run_status", { runId, logLines: 2 })).json();
    expect(status.run.status).toBe("succeeded");
    expect(status.run.summary).toEqual({ lines: 3 });
    expect(status.recentLogs.map((line: { message: string }) => line.message)).toEqual(["line 3", "Run finished."]);

    const logs = (await call("run_logs", { runId, afterSeq: 2 })).json();
    expect(logs.logs[0].seq).toBe(3);
    expect(logs.nextAfterSeq).toBe(logs.logs.at(-1).seq);

    const listed = (await call("list_runs", { status: "succeeded" })).json();
    expect(listed.runs.map((run: { runId: string }) => run.runId)).toContain(runId);
  });

  it("cancels a running run and refuses unknown runs and types", async () => {
    const { runId } = (await call("start_run", { type: "wait" })).json();
    expect((await call("cancel_run", { runId })).json()).toMatchObject({ runId, outcome: "signalled" });
    expect((await queue.wait(runId)).status).toBe("cancelled");

    const unknownType = await call("start_run", { type: "teleport" });
    expect(unknownType.isError).toBe(true);
    expect(unknownType.text).toMatch(/unknown_run_type/);
    expect((await call("run_status", { runId: "run_missing" })).text).toMatch(/run_not_found/);
    expect((await call("run_logs", { runId: "run_missing" })).isError).toBe(true);
  });
});
