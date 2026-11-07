import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { assertPublicHttpsUrl, fetchPostingPage, isPrivateHostname } from "../src/hygiene/pageFetch.js";
import { setHostResolver } from "../src/util/netGuard.js";
import { installTestResolver } from "./setup.js";

beforeEach(() => {
  process.env.AUTOAPPLY_MIN_INTERVAL_MS = "0";
});
afterEach(() => {
  vi.unstubAllGlobals();
  installTestResolver();
});

function stub(responses: Record<string, () => Response>) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push(url);
      expect(init?.redirect).toBe("manual");
      const respond = responses[url];
      if (!respond) throw new TypeError(`unexpected ${url}`);
      return respond();
    }),
  );
  return calls;
}

describe("fetchPostingPage", () => {
  it("refuses a public-looking name that resolves inside the candidate's network, on the first hop or any redirect", async () => {
    setHostResolver(async (host) => (host === "intranet-alias.example.com" ? ["10.0.0.5"] : ["93.184.216.34"]));
    const calls = stub({
      "https://boards.example.com/acme/jobs/9": () => new Response(null, { status: 302, headers: { location: "https://intranet-alias.example.com/admin" } }),
    });

    await expect(fetchPostingPage("https://intranet-alias.example.com/jobs/1")).rejects.toMatchObject({ code: "private_host" });
    expect(calls).toHaveLength(0);
    await expect(fetchPostingPage("https://boards.example.com/acme/jobs/9")).rejects.toMatchObject({ code: "private_host" });
    expect(calls).toEqual(["https://boards.example.com/acme/jobs/9"]);
  });

  it("follows redirects by hand and reports where it landed", async () => {
    const calls = stub({
      "https://boards.example.com/acme/jobs/1": () => new Response(null, { status: 301, headers: { location: "https://jobs.example.com/acme/jobs/1" } }),
      "https://jobs.example.com/acme/jobs/1": () => new Response(null, { status: 302, headers: { location: "/acme?error=true" } }),
      "https://jobs.example.com/acme?error=true": () => new Response("<html>Board</html>", { status: 200, headers: { "content-type": "text/html" } }),
    });
    const page = await fetchPostingPage("https://boards.example.com/acme/jobs/1");
    expect(page).toMatchObject({
      status: 200,
      requestedUrl: "https://boards.example.com/acme/jobs/1",
      finalUrl: "https://jobs.example.com/acme?error=true",
      contentType: "text/html",
      body: "<html>Board</html>",
    });
    expect(page.redirects).toHaveLength(2);
    expect(calls).toHaveLength(3);
  });

  it("stops at a redirect without a location, a redirect loop, or a private target", async () => {
    stub({ "https://a.example.com/1": () => new Response(null, { status: 302 }) });
    await expect(fetchPostingPage("https://a.example.com/1")).rejects.toMatchObject({ code: "invalid_redirect" });
    stub({ "https://a.example.com/1": () => new Response(null, { status: 302, headers: { location: "https://a.example.com/1" } }) });
    await expect(fetchPostingPage("https://a.example.com/1")).rejects.toMatchObject({ code: "redirect_limit" });
    stub({ "https://a.example.com/1": () => new Response(null, { status: 307, headers: { location: "https://intranet.local/x" } }) });
    await expect(fetchPostingPage("https://a.example.com/1")).rejects.toMatchObject({ code: "private_host" });
  });

  it("truncates a huge page instead of failing", async () => {
    stub({ "https://a.example.com/big": () => new Response("x".repeat(5000), { status: 200 }) });
    const page = await fetchPostingPage("https://a.example.com/big", { maxBytes: 1000 });
    expect(page.body.length).toBe(1000);
  });

  it("reports a failed request as a network error", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("fetch failed");
    }));
    await expect(fetchPostingPage("https://a.example.com/1")).rejects.toMatchObject({ code: "network_error" });
  });
});

describe("public URL policy", () => {
  it("accepts public HTTPS names and refuses everything else", () => {
    expect(assertPublicHttpsUrl("https://jobs.example.com/a").hostname).toBe("jobs.example.com");
    for (const [url, code] of [
      ["http://jobs.example.com/a", "insecure_url"],
      ["https://user:pw@jobs.example.com/a", "unsafe_url"],
      ["https://jobs.example.com:8443/a", "unsafe_url"],
      ["https://[::1]/a", "private_host"],
      ["https://printer/a", "private_host"],
      ["ftp://jobs.example.com", "insecure_url"],
    ] as const) {
      expect(() => assertPublicHttpsUrl(url), url).toThrow(expect.objectContaining({ code }));
    }
    expect(isPrivateHostname("router.home.arpa")).toBe(true);
    expect(isPrivateHostname("careers.example.com")).toBe(false);
  });
});
