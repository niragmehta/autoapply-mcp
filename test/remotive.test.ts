import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchJson } from "../src/sources/http.js";
import { clearLeadCache } from "../src/sources/leads/common.js";
import { searchRemotive } from "../src/sources/leads/remotive.js";
import { remotiveJob, remotivePage } from "./fixtures/remotive.js";

vi.mock("../src/sources/http.js", () => ({ fetchJson: vi.fn(), fetchText: vi.fn(), userAgent: () => "autoapply-test" }));
const fetchMock = vi.mocked(fetchJson);

beforeEach(() => {
  fetchMock.mockReset();
  clearLeadCache();
});

describe("Remotive lead source", () => {
  it("sends search, category and company to Remotive with a 30-second request spacing", async () => {
    fetchMock.mockResolvedValue(remotivePage([remotiveJob()]));
    const result = await searchRemotive({ query: "security engineer", category: "software-dev", company: "Example Co", limit: 20 });
    const endpoint = "https://remotive.com/api/remote-jobs?search=security+engineer&category=software-dev&company_name=Example+Co";
    expect(fetchMock).toHaveBeenCalledWith(endpoint, { allowedHosts: ["remotive.com"], minIntervalMs: 30_000 });
    expect(result.leads[0]).toMatchObject({
      source: "remotive", sourceId: "1185979",
      sourceUrl: "https://remotive.com/remote-jobs/software-development/senior-security-engineer-1185979",
      title: "Senior Security Engineer", company: "Example Co",
      locations: ["Remote — USA"], locationRestrictions: ["USA"],
      salary: { min: 50, max: 75, currency: "USD", period: "hour", provenance: "aggregator" },
      publishedAt: "2026-11-04T16:53:35.000Z",
      provenance: { kind: "aggregator", endpoint, publishedAtRaw: "2026-11-04T16:53:35" },
      mustVerifyEmployer: true,
    });
    expect(result.leads[0]).not.toHaveProperty("applyUrl");
    expect(result.attribution.requirements.join(" ")).toMatch(/third-party job sites/);
    expect(result.limitations.join(" ")).toMatch(/24-hour delay/);
  });

  it("keeps only title, tag or category matches and filters eligibility locally", async () => {
    fetchMock.mockResolvedValue(remotivePage([
      remotiveJob(),
      remotiveJob({ id: 2, title: "Account Executive", category: "Sales", tags: [], description: "Work with our security engineer." }),
      remotiveJob({ id: 3, title: "Security Engineer", candidate_required_location: "Worldwide" }),
      remotiveJob({ id: 4, title: "Security Engineer", candidate_required_location: "Europe" }),
      remotiveJob({ id: 5, title: "Security Engineer", candidate_required_location: "" }),
    ]));
    const result = await searchRemotive({ query: "security engineer", country: "US", limit: 20 });
    expect(result.leads.map((lead) => lead.sourceId)).toEqual(["1185979", "3", "5"]);
    expect(result.leads[2]?.locations).toEqual(["Remote — location restrictions unspecified"]);
    const located = await searchRemotive({ query: "security engineer", location: "usa", limit: 20 });
    expect(located.leads.map((lead) => lead.sourceId)).toEqual(["1185979"]);
  });

  it("keeps salary text only with its stated unit", async () => {
    fetchMock.mockResolvedValue(remotivePage([
      remotiveJob({ id: 1, salary: "$80,000 - $102,000" }),
      remotiveJob({ id: 2, salary: "Competitive" }),
      remotiveJob({ id: 3, salary: "$120,000 - $140,000 per year" }),
    ]));
    const { leads } = await searchRemotive({ query: "*", limit: 20 });
    expect(leads[0]?.salary).toEqual({ min: 80000, max: 102000, currency: "USD", provenance: "aggregator" });
    expect(leads[1]?.salary).toBeUndefined();
    expect(leads[2]?.salary).toMatchObject({ min: 120000, max: 140000, period: "year" });
  });

  it("sends no search for a wildcard query and caches each distinct search", async () => {
    fetchMock.mockResolvedValue(remotivePage([remotiveJob()]));
    await searchRemotive({ query: "*", limit: 5 });
    await searchRemotive({ query: "*", limit: 10, page: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://remotive.com/api/remote-jobs");
    await searchRemotive({ query: "designer", limit: 5 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("rejects a response without a jobs array", async () => {
    fetchMock.mockResolvedValue({ "0-legal-notice": "x" });
    await expect(searchRemotive({ query: "engineer", limit: 5 })).rejects.toMatchObject({ code: "invalid_source_response" });
  });
});
