import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchText } from "../src/sources/http.js";
import { builtInUrl, postedAt, salaryBand, searchBuiltIn } from "../src/sources/leads/builtin.js";
import { clearLeadCache } from "../src/sources/leads/common.js";
import { builtInCards, builtInPage } from "./fixtures/builtin.js";

vi.mock("../src/sources/http.js", () => ({ fetchJson: vi.fn(), fetchText: vi.fn(), userAgent: () => "autoapply-test" }));
const fetchMock = vi.mocked(fetchText);
const cards = [builtInCards.remote!, builtInCards.multi!, builtInCards.bare!];

beforeEach(() => {
  fetchMock.mockReset();
  clearLeadCache();
});

describe("Built In URLs", () => {
  it("builds only robots.txt-permitted category and path-keyword pages", () => {
    expect(builtInUrl({ query: "security engineer", category: "cybersecurity-it" }))
      .toBe("https://builtin.com/jobs/cybersecurity-it/search/security-engineer");
    expect(builtInUrl({ query: "*", category: "dev-engineering", location: "Remote", site: "builtinsf.com", page: 2 }))
      .toBe("https://www.builtinsf.com/jobs/remote/dev-engineering?page=2");
    expect(builtInUrl({ query: "C++ / Rust", category: "dev-engineering", location: "hybrid", site: "https://www.builtinnyc.com/jobs" }))
      .toBe("https://www.builtinnyc.com/jobs/hybrid/dev-engineering/search/c-rust");
    expect(builtInUrl({ query: "x", category: "data-analytics", site: "www.builtin.com" })).toBe("https://builtin.com/jobs/data-analytics/search/x");
  });

  it.each([
    [{ query: "x" }, /category/],
    [{ query: "x", category: "engineering" }, /category/],
    [{ query: "x", category: "dev-engineering", location: "Austin" }, /remote.*hybrid/],
    [{ query: "x", category: "dev-engineering", page: 4 }, /pages 1-3/],
    [{ query: "x", category: "dev-engineering", site: "evil.example.com" }, /site/],
    [{ query: "x", category: "dev-engineering", site: "builtin.com.evil.example" }, /site/],
  ])("rejects %j", (input, message) => {
    expect(() => builtInUrl(input)).toThrow(expect.objectContaining({ code: "source_filter_unsupported", message: expect.stringMatching(message) }));
  });
});

