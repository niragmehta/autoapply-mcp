import { afterEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { openDatabase, type Db } from "../src/db/database.js";
import { getRun, insertRun, listRunLogs, markRunStarted } from "../src/db/repositories/runs.js";
import { RunQueue } from "../src/runner/queue.js";
import type { RunEvent, TaskContext } from "../src/runner/types.js";

/** Run queue lifecycle: start, finish, fail, cancel, recover and shut down. */

const queues: RunQueue[] = [];

function makeQueue(db: Db, overrides: Partial<ConstructorParameters<typeof RunQueue>[0]> = {}): RunQueue {
  const queue = new RunQueue({
    db,
    workspace: () => {
      throw new Error("these tasks never read the workspace");
    },
    ...overrides,
  });
  queues.push(queue);
  return queue;
}

/** A task whose items are released one at a time by the test. */
function gatedTask() {
  const gates: Array<() => void> = [];
  const executor = async (ctx: TaskContext, params: { items: number }) => {
    let done = 0;
    for (let item = 0; item < params.items; item += 1) {
      if (ctx.signal.aborted) break;
      await new Promise<void>((resolve) => gates.push(resolve));
      done += 1;
      ctx.progress(done, params.items);
      ctx.log("info", `item ${item + 1}`);
    }
    return { done };
  };
  const release = async () => {
    while (gates.length === 0) await new Promise((resolve) => setTimeout(resolve, 1));
    gates.shift()?.();
  };
  return { executor, release };
}

afterEach(async () => {
  for (const queue of queues.splice(0)) await queue.shutdown(0);
});

describe("RunQueue lifecycle", () => {
  it("runs a task to success, recording progress, logs and the summary", async () => {
    const db = openDatabase(":memory:");
    const queue = makeQueue(db);
    queue.registerTask("echo", async (ctx, params: { words: string[] }) => {
      params.words.forEach((word, index) => {
        ctx.log("info", `word ${word}`, { index });
        ctx.progress(index + 1, params.words.length);
      });
      return { count: params.words.length };
    }, { params: z.object({ words: z.array(z.string()) }) });

    const events: RunEvent[] = [];
    queue.subscribe("*", (event) => events.push(event));
    const id = queue.enqueue("echo", { words: ["a", "b"] });
    expect(queue.get(id)?.status).toBe("running");

    const run = await queue.wait(id);
    expect(run.status).toBe("succeeded");
    expect(run.summary).toEqual({ count: 2 });
    expect(run.progressDone).toBe(2);
    expect(run.progressTotal).toBe(2);
    expect(run.startedAt).not.toBeNull();
    expect(run.finishedAt).not.toBeNull();

    const logs = listRunLogs(db, id);
    expect(logs.map((line) => line.seq)).toEqual(logs.map((_, index) => index + 1));
    expect(logs.map((line) => line.message)).toContain("word a");
    expect(logs.at(-1)?.message).toBe("Run finished.");
    expect(events.filter((event) => event.kind === "status").map((event) => event.kind === "status" && event.status)).toEqual([
      "queued",
      "running",
      "succeeded",
    ]);
    expect(events.some((event) => event.kind === "progress" && event.done === 2)).toBe(true);
  });

  it("records a thrown error as a failed run", async () => {
    const queue = makeQueue(openDatabase(":memory:"));
    queue.registerTask("boom", async () => {
      throw new Error("board exploded");
    });
    const run = await queue.wait(queue.enqueue("boom"));
    expect(run.status).toBe("failed");
    expect(run.error).toBe("board exploded");
  });

  it("rejects unknown types and invalid params before anything is queued", () => {
    const db = openDatabase(":memory:");
    const queue = makeQueue(db);
    queue.registerTask("strict", async () => ({}), { params: z.object({ limit: z.number().int() }).strict() });
    expect(() => queue.enqueue("nope")).toThrow(/no run type "nope"/);
    expect(() => queue.enqueue("strict", { limit: "ten" })).toThrow(/invalid params for a strict run/);
    expect(queue.list()).toHaveLength(0);
    expect(() => queue.registerTask("strict", async () => ({}))).toThrow(/already registered/);
    expect(() => queue.registerTask("Bad Type", async () => ({}))).toThrow(/must be lowercase/);
  });

  it("runs one run per type at a time and keeps the rest queued in order", async () => {
    const queue = makeQueue(openDatabase(":memory:"));
    const { executor, release } = gatedTask();
    queue.registerTask("gated", executor);
    const first = queue.enqueue("gated", { items: 1 });
    const second = queue.enqueue("gated", { items: 1 });
    expect(queue.get(first)?.status).toBe("running");
    expect(queue.get(second)?.status).toBe("queued");
    await release();
    await queue.wait(first);
    expect(queue.get(second)?.status).toBe("running");
    await release();
    expect((await queue.wait(second)).status).toBe("succeeded");
  });
});

describe("RunQueue cancellation", () => {
  it("cancels a queued run outright", async () => {
    const queue = makeQueue(openDatabase(":memory:"));
    const { executor, release } = gatedTask();
    queue.registerTask("gated", executor);
    const first = queue.enqueue("gated", { items: 1 });
    const second = queue.enqueue("gated", { items: 1 });
    expect(queue.cancel(second)).toEqual({ runId: second, outcome: "cancelled", status: "cancelled" });
    await release();
    await queue.whenIdle();
    expect(queue.get(first)?.status).toBe("succeeded");
    expect(queue.get(second)?.status).toBe("cancelled");
  });

  it("stops a running run between items and keeps its partial summary", async () => {
    const queue = makeQueue(openDatabase(":memory:"));
    const { executor, release } = gatedTask();
    queue.registerTask("gated", executor);
    const id = queue.enqueue("gated", { items: 5 });
    await release();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(queue.cancel(id).outcome).toBe("signalled");
    await release();
    const run = await queue.wait(id);
    expect(run.status).toBe("cancelled");
    expect(run.summary).toEqual({ done: 2 });
    expect(queue.cancel(id).outcome).toBe("already_finished");
  });

  it("aborts ctx.sleep immediately on cancel", async () => {
    const queue = makeQueue(openDatabase(":memory:"));
    queue.registerTask("sleepy", async (ctx) => {
      await ctx.sleep(60_000);
      return { woke: true };
    });
    const id = queue.enqueue("sleepy");
    await new Promise((resolve) => setTimeout(resolve, 5));
    queue.cancel(id);
    const run = await queue.wait(id);
    expect(run.status).toBe("cancelled");
    expect(run.summary).toBeNull();
  });

  it("flags a run hosted by another live process, which stops it at its next heartbeat", async () => {
    const db = openDatabase(":memory:");
    const owner = makeQueue(db, { hostPid: 1111, hostName: "box", heartbeatMs: 10, isPidAlive: () => true });
    const other = makeQueue(db, { hostPid: 2222, hostName: "box", isPidAlive: () => true });
    const { executor, release } = gatedTask();
    owner.registerTask("gated", executor);
    const id = owner.enqueue("gated", { items: 3 });
    owner.start();

    expect(other.cancel(id)).toEqual({ runId: id, outcome: "requested", status: "running" });
    expect(getRun(db, id)?.cancelRequested).toBe(true);
    await new Promise((resolve) => setTimeout(resolve, 40));
    await release();
    expect((await owner.wait(id)).status).toBe("cancelled");
  });
});

describe("RunQueue recovery", () => {
  function foreignRun(db: Db, id: string, pid: number, heartbeatAt: string, host = "box") {
    insertRun(db, { id, type: "gated", params: {}, createdAt: heartbeatAt, hostPid: pid, hostName: host });
    markRunStarted(db, id, heartbeatAt);
  }

  it("marks runs of a dead process interrupted and leaves live ones alone", () => {
    const db = openDatabase(":memory:");
    const now = new Date();
    foreignRun(db, "run_dead", 4001, now.toISOString());
    foreignRun(db, "run_live", 4002, now.toISOString());
    foreignRun(db, "run_stale", 4002, new Date(now.getTime() - 10 * 60_000).toISOString());
    foreignRun(db, "run_elsewhere", 4003, now.toISOString(), "other-box");
    const queue = makeQueue(db, { hostPid: 5000, hostName: "box", isPidAlive: (pid) => pid === 4002 || pid === 4003 });

    const recovered = queue.recover().map((run) => run.id).sort();
    expect(recovered).toEqual(["run_dead", "run_stale"]);
    expect(getRun(db, "run_dead")?.status).toBe("interrupted");
    expect(getRun(db, "run_dead")?.error).toMatch(/stopped before the run finished/);
    expect(getRun(db, "run_live")?.status).toBe("running");
    expect(getRun(db, "run_elsewhere")?.status).toBe("running");
    expect(listRunLogs(db, "run_dead").at(-1)?.message).toMatch(/Marked interrupted/);
  });

  it("cancels a foreign run outright when its host is already gone", () => {
    const db = openDatabase(":memory:");
    foreignRun(db, "run_gone", 4001, new Date().toISOString());
    const queue = makeQueue(db, { hostPid: 5000, hostName: "box", isPidAlive: () => false });
    expect(queue.cancel("run_gone").outcome).toBe("cancelled");
    expect(getRun(db, "run_gone")?.status).toBe("cancelled");
  });

  it("interrupts queued and running runs on shutdown", async () => {
    const db = openDatabase(":memory:");
    const queue = new RunQueue({ db, workspace: () => ({}) as never });
    queue.registerTask("loop", async (ctx) => {
      while (!ctx.signal.aborted) await new Promise((resolve) => setTimeout(resolve, 2));
      return { stopped: true };
    });
    const running = queue.enqueue("loop");
    const waiting = queue.enqueue("loop");
    await new Promise((resolve) => setTimeout(resolve, 5));
    await queue.shutdown(1000);
    expect(getRun(db, running)?.status).toBe("interrupted");
    expect(getRun(db, waiting)?.status).toBe("interrupted");
    expect(() => queue.enqueue("loop")).toThrow(/shutting down/);
  });
});
