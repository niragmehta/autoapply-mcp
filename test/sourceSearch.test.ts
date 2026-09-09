import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchJson } from "../src/sources/http.js";
import { searchJobSources } from "../src/sources/search.js";
import { AppError } from "../src/util/errors.js";

vi.mock("../src/sources/http.js", () => ({ fetchJson: vi.fn() }));
const fetchMock = vi.mocked(fetchJson);
const query = { query: "security engineer", limit: 20 };
const html = "<p>Own security architecture.</p><p>US residents only; no worldwide eligibility.</p>";

function himalayasJob(overrides: Record<string, unknown> = {}) {
  return {
    guid: "https://himalayas.app/companies/example/jobs/security-engineer",
    title: "Security Engineer",
    companyName: "Example",
    locationRestrictions: ["United States"],
    timezoneRestrictions: [-5, -4],
    description: html,
    pubDate: 1786397119,
    applicationLink: "https://himalayas.app/companies/example/jobs/security-engineer",
    minSalary: 100,
    maxSalary: 150,
    salaryPeriod: "hourly",
    currency: "USD",
    ...overrides,
  };
}

function himalayasPage(overrides: Record<string, unknown> = {}) {
  return { jobs: [himalayasJob()], updatedAt: 1788914664, offset: 0, limit: 20, totalCount: 1, ...overrides };
}

function foorillaJob(overrides: Record<string, unknown> = {}) {
  return {
    id: 123,
    title: "Security Engineer",
    company: { name: "Example", description: "This is a company description, not a job description." },
    location: "Remote, United States",
    countries: [{ id: 99, code: "US", name: "United States" }],
    published: "2026-08-01T09:45:12+00:00",
    apply_url: "https://employer.example/careers/123",
    has_remote: true,
    salary_min: 200000,
    salary_max: 260000,
    salary_currency: "USD",
    salary_min_est: 220000,
    salary_max_est: 280000,
    ...overrides,
  };
}

function foorillaPage(overrides: Record<string, unknown> = {}) {
  return { results: [foorillaJob()], count: 1, pages: 1, page: 1, page_size: 20, ...overrides };
}

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubEnv("AUTOAPPLY_FOORILLA_API_KEY", undefined);
});
afterEach(() => vi.unstubAllEnvs());

