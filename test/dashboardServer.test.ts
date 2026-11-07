import { request as httpRequest } from "node:http";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TOKEN, bearer, http, jsonBody, startFixture, type Fixture } from "./dashboardFixture.js";
import { sseFrame } from "../src/dashboard/sse.js";
import { resolveToken, tokensEqual } from "../src/dashboard/security.js";
import { safeRelativePath } from "../src/dashboard/static.js";
import { startDashboard } from "../src/dashboard/server.js";

/** The dashboard's HTTP boundary: authentication, host and origin checks, routing, validation, files and SSE. */

let fixture: Fixture;
let port: number;

beforeAll(async () => {
  fixture = await startFixture("dashboard-server");
  port = fixture.port;
});

afterAll(async () => {
  await fixture.close();
});

describe("authentication", () => {
  it("refuses API calls without a credential and accepts the bearer token", async () => {
    expect((await http(port, "/api/status")).status).toBe(401);
    expect((await http(port, "/api/status", { headers: { authorization: "Bearer wrong-token-wrong-token-wrong" } })).status).toBe(401);
    const ok = await http(port, "/api/status", { headers: bearer() });
    expect(ok.status).toBe(200);
    expect(ok.headers["content-type"]).toMatch(/application\/json/);
    expect(ok.headers["cache-control"]).toBe("no-store");
  });

  it("exchanges the printed token link for an HttpOnly SameSite=Strict cookie and strips it from the URL", async () => {
    const login = await http(port, `/?token=${TOKEN}&from=cli`);
    expect(login.status).toBe(303);
    expect(login.headers.location).toBe("/?from=cli");
    const cookie = String(login.headers["set-cookie"]?.[0] ?? "");
    expect(cookie).toMatch(new RegExp(`^autoapply_dash_${port}=`));
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");

    const withCookie = await http(port, "/api/status", { headers: { cookie: cookie.split(";")[0]! } });
    expect(withCookie.status).toBe(200);
    expect((await http(port, "/api/status", { headers: { cookie: `autoapply_dash_${port}=nope` } })).status).toBe(401);
  });

  it("rejects a wrong token link without setting a cookie", async () => {
    const bad = await http(port, "/?token=not-the-token-at-all-000000");
    expect(bad.status).toBe(401);
    expect(bad.headers["set-cookie"]).toBeUndefined();
    expect(bad.text).toContain("not valid");
  });

  it("generates a random token unless one is configured, and validates configured ones", () => {
    expect(resolveToken(undefined, {})).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(resolveToken(undefined, { AUTOAPPLY_DASHBOARD_TOKEN: "x".repeat(30) })).toBe("x".repeat(30));
    expect(() => resolveToken("short")).toThrow(/24-512 characters/);
    expect(tokensEqual("abc", "abc")).toBe(true);
    expect(tokensEqual("abc", "abd")).toBe(false);
  });
});

describe("host and origin checks", () => {
  it("refuses foreign Host headers, which is what a DNS-rebinding page sends", async () => {
    const rebinding = await http(port, "/api/status", { headers: bearer({ host: `attacker.example:${port}` }) });
    expect(rebinding.status).toBe(403);
    expect((await http(port, "/", { headers: { host: `127.0.0.1:${port + 1}` } })).status).toBe(403);
    expect((await http(port, "/api/status", { headers: bearer({ host: `localhost:${port}` }) })).status).toBe(200);
  });

  it("requires a matching Origin on cookie-authenticated writes", async () => {
    const cookie = `autoapply_dash_${port}=${TOKEN}`;
    const body = JSON.stringify({ type: "echo", params: { lines: 1 } });
    const write = (headers: Record<string, string>) =>
      http(port, "/api/runs", { method: "POST", headers: { cookie, "content-type": "application/json", ...headers }, body });

    expect((await write({})).status).toBe(403);
    expect((await write({ origin: "http://attacker.example" })).status).toBe(403);
    expect((await write({ origin: "null" })).status).toBe(403);
    expect((await write({ origin: `http://127.0.0.1:${port}` })).status).toBe(201);
  });

  it("lets a bearer client write without an Origin but not with a foreign one", async () => {
    const body = JSON.stringify({ type: "echo", params: { lines: 1 } });
    const headers = bearer({ "content-type": "application/json" });
    expect((await http(port, "/api/runs", { method: "POST", headers, body })).status).toBe(201);
    expect((await http(port, "/api/runs", { method: "POST", headers: { ...headers, origin: "http://attacker.example" }, body })).status).toBe(403);
  });

  it("only listens on loopback", async () => {
    await expect(startDashboard({ host: "0.0.0.0", port: 0, token: TOKEN, queue: fixture.queue })).rejects.toThrow(/only listens on/);
  });
});

