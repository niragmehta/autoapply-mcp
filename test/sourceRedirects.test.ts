import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchSourceResponse } from "../src/sources/sourceRedirects.js";
import { setHostResolver } from "../src/util/netGuard.js";
import { installTestResolver } from "./setup.js";

afterEach(() => {
  vi.unstubAllGlobals();
  installTestResolver();
});

function stub(responses: Record<string, () => Response>) {
  const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      expect(init?.redirect).toBe("manual");
      const respond = responses[url];
      if (!respond) throw new TypeError(`unexpected ${url}`);
      return respond();
    }),
  );
  return calls;
}

describe("fetching a source without a host allowlist", () => {
  it("follows redirects by hand and returns the final response", async () => {
    const calls = stub({
      "https://careers.example.com/jobs": () => new Response(null, { status: 301, headers: { location: "/en/jobs" } }),
      "https://careers.example.com/en/jobs": () => new Response("{}", { status: 200 }),
    });

    const response = await fetchSourceResponse("https://careers.example.com/jobs", { method: "GET" });

    expect(response.status).toBe(200);
    expect(calls.map((call) => call.url)).toEqual(["https://careers.example.com/jobs", "https://careers.example.com/en/jobs"]);
  });

  it("refuses a board host that resolves to a private address before sending anything", async () => {
    setHostResolver(async () => ["192.168.1.1"]);
    const calls = stub({});

    await expect(fetchSourceResponse("https://jobs.attacker.example.com/feed", { method: "GET" })).rejects.toMatchObject({ code: "private_host" });
    expect(calls).toHaveLength(0);
  });

  it("refuses a redirect into the candidate's network or to a non-web scheme", async () => {
    setHostResolver(async (host) => (host === "metadata.example.com" ? ["169.254.169.254"] : ["93.184.216.34"]));
    stub({
      "https://a.example.com/1": () => new Response(null, { status: 302, headers: { location: "https://metadata.example.com/latest" } }),
      "https://b.example.com/1": () => new Response(null, { status: 302, headers: { location: "file:///etc/passwd" } }),
    });

    await expect(fetchSourceResponse("https://a.example.com/1", { method: "GET" })).rejects.toMatchObject({ code: "private_host" });
    await expect(fetchSourceResponse("https://b.example.com/1", { method: "GET" })).rejects.toMatchObject({ code: "unsafe_source_url" });
  });

  it("drops credentials when a redirect leaves the origin", async () => {
    const calls = stub({
      "https://api.example.com/jobs": () => new Response(null, { status: 307, headers: { location: "https://cdn.example.net/jobs" } }),
      "https://cdn.example.net/jobs": () => new Response("[]", { status: 200 }),
    });

    await fetchSourceResponse("https://api.example.com/jobs", { method: "GET", headers: { authorization: "Bearer test-token", accept: "application/json" } });

    const forwarded = new Headers(calls[1]?.init?.headers);
    expect(forwarded.get("authorization")).toBeNull();
    expect(forwarded.get("accept")).toBe("application/json");
  });
});