describe("source search validation", () => {
  it.each([
    { query: "", limit: 20 },
    { query: " ", limit: 20 },
    { query: "x", limit: 0 },
    { query: "x", limit: 101 },
    { query: "x", limit: 1.5 },
    { query: "x", limit: 20, page: 0 },
    { query: "x", limit: 20, country: "" },
  ])("rejects invalid search inputs before fetching: %j", async (input) => {
    await expect(searchJobSources("himalayas", input)).rejects.toMatchObject({ code: "invalid_source_search" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects providers outside the lead-search allowlist", async () => {
    // @ts-expect-error Runtime callers can still supply an unsupported provider.
    await expect(searchJobSources("greenhouse", query)).rejects.toMatchObject({ code: "unsupported_source" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("Himalayas lead search", () => {
  it("uses one bounded search page, retains original links, full description, pay period and restrictions", async () => {
    fetchMock.mockResolvedValue(himalayasPage());
    const result = await searchJobSources("himalayas", { ...query, country: "US" });
    const [url, options] = fetchMock.mock.calls[0]!;
    expect(new URL(url).pathname).toBe("/jobs/api/search");
    expect(new URL(url).searchParams.get("q")).toBe(query.query);
    expect(new URL(url).searchParams.get("country")).toBe("US");
    expect(new URL(url).searchParams.get("page")).toBe("1");
    expect(new URL(url).searchParams.has("limit")).toBe(false);
    expect(options).toMatchObject({ allowedHosts: ["himalayas.app"], minIntervalMs: 700 });
    expect(options?.headers).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(result.readiness).toBe("ready");
    expect(result.leads[0]).toMatchObject({
      source: "himalayas",
      sourceId: himalayasJob().guid,
      sourceUrl: himalayasJob().guid,
      applyUrl: himalayasJob().applicationLink,
      description: html,
      locations: ["Remote — United States"],
      locationRestrictions: ["United States"],
      timezoneRestrictions: ["UTC-5", "UTC-4"],
      salary: { min: 100, max: 150, currency: "USD", period: "hourly", provenance: "aggregator" },
      publishedAt: new Date(1786397119 * 1000).toISOString(),
      provenance: { kind: "aggregator", publishedAtRaw: 1786397119 },
      mustVerifyEmployer: true,
    });
    expect(result.leads[0]).not.toHaveProperty("ats");
    expect(result.attribution.url).toBe("https://himalayas.app");
    expect(result.attribution.requirements.join(" ")).toMatch(/link.*back/i);
    expect(result.limitations.join(" ")).toMatch(/third-party job/i);
  });

  it("handles documented country objects, timezone strings and millisecond publication dates", async () => {
    fetchMock.mockResolvedValue(himalayasPage({ jobs: [himalayasJob({
      locationRestrictions: [{ alpha2: "CA", name: "Canada", slug: "canada" }],
      timezoneRestrictions: ["UTC-5"],
      pubDate: 1786397119000,
      applicationLink: "https://employer.example/jobs/1",
    })] }));
    const result = await searchJobSources("himalayas", query);
    expect(result.leads[0]?.locations).toEqual(["Remote — Canada"]);
    expect(result.leads[0]?.publishedAt).toBe(new Date(1786397119000).toISOString());
    expect(result.leads[0]?.applyUrl).toBe("https://employer.example/jobs/1");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, null, ""])("never assumes annual pay for an absent period (%s)", async (salaryPeriod) => {
    fetchMock.mockResolvedValue(himalayasPage({ jobs: [himalayasJob({ salaryPeriod })] }));
    const result = await searchJobSources("himalayas", query);
    expect(result.leads[0]?.salary?.period).toBeUndefined();
    expect(result.leads[0]?.salary?.min).toBe(100);
  });

  it("preserves a new explicit pay-period string without guessing its duration", async () => {
    fetchMock.mockResolvedValue(himalayasPage({ jobs: [himalayasJob({ salaryPeriod: "per project" })] }));
    expect((await searchJobSources("himalayas", query)).leads[0]?.salary?.period).toBe("per project");
  });

  it("supports canonical company slugs and preserves zero or one-sided salary disclosures", async () => {
    fetchMock.mockResolvedValue(himalayasPage({ jobs: [himalayasJob({
      description: undefined, excerpt: "Original excerpt", timezoneRestrictions: [5.5],
      minSalary: 0, maxSalary: null, currency: null,
    })] }));
    const result = await searchJobSources("himalayas", { ...query, company: "example-company" });
    expect(new URL(fetchMock.mock.calls[0]![0]).searchParams.get("company")).toBe("example-company");
    expect(result.leads[0]?.description).toBe("Original excerpt");
    expect(result.leads[0]?.timezoneRestrictions).toEqual(["UTC+5.5"]);
    expect(result.leads[0]?.salary).toEqual({ min: 0, period: "hourly", provenance: "aggregator" });
  });

  it("distinguishes an explicitly worldwide listing from missing geographic data", async () => {
    fetchMock.mockResolvedValue(himalayasPage({ jobs: [
      himalayasJob({ locationRestrictions: [] }),
      himalayasJob({ locationRestrictions: undefined, minSalary: null, maxSalary: null }),
    ], totalCount: 2 }));
    const result = await searchJobSources("himalayas", query);
    expect(result.leads[0]?.locations).toEqual(["Remote — Worldwide"]);
    expect(result.leads[1]?.locations).toEqual(["Remote — location restrictions unspecified"]);
    expect(result.leads[1]?.salary).toBeUndefined();
  });

  it("returns explicit same-page continuation when limit truncates a provider page", async () => {
    fetchMock.mockResolvedValue(himalayasPage({ jobs: [himalayasJob(), himalayasJob()], totalCount: 40 }));
    const result = await searchJobSources("himalayas", { ...query, limit: 1 });
    expect(result.leads).toHaveLength(1);
    expect(result.pagination).toMatchObject({
      page: 1, pageSize: 20, returned: 1, total: 40, hasMore: true,
      truncated: true, remainingOnPage: 1, nextPage: 1, nextPageLimit: 20,
    });
    expect(result.limitations.join(" ")).toMatch(/same page/i);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("exposes next search pages without scanning the full feed", async () => {
    fetchMock.mockResolvedValue(himalayasPage({ offset: 20, totalCount: 60 }));
    const result = await searchJobSources("himalayas", { ...query, page: 2, limit: 100 });
    expect(new URL(fetchMock.mock.calls[0]![0]).searchParams.get("page")).toBe("2");
    expect(result.pagination).toMatchObject({ page: 2, hasMore: true, nextPage: 3, truncated: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reports an empty valid search, not an error or fabricated continuation", async () => {
    fetchMock.mockResolvedValue(himalayasPage({ jobs: [], totalCount: 0 }));
    const result = await searchJobSources("himalayas", query);
    expect(result.leads).toEqual([]);
    expect(result.pagination.hasMore).toBe(false);
    expect(result.pagination.nextPage).toBeUndefined();
  });

  it("allows missing optional job data without inventing dates or employer URLs", async () => {
    fetchMock.mockResolvedValue(himalayasPage({
      jobs: [{ title: "Engineer", companyName: "Example", guid: "opaque-source-id" }],
    }));
    const lead = (await searchJobSources("himalayas", query)).leads[0]!;
    expect(lead.publishedAt).toBeUndefined();
    expect(lead.applyUrl).toBeUndefined();
    expect(lead.sourceUrl).toMatch(/^https:\/\/himalayas.app\/jobs\/api\/search/);
    expect(lead.description).toBe("");
  });

  it.each([{}, [], { jobs: {} }, { jobs: [], totalCount: 0 }, himalayasPage({ jobs: [{ title: "invalid" }] }),
    himalayasPage({ jobs: [himalayasJob({ applicationLink: "javascript:alert(1)" })] }),
    himalayasPage({ jobs: [himalayasJob({ locationRestrictions: [{ unexpected: true }] })] }),
    himalayasPage({ limit: 0 }),
    himalayasPage({ totalCount: 0 }),
    himalayasPage({ jobs: [himalayasJob(), himalayasJob()], limit: 1, totalCount: 2 }),
  ])("raises AppError rather than returning empty leads for malformed API JSON", async (payload) => {
    fetchMock.mockResolvedValue(payload);
    await expect(searchJobSources("himalayas", query)).rejects.toBeInstanceOf(AppError);
    await expect(searchJobSources("himalayas", query)).rejects.toMatchObject({ code: "invalid_source_response" });
  });

  it("does not silently ignore unsupported city filters", async () => {
    await expect(searchJobSources("himalayas", { ...query, location: "San Francisco" }))
      .rejects.toMatchObject({ code: "source_filter_unsupported" });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("Foorilla conditional connector", () => {
  it("requires an explicitly configured API key before any network call", async () => {
    await expect(searchJobSources("foorilla", query)).rejects.toMatchObject({ code: "source_auth_required" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends only a host-bound Api-Key header and source-supported title/location/company filters", async () => {
    vi.stubEnv("AUTOAPPLY_FOORILLA_API_KEY", "test-only-credential");
    fetchMock.mockResolvedValue(foorillaPage({ count: 45, pages: 3, page: 2 }));
    const result = await searchJobSources("foorilla", { ...query, location: "United States", company: "Example", page: 2 });
    const [url, options] = fetchMock.mock.calls[0]!;
    expect(new URL(url).pathname).toBe("/api/v1/hiring/job/");
    expect(new URL(url).searchParams.get("title")).toBe(query.query);
    expect(new URL(url).searchParams.get("location")).toBe("United States");
    expect(new URL(url).searchParams.get("company")).toBe("Example");
    expect(new URL(url).searchParams.get("page_size")).toBe("20");
    expect(new URL(url).searchParams.get("page")).toBe("2");
    expect(url).not.toContain("test-only-credential");
    expect(options).toMatchObject({
      allowedHosts: ["foorilla.com"], headers: { "Api-Key": "test-only-credential" }, minIntervalMs: 700,
    });
    expect(result.readiness).toBe("ready");
    expect(result.leads[0]).toMatchObject({
      sourceId: "123", sourceUrl: "https://foorilla.com/api/v1/hiring/job/123",
      company: "Example", locations: ["Remote, United States"], locationRestrictions: ["United States"],
      description: "", applyUrl: "https://employer.example/careers/123",
      publishedAt: "2026-08-01T09:45:12+00:00",
      salary: { min: 200000, max: 260000, currency: "USD", provenance: "aggregator" },
      mustVerifyEmployer: true,
    });
    expect(result.leads[0]?.salary?.period).toBeUndefined();
    expect(result.pagination).toMatchObject({ page: 2, total: 45, totalPages: 3, nextPage: 3, hasMore: true });
    expect(result.attribution.licenseUrl).toBe("https://creativecommons.org/licenses/by-sa/4.0/");
    expect(result.attribution.changes).toMatch(/normaliz/i);
    expect(result.limitations.join(" ")).toMatch(/description.*pay period/i);
    expect(JSON.stringify(result)).not.toContain("test-only-credential");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("never upgrades estimated or converted salary to reported compensation", async () => {
    vi.stubEnv("AUTOAPPLY_FOORILLA_API_KEY", "test-only-credential");
    fetchMock.mockResolvedValue(foorillaPage({ results: [foorillaJob({
      salary_min: null, salary_max: null, salary_min_usd: 250000, salary_max_usd: 300000,
    })] }));
    expect((await searchJobSources("foorilla", query)).leads[0]?.salary).toBeUndefined();
  });

  it("uses the client cap as its page size and exposes truncated same-page results honestly", async () => {
    vi.stubEnv("AUTOAPPLY_FOORILLA_API_KEY", "test-only-credential");
    fetchMock.mockResolvedValueOnce(foorillaPage({ page_size: 100 }))
      .mockResolvedValueOnce(foorillaPage({ results: [foorillaJob(), foorillaJob()], count: 2 }));
    await searchJobSources("foorilla", { ...query, limit: 100 });
    expect(new URL(fetchMock.mock.calls[0]![0]).searchParams.get("page_size")).toBe("100");
    const truncated = await searchJobSources("foorilla", { ...query, limit: 1 });
    expect(truncated.leads).toHaveLength(1);
    expect(truncated.pagination).toMatchObject({ nextPage: 1, nextPageLimit: 20, hasMore: true, truncated: true });
  });

  it("allows optional fields to be absent and preserves a valid empty page", async () => {
    vi.stubEnv("AUTOAPPLY_FOORILLA_API_KEY", "test-only-credential");
    fetchMock.mockResolvedValueOnce(foorillaPage({
      results: [{ id: 123, title: "Engineer", company: { name: "Example" } }],
    })).mockResolvedValueOnce(foorillaPage({ results: [], count: 0, pages: 0 }));
    const result = await searchJobSources("foorilla", query);
    expect(result.leads[0]?.locations).toEqual([]);
    expect(result.leads[0]?.publishedAt).toBeUndefined();
    expect(result.leads[0]?.applyUrl).toBeUndefined();
    const empty = await searchJobSources("foorilla", query);
    expect(empty.leads).toEqual([]);
    expect(empty.pagination.hasMore).toBe(false);
  });

  it.each([{}, { results: [] }, foorillaPage({ results: [{ title: "bad" }] }),
    foorillaPage({ results: [foorillaJob({ published: { unexpected: "date" } })] }),
    foorillaPage({ results: [foorillaJob({ published: "invalid-date" })] }),
    foorillaPage({ pages: -1 }), foorillaPage({ page_size: 0 }),
    foorillaPage({ count: 0 }), foorillaPage({ pages: 0 }),
  ])("fails closed for an invalid envelope or result", async (payload) => {
    vi.stubEnv("AUTOAPPLY_FOORILLA_API_KEY", "test-only-credential");
    fetchMock.mockResolvedValue(payload);
    await expect(searchJobSources("foorilla", query)).rejects.toMatchObject({ code: "invalid_source_response" });
  });

  it("does not treat textual ISO countries as Foorilla internal taxonomy IDs", async () => {
    vi.stubEnv("AUTOAPPLY_FOORILLA_API_KEY", "test-only-credential");
    await expect(searchJobSources("foorilla", { ...query, country: "US" }))
      .rejects.toMatchObject({ code: "source_filter_unsupported" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("translates access denial into an explicit authentication error without response data", async () => {
    vi.stubEnv("AUTOAPPLY_FOORILLA_API_KEY", "test-only-credential");
    fetchMock.mockRejectedValue(new AppError("http_error", "private response data", { status: 403 }));
    await expect(searchJobSources("foorilla", query)).rejects.toMatchObject({ code: "source_auth_required" });
    await expect(searchJobSources("foorilla", query)).rejects.not.toThrow(/private response data/);
  });

  it("preserves stable transport failure codes while excluding potentially sensitive raw errors", async () => {
    vi.stubEnv("AUTOAPPLY_FOORILLA_API_KEY", "test-only-credential");
    fetchMock.mockRejectedValueOnce(new AppError("network_error", "test-only-credential", { secret: "private" }))
      .mockRejectedValueOnce(new Error("test-only-credential"));
    await expect(searchJobSources("foorilla", query)).rejects.toMatchObject({
      code: "network_error", message: "Foorilla request failed.",
    });
    await expect(searchJobSources("foorilla", query)).rejects.toMatchObject({
      code: "source_request_failed", message: "Foorilla request failed.",
    });
  });
});