describe("routing and validation", () => {
  it("answers unknown endpoints and wrong methods with JSON errors", async () => {
    const missing = await http(port, "/api/nothing-here", { headers: bearer() });
    expect(missing.status).toBe(404);
    expect(missing.json<{ error: { code: string } }>().error.code).toBe("not_found");
    const wrongMethod = await http(port, "/api/status", { method: "DELETE", headers: bearer() });
    expect(wrongMethod.status).toBe(405);
    expect(wrongMethod.headers.allow).toBe("GET");
  });

  it("prefers a static segment over a parameter", async () => {
    const types = await http(port, "/api/runs/types", { headers: bearer() });
    expect(types.status).toBe(200);
    expect(types.json<{ types: Array<{ type: string }> }>().types.map((type) => type.type)).toContain("echo");
  });

  it("validates bodies, queries and run params", async () => {
    const badType = await http(port, "/api/runs", { method: "POST", ...jsonBody(port, { type: 42 }) });
    expect(badType.status).toBe(400);
    expect(badType.json<{ error: { code: string; issues: unknown[] } }>().error.code).toBe("invalid_request");

    const extraKey = await http(port, "/api/runs", { method: "POST", ...jsonBody(port, { type: "echo", sneaky: true }) });
    expect(extraKey.status).toBe(400);

    const unknownType = await http(port, "/api/runs", { method: "POST", ...jsonBody(port, { type: "teleport" }) });
    expect(unknownType.status).toBe(400);
    expect(unknownType.json<{ error: { code: string } }>().error.code).toBe("unknown_run_type");

    const badSubmit = await http(port, "/api/runs", { method: "POST", ...jsonBody(port, { type: "submit", params: { applicationIds: [] } }) });
    expect(badSubmit.status).toBe(400);
    expect(badSubmit.json<{ error: { code: string } }>().error.code).toBe("invalid_run_params");

    expect((await http(port, "/api/jobs?pageSize=5000", { headers: bearer() })).status).toBe(400);
    expect((await http(port, "/api/jobs?tier=Z", { headers: bearer() })).status).toBe(400);
  });

  it("rejects malformed, mistyped and oversized bodies", async () => {
    const headers = bearer({ origin: `http://127.0.0.1:${port}` });
    const notJson = await http(port, "/api/runs", { method: "POST", headers: { ...headers, "content-type": "application/json" }, body: "{nope" });
    expect(notJson.status).toBe(400);
    expect(notJson.json<{ error: { code: string } }>().error.code).toBe("invalid_json");

    const form = await http(port, "/api/runs", { method: "POST", headers: { ...headers, "content-type": "application/x-www-form-urlencoded" }, body: "type=echo" });
    expect(form.status).toBe(415);

    const huge = await http(port, "/api/runs", {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify({ type: "echo", params: { pad: "x".repeat(300 * 1024) } }),
    });
    expect(huge.status).toBe(413);
  });
});

