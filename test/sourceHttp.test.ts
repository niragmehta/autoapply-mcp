import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchJson, fetchText } from "../src/sources/http.js";

beforeEach(() => {
  vi.stubEnv("AUTOAPPLY_MIN_INTERVAL_MS", "0");
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("bounded source HTTP", () => {
  it("reads XML text through the same bounded client", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<offers/>")));
    expect(await fetchText("https://acme.recruitee.com/api/feeds/offers.xml", {
      allowedHosts: ["acme.recruitee.com"],
    })).toBe("<offers/>");
  });

  it("rejects an untrusted initial host before making a request", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(fetchJson("https://evil.example/jobs", {
      allowedHosts: ["api.smartrecruiters.com"],
    })).rejects.toMatchObject({ code: "source_host_not_allowed" });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    "https://evil.example/jobs",
    "https://api.smartrecruiters.com.evil.example/jobs",
    "http://api.smartrecruiters.com/jobs",
    "https://user:password@api.smartrecruiters.com/jobs",
    "https://api.smartrecruiters.com:8443/jobs",
  ])("refuses unsafe redirect %s without forwarding credentials", async (location) => {
    const fetch = vi.fn(async () => new Response(null, { status: 302, headers: { location } }));
    vi.stubGlobal("fetch", fetch);
    await expect(fetchJson("https://api.smartrecruiters.com/jobs", {
      allowedHosts: ["api.smartrecruiters.com"],
      headers: { "Api-Key": "test-only-placeholder" },
    })).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch.mock.calls[0]?.[1]).toMatchObject({ redirect: "manual" });
  });

  it("follows a permitted public redirect and drops cross-origin custom headers", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(new Response(null, {
        status: 302, headers: { location: "https://apply.workable.com/api/v1/widget/accounts/acme" },
      }))
      .mockResolvedValueOnce(new Response('{"jobs":[]}'));
    vi.stubGlobal("fetch", fetch);
    expect(await fetchJson("https://www.workable.com/api/accounts/acme", {
      allowedHosts: ["www.workable.com", "apply.workable.com"],
      headers: { "Api-Key": "test-only-placeholder" },
    })).toEqual({ jobs: [] });
    expect(fetch.mock.calls[1]?.[1]?.headers).not.toHaveProperty("Api-Key");
  });

  it("bounds redirect loops", async () => {
    const fetch = vi.fn(async () => new Response(null, { status: 302, headers: { location: "/again" } }));
    vi.stubGlobal("fetch", fetch);
    await expect(fetchText("https://acme.example/jobs", { allowedHosts: ["acme.example"] }))
      .rejects.toMatchObject({ code: "redirect_limit" });
    expect(fetch.mock.calls.length).toBeLessThanOrEqual(6);
  });

  it("rejects redirects without a destination", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 302 })));
    await expect(fetchText("https://acme.example/jobs", { allowedHosts: ["acme.example"] }))
      .rejects.toMatchObject({ code: "invalid_redirect" });
  });

  it("enforces the body size cap while reading", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("too much data")));
    await expect(fetchText("https://acme.example/jobs", { maxBytes: 3 }))
      .rejects.toThrow(/response exceeded/);
  });

  it("does not expose authenticated request headers in HTTP errors", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 401 })));
    await expect(fetchJson("https://foorilla.com/api/v1/hiring/job/", {
      allowedHosts: ["foorilla.com"],
      headers: { "Api-Key": "test-only-placeholder" },
    })).rejects.toThrow("HTTP 401 from foorilla.com");
  });
});