describe("Built In lead source", () => {
  it("joins the page's ItemList with its job cards", async () => {
    fetchMock.mockResolvedValue(builtInPage(cards));
    const result = await searchBuiltIn({ query: "security engineer", category: "cybersecurity-it", limit: 20 });
    const endpoint = "https://builtin.com/jobs/cybersecurity-it/search/security-engineer";
    expect(fetchMock).toHaveBeenCalledWith(endpoint, { allowedHosts: ["builtin.com"], maxBytes: 8 * 1024 * 1024, minIntervalMs: 2000 });
    const [remote, multi, bare] = result.leads;
    const retrievedAt = Date.parse(remote!.provenance.retrievedAt);
    expect(remote).toMatchObject({
      source: "builtin", sourceId: "12113632",
      sourceUrl: "https://builtin.com/job/senior-product-security-engineer/12113632",
      title: "Senior Product Security Engineer", company: "Example Pay", locations: ["Canada (Remote)"],
      description: "Summary for Senior Product Security Engineer.",
      salary: { min: 153000, max: 213000, period: "Annually", provenance: "aggregator" },
      publishedAt: new Date(retrievedAt - 27 * 60_000).toISOString(),
      provenance: { kind: "aggregator", endpoint, publishedAtRaw: "27 Minutes Ago" },
      mustVerifyEmployer: true,
    });
    expect(remote?.salary).not.toHaveProperty("currency");
    expect(multi).toMatchObject({
      company: "Example Cloud", locations: ["San Francisco, CA, USA (Hybrid)", "New York, NY, USA (Hybrid)"],
      salary: { min: 60, max: 80, period: "Hourly" }, provenance: { publishedAtRaw: "Reposted 3 Days Ago" },
    });
    expect(multi).not.toHaveProperty("publishedAt", expect.anything());
    expect(bare).toMatchObject({ title: "Security Engineer & Analyst", company: "Example & Sons", locations: [] });
    expect(bare?.publishedAt).toBeUndefined();
    expect(result.pagination).toMatchObject({ page: 1, pageSize: 25, returned: 3, hasMore: false });
    expect(result.limitations.join(" ")).toMatch(/Community Terms/);
  });

  it("reads plain ld+json pages, market hosts and the company filter", async () => {
    fetchMock.mockResolvedValue(builtInPage(cards, "www.builtinsf.com", "application/ld+json"));
    const result = await searchBuiltIn({ query: "*", category: "cybersecurity-it", site: "builtinsf.com", company: "example pay", limit: 20 });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://www.builtinsf.com/jobs/cybersecurity-it");
    expect(fetchMock.mock.calls[0]?.[1]).toMatchObject({ allowedHosts: ["www.builtinsf.com"] });
    expect(result.leads.map((lead) => lead.sourceUrl)).toEqual(["https://www.builtinsf.com/job/senior-product-security-engineer/12113632"]);
  });

  it("pages up to page 3 and truncates to the limit", async () => {
    const full = Array.from({ length: 25 }, (_, index) => ({ ...builtInCards.remote!, id: String(1000 + index), title: `Engineer ${index}` }));
    fetchMock.mockResolvedValue(builtInPage(full));
    const first = await searchBuiltIn({ query: "engineer", category: "dev-engineering", limit: 10 });
    expect(first.pagination).toMatchObject({ returned: 10, truncated: true, nextPage: 1, nextPageLimit: 25, hasMore: true });
    const third = await searchBuiltIn({ query: "engineer", category: "dev-engineering", limit: 25, page: 3 });
    expect(third.pagination).toMatchObject({ page: 3, returned: 25, hasMore: false });
  });

  it("returns listings without guessed card fields when the cards cannot be read", async () => {
    fetchMock.mockResolvedValue(builtInPage(cards).replace(/data-id="job-card-title"/g, 'data-id="renamed"'));
    const result = await searchBuiltIn({ query: "security", category: "cybersecurity-it", limit: 20 });
    expect(result.leads).toHaveLength(3);
    expect(result.leads[0]).toMatchObject({ company: "", locations: [] });
    expect(result.leads[0]?.salary).toBeUndefined();
    expect(result.limitations.join(" ")).toMatch(/cards could not be read/);
    clearLeadCache();
    fetchMock.mockResolvedValue("<html><body>No jobs</body></html>");
    expect((await searchBuiltIn({ query: "security", category: "cybersecurity-it", limit: 20 })).leads).toEqual([]);
  });

  it("converts only exact posting ages and plausible salary bands", () => {
    const now = Date.parse("2026-11-06T12:00:00.000Z");
    expect(postedAt("Today", now)).toBe("2026-11-06T12:00:00.000Z");
    expect(postedAt("Yesterday", now)).toBe("2026-11-05T12:00:00.000Z");
    expect(postedAt("An Hour Ago", now)).toBe("2026-11-06T11:00:00.000Z");
    expect(postedAt("3 Weeks Ago", now)).toBe("2026-10-16T12:00:00.000Z");
    expect(postedAt("One Month Ago", now)).toBe("2026-10-07T12:00:00.000Z");
    expect(postedAt("Reposted 2 Days Ago", now)).toBeUndefined();
    expect(postedAt("30+ Days Ago", now)).toBeUndefined();
    expect(salaryBand("170K-230K Annually")).toMatchObject({ min: 170000, max: 230000, period: "Annually" });
    expect(salaryBand("$45 Hourly")).toMatchObject({ min: 45, max: 45, period: "Hourly" });
    expect(salaryBand("3000-5000 Hourly")).toBeUndefined();
    expect(salaryBand("Competitive")).toBeUndefined();
  });
});