describe("static files and path traversal", () => {
  it("serves the app shell with a CSP that allows only the hashed import map", async () => {
    const page = await http(port, "/");
    expect(page.status).toBe(200);
    expect(page.headers["content-type"]).toMatch(/text\/html/);
    const csp = String(page.headers["content-security-policy"]);
    expect(csp).toContain("default-src 'self'");
    expect(csp).toMatch(/script-src 'self' 'sha256-[A-Za-z0-9+/=]+'/);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).not.toContain("unsafe-inline");
    expect(page.headers["x-content-type-options"]).toBe("nosniff");
    expect(page.headers["referrer-policy"]).toBe("no-referrer");
    expect(page.text).toContain('<script type="importmap">');
  });

  it("serves app routes as the shell and the vendor modules from node_modules", async () => {
    expect((await http(port, "/needs-human")).text).toContain('id="app"');
    for (const sheet of ["/styles.css", "/styles/base.css", "/styles/shell.css"]) {
      const response = await http(port, sheet);
      expect(response.status, sheet).toBe(200);
      expect(response.headers["content-type"]).toMatch(/text\/css/);
    }
    const preact = await http(port, "/vendor/preact.mjs");
    expect(preact.status).toBe(200);
    expect(preact.headers["content-type"]).toMatch(/text\/javascript/);
    expect((await http(port, "/vendor/htm.mjs")).status).toBe(200);
    expect((await http(port, "/vendor/preact-hooks.mjs")).text).toContain('from"preact"');
    expect((await http(port, "/vendor/other.mjs")).status).toBe(404);
  });

  it("never serves anything outside web/", async () => {
    for (const path of [
      "/../package.json",
      "/%2e%2e/package.json",
      "/..%2fpackage.json",
      "/..%5Cpackage.json",
      "/vendor/../package.json",
      "/.env",
      "/web/../../package.json",
      "/con.js",
      "/index.html%00.js",
    ]) {
      const response = await http(port, path);
      expect(response.status, path).toBe(404);
    }
    expect(safeRelativePath("/a/../b")).toBeNull();
    expect(safeRelativePath("/views/jobs.js")).toBe("views/jobs.js");
  });

  it("serves screenshots by validated name only", async () => {
    const shot = await http(port, "/api/artifacts/app_held-captcha-1730000000000.png", { headers: bearer() });
    expect(shot.status).toBe(200);
    expect(shot.headers["content-type"]).toBe("image/png");
    for (const name of ["..%2F..%2Fprofile.json", "..%5Cprofile.json", "profile.json", "app_held.png%00", ".hidden.png"]) {
      const response = await http(port, `/api/artifacts/${name}`, { headers: bearer() });
      expect([400, 404], name).toContain(response.status);
    }
    expect((await http(port, "/api/artifacts/app_missing-x-1.png", { headers: bearer() })).status).toBe(404);
  });
});

describe("server-sent run events", () => {
  function readStream(path: string, headers: Record<string, string> = {}): Promise<{ status: number; type: string; text: string }> {
    return new Promise((resolve, reject) => {
      const req = httpRequest({ host: "127.0.0.1", port, path, headers: { host: `127.0.0.1:${port}`, ...bearer(headers) } }, (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          text += chunk;
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, type: String(res.headers["content-type"]), text }));
      });
      req.on("error", reject);
      req.end();
    });
  }

  function frames(text: string): Array<{ id?: string; event?: string; data?: unknown }> {
    return text
      .split("\n\n")
      .filter((block) => block.trim().length > 0 && !block.startsWith(":") && !block.startsWith("retry:"))
      .map((block) => {
        const frame: { id?: string; event?: string; data?: unknown } = {};
        for (const line of block.split("\n")) {
          const [field, ...rest] = line.split(": ");
          const value = rest.join(": ");
          if (field === "id") frame.id = value;
          if (field === "event") frame.event = value;
          if (field === "data") frame.data = JSON.parse(value);
        }
        return frame;
      });
  }

  it("frames each event as id/event/data lines", () => {
    expect(sseFrame("log", { a: 1 }, 7)).toBe('id: 7\nevent: log\ndata: {"a":1}\n\n');
    expect(sseFrame("end", { status: "succeeded" })).toBe('event: end\ndata: {"status":"succeeded"}\n\n');
  });

  it("streams a live run from start to end", async () => {
    const runId = fixture.queue.enqueue("echo", { lines: 3, holdMs: 20 });
    const stream = await readStream(`/api/runs/${runId}/events`);
    expect(stream.status).toBe(200);
    expect(stream.type).toMatch(/text\/event-stream/);
    expect(stream.text.startsWith("retry: 3000\n\n")).toBe(true);

    const parsed = frames(stream.text);
    const logs = parsed.filter((frame) => frame.event === "log");
    expect(logs.map((frame) => Number(frame.id))).toEqual(logs.map((_, index) => index + 1));
    expect(logs.map((frame) => (frame.data as { message: string }).message)).toEqual(
      expect.arrayContaining(["line 1", "line 2", "line 3", "Run finished."]),
    );
    expect(parsed.some((frame) => frame.event === "progress")).toBe(true);
    expect(parsed.at(-1)).toEqual({ event: "end", data: { status: "succeeded" } });
  });

  it("replays only what follows Last-Event-ID for a finished run", async () => {
    const runId = fixture.queue.enqueue("echo", { lines: 2 });
    await fixture.queue.wait(runId);
    const stream = await readStream(`/api/runs/${runId}/events`, { "last-event-id": "2" });
    const logs = frames(stream.text).filter((frame) => frame.event === "log");
    expect(Number(logs[0]?.id)).toBe(3);
    expect(frames(stream.text).at(-1)?.event).toBe("end");
  });

  it("returns 404 for an unknown run", async () => {
    expect((await http(port, "/api/runs/run_missing/events", { headers: bearer() })).status).toBe(404);
  });
});
