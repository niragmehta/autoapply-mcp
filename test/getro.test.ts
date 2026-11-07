import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchJson, fetchText } from "../src/sources/http.js";
import { clearLeadCache } from "../src/sources/leads/common.js";
import { getroCollectionId, searchGetro } from "../src/sources/leads/getro.js";
import { getroBoardPage, getroJob, getroResponse } from "./fixtures/getro.js";

vi.mock("../src/sources/http.js", () => ({ fetchJson: vi.fn(), fetchText: vi.fn(), userAgent: () => "autoapply-test" }));
const jsonMock = vi.mocked(fetchJson);
const textMock = vi.mocked(fetchText);
const GC_SEARCH = "https://api.getro.com/api/v2/collections/222/search/jobs";

beforeEach(() => {
  jsonMock.mockReset();
  textMock.mockReset();
  clearLeadCache();
});

describe("Getro lead source", () => {
  it("searches a known network and keeps the employer's ATS link for verification", async () => {
    jsonMock.mockResolvedValue(getroResponse([getroJob()], 45));
    const result = await searchGetro({ query: "security engineer", site: "https://jobs.generalcatalyst.com/jobs", country: "US", limit: 20 });
    expect(jsonMock).toHaveBeenCalledWith(GC_SEARCH, {
      body: { hitsPerPage: 20, page: 0, filters: { page: 0, searchable_locations: ["United States"] }, query: "security engineer" },
      allowedHosts: ["api.getro.com"], minIntervalMs: 700,
    });
    expect(textMock).not.toHaveBeenCalled();
    expect(result.leads[0]).toMatchObject({
      source: "getro", sourceId: "99207013",
      sourceUrl: "https://jobs.generalcatalyst.com/companies/example-co/jobs/99207013-senior-security-engineer",
      applyUrl: "https://job-boards.greenhouse.io/exampleco/jobs/4751411005",
      title: "Senior Security Engineer", company: "Example Co", locations: ["New York, NY, USA", "Remote"],
      description: "",
      salary: { min: 180000, max: 220000, currency: "USD", period: "year", provenance: "aggregator" },
      publishedAt: new Date(1793972826 * 1000).toISOString(),
      provenance: { kind: "aggregator", endpoint: GC_SEARCH, publishedAtRaw: 1793972826 },
      mustVerifyEmployer: true,
    });
    expect(result.pagination).toMatchObject({ page: 1, pageSize: 20, total: 45, totalPages: 3, hasMore: true, nextPage: 2 });
    expect(result.attribution).toMatchObject({ label: "General Catalyst job board (Getro)", url: "https://jobs.generalcatalyst.com/jobs" });
  });

  it("keeps pay only as published: no undefined periods, no private ranges", async () => {
    jsonMock.mockResolvedValue(getroResponse([
      getroJob({ id: 1, compensation_period: "period_not_defined" }),
      getroJob({ id: 2, compensation_public: false }),
      getroJob({ id: 3, compensation_amount_min_cents: null, compensation_amount_max_cents: 0 }),
      getroJob({ id: 4, url: "http://insecure.example.com/apply", work_mode: "on_site" }),
    ]));
    const { leads } = await searchGetro({ query: "*", site: "jobs.accel.com", limit: 20 });
    expect(jsonMock.mock.calls[0]?.[1]).toMatchObject({ body: { query: "", filters: { page: 0 } } });
    expect(leads[0]?.salary).toEqual({ min: 180000, max: 220000, currency: "USD", provenance: "aggregator" });
    expect(leads[1]?.salary).toBeUndefined();
    expect(leads[2]?.salary).toBeUndefined();
    expect(leads[3]?.applyUrl).toBeUndefined();
    expect(leads[3]?.locations).toEqual(["New York, NY, USA"]);
  });

  it("resolves a *.getro.com board once from its page data", async () => {
    textMock.mockResolvedValue(getroBoardPage(4321));
    jsonMock.mockResolvedValue(getroResponse([getroJob()]));
    const result = await searchGetro({ query: "engineer", site: "exampleventures.getro.com", location: "Berlin", limit: 5 });
    expect(textMock).toHaveBeenCalledWith("https://exampleventures.getro.com/jobs", {
      allowedHosts: ["exampleventures.getro.com"], maxBytes: 4 * 1024 * 1024,
    });
    expect(jsonMock.mock.calls[0]?.[0]).toBe("https://api.getro.com/api/v2/collections/4321/search/jobs");
    expect(jsonMock.mock.calls[0]?.[1]).toMatchObject({ body: { filters: { searchable_locations: ["Berlin"] } } });
    expect(result.leads[0]?.sourceUrl).toBe("https://exampleventures.getro.com/companies/example-co/jobs/99207013-senior-security-engineer");
    await searchGetro({ query: "designer", site: "exampleventures.getro.com", limit: 5 });
    expect(textMock).toHaveBeenCalledTimes(1);
    textMock.mockResolvedValue("<html>no data</html>");
    await expect(searchGetro({ query: "x", site: "otherfund.getro.com", limit: 5 })).rejects.toMatchObject({ code: "invalid_source_response" });
  });

  it("accepts a numeric collection id without a board host", async () => {
    jsonMock.mockResolvedValue(getroResponse([getroJob()]));
    const result = await searchGetro({ query: "engineer", site: "1680", limit: 5, page: 3 });
    const endpoint = "https://api.getro.com/api/v2/collections/1680/search/jobs";
    expect(jsonMock.mock.calls[0]?.[1]).toMatchObject({ body: { page: 2, filters: { page: 2 } } });
    expect(result.leads[0]?.sourceUrl).toBe(endpoint);
    expect(result.attribution).toMatchObject({ label: "Getro collection 1680 job board (Getro)", url: "https://www.getro.com" });
  });

  it.each([undefined, "evil.example.com", "www.getro.com", "api.getro.com", "jobs.generalcatalyst.com.evil.example", "http://jobs.accel.com", "0"])(
    "rejects site %s without any request", async (site) => {
      await expect(searchGetro({ query: "engineer", limit: 5, ...(site ? { site } : {}) })).rejects.toMatchObject({ code: "source_filter_unsupported" });
      expect(jsonMock).not.toHaveBeenCalled();
      expect(textMock).not.toHaveBeenCalled();
    });

  it("reads only a positive numeric network id from page data", () => {
    expect(getroCollectionId(getroBoardPage("917"))).toBe("917");
    expect(getroCollectionId(getroBoardPage("1; drop"))).toBeNull();
    expect(getroCollectionId(getroBoardPage(0))).toBeNull();
    expect(getroCollectionId("<script id=\"__NEXT_DATA__\">{broken</script>")).toBeNull();
  });
});
