import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchJson } from "../src/sources/http.js";
import { clearLeadCache } from "../src/sources/leads/common.js";
import { searchRemoteOk } from "../src/sources/leads/remoteok.js";
import { remoteOkJob, remoteOkLegal } from "./fixtures/remoteok.js";

vi.mock("../src/sources/http.js", () => ({ fetchJson: vi.fn(), fetchText: vi.fn(), userAgent: () => "autoapply-test" }));
const fetchMock = vi.mocked(fetchJson);
const SOURCE_URL = "https://remoteok.com/remote-jobs/remote-senior-security-engineer-example-co-1137694";

function feed() {
  return [
    remoteOkLegal,
    remoteOkJob(),
    remoteOkJob({ id: "2", position: "Security Analyst", tags: ["engineer"], location: "Worldwide" }),
    remoteOkJob({ id: "3", position: "Platform Engineer", tags: ["security"], location: "Europe" }),
    remoteOkJob({ id: "4", position: "Sales Lead", tags: ["sales"], location: "" }),
    remoteOkJob({ id: "5", position: "Security Engineer", company: "Other Inc", location: "" }),
  ];
}

beforeEach(() => {
  fetchMock.mockReset();
  clearLeadCache();
});

describe("Remote OK lead source", () => {
  it("reads the single feed, skips the legal notice and returns attributed, unverified leads", async () => {
    fetchMock.mockResolvedValue([remoteOkLegal, remoteOkJob()]);
    const result = await searchRemoteOk({ query: "security engineer", limit: 20 });
    expect(fetchMock).toHaveBeenCalledWith("https://remoteok.com/api", { allowedHosts: ["remoteok.com"], minIntervalMs: 700 });
    expect(result.leads).toHaveLength(1);
    expect(result.leads[0]).toMatchObject({
      source: "remoteok", sourceId: "1137694", sourceUrl: SOURCE_URL, applyUrl: SOURCE_URL,
      title: "Senior Security Engineer", company: "Example Co", locations: ["United States"],
      description: "<p>At Example Co, we\u2019re securing robots.</p>",
      salary: { min: 90000, max: 110000, provenance: "aggregator" },
      publishedAt: "2026-11-06T00:00:11.000Z",
      provenance: { kind: "aggregator", endpoint: "https://remoteok.com/api", publishedAtRaw: "2026-11-05T17:00:11-07:00" },
      mustVerifyEmployer: true,
    });
    expect(result.leads[0]?.salary).not.toHaveProperty("period");
    expect(result.leads[0]?.salary).not.toHaveProperty("currency");
    expect(result.attribution).toMatchObject({ label: "Remote OK", url: "https://remoteok.com" });
    expect(result.attribution.requirements.join(" ")).toMatch(/followed link/);
    expect(result.limitations.join(" ")).toMatch(/ai-train=no/);
  });

  it("keeps an employer apply link but never a non-HTTPS one", async () => {
    fetchMock.mockResolvedValue([
      remoteOkJob({ apply_url: "https://jobs.lever.co/exampleco/1" }),
      remoteOkJob({ id: "2", apply_url: "http://insecure.example.com/apply", salary_min: 0, salary_max: 0 }),
    ]);
    const { leads } = await searchRemoteOk({ query: "*", limit: 20 });
    expect(leads.map((lead) => lead.applyUrl)).toEqual(["https://jobs.lever.co/exampleco/1", SOURCE_URL]);
    expect(leads[1]?.salary).toBeUndefined();
  });

  it("filters the feed locally by query words, country, location and company", async () => {
    fetchMock.mockResolvedValue(feed());
    const ids = async (input: Record<string, unknown>) =>
      (await searchRemoteOk({ query: "security engineer", limit: 20, ...input })).leads.map((lead) => lead.sourceId);
    expect(await ids({})).toEqual(["1137694", "2", "3", "5"]);
    expect(await ids({ country: "US" })).toEqual(["1137694", "2", "5"]);
    expect(await ids({ location: "united" })).toEqual(["1137694"]);
    expect(await ids({ company: "other" })).toEqual(["5"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("pages the filtered matches and reports filtered totals", async () => {
    fetchMock.mockResolvedValue(feed());
    const result = await searchRemoteOk({ query: "security engineer", limit: 3, page: 2 });
    expect(result.leads.map((lead) => lead.sourceId)).toEqual(["5"]);
    expect(result.pagination).toMatchObject({ page: 2, pageSize: 3, returned: 1, total: 4, totalPages: 2, hasMore: false });
  });

  it("caches the feed for repeat searches until the cache is cleared", async () => {
    fetchMock.mockResolvedValue(feed());
    await searchRemoteOk({ query: "engineer", limit: 5 });
    await searchRemoteOk({ query: "analyst", limit: 5 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    clearLeadCache();
    await searchRemoteOk({ query: "analyst", limit: 5 });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("skips malformed rows with a notice but fails a feed with no readable rows", async () => {
    fetchMock.mockResolvedValueOnce([remoteOkLegal, remoteOkJob(), { id: "9" }]);
    const result = await searchRemoteOk({ query: "*", limit: 5 });
    expect(result.leads).toHaveLength(1);
    expect(result.limitations).toContain("1 malformed listing(s) in this response were skipped.");
    clearLeadCache();
    fetchMock.mockResolvedValueOnce([remoteOkLegal, { id: "9" }]);
    await expect(searchRemoteOk({ query: "*", limit: 5 })).rejects.toMatchObject({ code: "invalid_source_response" });
    clearLeadCache();
    fetchMock.mockResolvedValueOnce({ error: "rate limited" });
    await expect(searchRemoteOk({ query: "*", limit: 5 })).rejects.toMatchObject({ code: "invalid_source_response" });
  });
});
