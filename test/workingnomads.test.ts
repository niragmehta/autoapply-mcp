import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchJson } from "../src/sources/http.js";
import { clearLeadCache } from "../src/sources/leads/common.js";
import { searchWorkingNomads } from "../src/sources/leads/workingnomads.js";
import { nomadJob } from "./fixtures/workingnomads.js";

vi.mock("../src/sources/http.js", () => ({ fetchJson: vi.fn(), fetchText: vi.fn(), userAgent: () => "autoapply-test" }));
const fetchMock = vi.mocked(fetchJson);
const ENDPOINT = "https://www.workingnomads.com/api/exposed_jobs/";

function feed() {
  return [
    nomadJob(),
    nomadJob({ url: "https://www.workingnomads.com/job/go/2/", title: "AI Content Reviewer", category_name: "Administration", tags: "data,annotation", location: "Switzerland, Australia" }),
    nomadJob({ url: "https://www.workingnomads.com/job/go/3/", title: "Backend Engineer", company_name: "Other Inc", tags: "", location: "Anywhere" }),
    nomadJob({ url: "https://www.workingnomads.com/job/go/4/", title: "Platform Engineer", location: "" }),
    nomadJob({ url: "https://tracker.example.com/job/go/5/", title: "Tracked Engineer" }),
  ];
}

beforeEach(() => {
  fetchMock.mockReset();
  clearLeadCache();
});

describe("Working Nomads lead source", () => {
  it("reads the public feed into unverified leads without following its redirect links", async () => {
    fetchMock.mockResolvedValue(feed());
    const result = await searchWorkingNomads({ query: "engineer", limit: 20 });
    expect(fetchMock).toHaveBeenCalledWith(ENDPOINT, { allowedHosts: ["www.workingnomads.com"], minIntervalMs: 700 });
    expect(result.leads.map((lead) => lead.sourceId)).toEqual(["1996233", "3", "4"]);
    expect(result.leads[0]).toMatchObject({
      source: "workingnomads", sourceUrl: "https://www.workingnomads.com/job/go/1996233/",
      title: "Senior Site Reliability Engineer", company: "Example Co",
      locations: ["Remote — USA"], locationRestrictions: ["USA"],
      publishedAt: "2026-11-05T08:10:45.000Z",
      provenance: { kind: "aggregator", endpoint: ENDPOINT, publishedAtRaw: "2026-11-05T01:10:45-07:00" },
      mustVerifyEmployer: true,
    });
    expect(result.leads[0]).not.toHaveProperty("applyUrl");
    expect(result.leads[2]?.locations).toEqual(["Remote — location restrictions unspecified"]);
    expect(result.limitations).toContain("1 malformed listing(s) in this response were skipped.");
    expect(result.attribution.requirements.join(" ")).toMatch(/Do not republish/);
  });

  it("filters by tags, category, country, location and company locally", async () => {
    fetchMock.mockResolvedValue(feed());
    const ids = async (input: Record<string, unknown>) =>
      (await searchWorkingNomads({ query: "*", limit: 20, ...input })).leads.map((lead) => lead.sourceId);
    expect(await ids({ query: "kubernetes" })).toEqual(["1996233", "4"]);
    expect(await ids({ category: "administration" })).toEqual(["2"]);
    expect(await ids({ country: "US" })).toEqual(["1996233", "3", "4"]);
    expect(await ids({ location: "australia" })).toEqual(["2"]);
    expect(await ids({ company: "other" })).toEqual(["3"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a feed that is not a list", async () => {
    fetchMock.mockResolvedValue({ detail: "Not found." });
    await expect(searchWorkingNomads({ query: "*", limit: 5 })).rejects.toMatchObject({ code: "invalid_source_response" });
  });
});
