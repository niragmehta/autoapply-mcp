import { request as httpRequest } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FEATURE_IDS } from "./dashboardFeatureSeed.js";
import { bearer, http, startFixture, type Fixture } from "./dashboardFixture.js";

/**
 * App-wide: one search across jobs, companies, applications, contacts,
 * stories and notes, each result a link to the thing itself; and the
 * notifications tray (interviews within 48 hours, offer deadlines within 7
 * days, follow-ups due, finished and failed runs) with a live stream of runs.
 */

let fixture: Fixture;
let port: number;

beforeAll(async () => {
  fixture = await startFixture("dashboard-appwide", { features: true });
  port = fixture.port;
});

afterAll(async () => {
  await fixture.close();
});

type Group = { kind: string; label: string; items: Array<{ id: string; title: string; sub: string; href: string }> };
type Notification = { id: string; kind: string; title: string; detail: string; at: string | null; href: string; tone: string };

const get = async <T,>(path: string) => {
  const response = await http(port, path, { headers: bearer() });
  expect(response.status, `${path}: ${response.text.slice(0, 300)}`).toBe(200);
  return response.json<T>();
};
const search = (q: string) => get<{ q: string; total: number; groups: Group[] }>(`/api/search?q=${encodeURIComponent(q)}`);
const groupOf = (groups: Group[], kind: string) => groups.find((group) => group.kind === kind);

describe("global search", () => {
  it("needs a session", async () => {
    expect((await http(port, "/api/search?q=acme")).status).toBe(401);
  });

  it("refuses an empty or overlong query", async () => {
    expect((await http(port, "/api/search", { headers: bearer() })).status).toBe(400);
    expect((await http(port, "/api/search?q=%20", { headers: bearer() })).status).toBe(400);
    expect((await http(port, `/api/search?q=${"x".repeat(121)}`, { headers: bearer() })).status).toBe(400);
  });

  it("finds applications, companies, contacts and notes by company, each linking to itself", async () => {
    const result = await search("acme");
    const applications = groupOf(result.groups, "applications");
    expect(applications?.items.map((item) => item.href)).toContain("/applications?app=app_sent");
    expect(groupOf(result.groups, "companies")?.items[0]).toMatchObject({ title: "Acme", href: "/companies?q=Acme" });
    expect(groupOf(result.groups, "contacts")?.items[0]?.title).toBe("Jordan Recruiter");
    expect(groupOf(result.groups, "contacts")?.items[0]?.href).toMatch(/^\/contacts\?contact=/);
    expect(groupOf(result.groups, "notes")?.items[0]?.href).toMatch(/^\/research\?company=Acme&note=/);
    expect(result.total).toBe(result.groups.reduce((sum, group) => sum + group.items.length, 0));
  });

  it("finds a posting without an application as a job, and stories by their words", async () => {
    const jobs = groupOf((await search("initech")).groups, "jobs");
    expect(jobs?.items[0]).toMatchObject({ title: "AI Security Engineer", href: `/jobs?job=${FEATURE_IDS.queueJob}` });
    const stories = groupOf((await search("guardrail")).groups, "stories");
    expect(stories?.items[0]?.title).toBe("Shipping a guardrail framework");
    expect(stories?.items[0]?.href).toMatch(/^\/stories\?story=/);
  });

  it("treats LIKE wildcards as plain characters", async () => {
    expect((await search("_")).total).toBe(0);
    expect((await search("%%")).total).toBe(0);
  });
});

describe("notifications", () => {
  it("needs a session and a sensible limit", async () => {
    expect((await http(port, "/api/notifications")).status).toBe(401);
    expect((await http(port, "/api/notifications?limit=0", { headers: bearer() })).status).toBe(400);
  });

  it("lists the interview, the offer deadline, the follow-up due and finished runs, each with a link", async () => {
    const { items } = await get<{ items: Notification[] }>("/api/notifications");
    const byKind = (kind: string) => items.filter((item) => item.kind === kind);
    expect(byKind("interview").map((item) => item.href)).toContain(`/interviews?interview=${FEATURE_IDS.interview}`);
    expect(byKind("offer").map((item) => item.href)).toContain(`/offers?offer=${FEATURE_IDS.offer}`);
    expect(byKind("follow-up").length).toBeGreaterThan(0);
    expect(byKind("follow-up")[0]?.href).toMatch(/^\/follow-ups/);
    expect(byKind("run").map((item) => item.href)).toContain(`/runs?run=${FEATURE_IDS.submitRun}`);
    expect(new Set(items.map((item) => item.id)).size).toBe(items.length);
    for (const item of items) expect(["ok", "bad", "held", "info"]).toContain(item.tone);
  });
});

/** Reads an event stream until `done` says so (or the timeout), then hangs up. */
function readUntil(path: string, done: (text: string) => boolean, timeoutMs = 4000): Promise<{ status: number; type: string; text: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, headers: { host: `127.0.0.1:${port}`, ...bearer() } }, (res) => {
      let text = "";
      const finish = () => {
        clearTimeout(timer);
        req.destroy();
        resolve({ status: res.statusCode ?? 0, type: String(res.headers["content-type"] ?? ""), text });
      };
      const timer = setTimeout(finish, timeoutMs);
      res.on("data", (chunk: Buffer) => {
        text += chunk.toString("utf8");
        if (done(text)) finish();
      });
      res.on("end", finish);
    });
    req.on("error", (error) => (error.message.includes("socket hang up") ? undefined : reject(error)));
    req.end();
  });
}

describe("the notification stream", () => {
  it("needs a session", async () => {
    expect((await http(port, "/api/notifications/stream")).status).toBe(401);
  });

  it("says when any run finishes", async () => {
    const reading = readUntil("/api/notifications/stream", (text) => /"status":"succeeded"/.test(text));
    await new Promise((resolve) => setTimeout(resolve, 100));
    const runId = fixture.queue.enqueue("echo", { lines: 1 });
    const stream = await reading;
    expect(stream.status).toBe(200);
    expect(stream.type).toMatch(/text\/event-stream/);
    const frame = stream.text.split("\n\n").find((block) => block.includes("event: run") && block.includes(runId) && block.includes('"status":"succeeded"'));
    expect(frame).toBeDefined();
    const data = JSON.parse(frame!.split("\n").find((line) => line.startsWith("data: "))!.slice(6)) as Record<string, unknown>;
    expect(data).toMatchObject({ id: runId, type: "echo", status: "succeeded", href: `/runs?run=${runId}` });
  });
});
