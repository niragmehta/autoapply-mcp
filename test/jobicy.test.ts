import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchJson } from "../src/sources/http.js";
import { clearLeadCache } from "../src/sources/leads/common.js";
import { searchJobicy } from "../src/sources/leads/jobicy.js";
import { jobicyJob, jobicyPage } from "./fixtures/jobicy.js";

vi.mock("../src/sources/http.js", () => ({ fetchJson: vi.fn(), fetchText: vi.fn(), userAgent: () => "autoapply-test" }));
const fetchMock = vi.mocked(fetchJson);
const JOB_URL = "https://jobicy.com/jobs/159403-software-engineer-ii-mobile";

function byCursor(pages: Record<string, unknown>) {
  fetchMock.mockImplementation(async (url: string) => pages[new URL(url).searchParams.get("cursor") ?? "first"]);
}

beforeEach(() => {
  fetchMock.mockReset();
  clearLeadCache();
});

describe("Jobicy lead source", () => {
  it("maps query, country and category to Jobicy filters and keeps the Jobicy URL as the apply link", async () => {
    fetchMock.mockResolvedValue(jobicyPage([
      jobicyJob(),
      jobicyJob({ id: 159412, jobTitle: "Sr. Product Marketing Manager", jobIndustry: ["Marketing &amp; Sales"] }),
    ]));
    const result = await searchJobicy({ query: "engineer", country: "US", category: "engineering", limit: 20 });
    const endpoint = "https://jobicy.com/api/jobs?count=50&tag=engineer&geo=usa&industry=engineering";
    expect(fetchMock).toHaveBeenCalledWith(endpoint, { allowedHosts: ["jobicy.com"], minIntervalMs: 700 });
    expect(result.leads).toHaveLength(1);
    expect(result.leads[0]).toMatchObject({
      source: "jobicy", sourceId: "159403", sourceUrl: JOB_URL, applyUrl: JOB_URL,
      title: "Software Engineer II (Mobile \u2013 Android)", company: "Zone & Co",
      locations: ["Remote — USA"], locationRestrictions: ["USA"],
      salary: { min: 116000, max: 174000, currency: "USD", period: "yearly", provenance: "aggregator" },
      publishedAt: "2026-11-06T17:06:42.000Z",
      provenance: { kind: "aggregator", endpoint, publishedAtRaw: "2026-11-06T10:06:42-07:00" },
      mustVerifyEmployer: true,
    });
    expect(result.pagination).toMatchObject({ page: 1, returned: 1, hasMore: false });
    expect(result.limitations.join(" ")).toMatch(/did not match the query/);
    expect(result.attribution.requirements.join(" ")).toMatch(/original Jobicy job URL/);
  });

  it("replays cursors for later pages and stops when the cursor runs out", async () => {
    byCursor({
      first: jobicyPage([jobicyJob()], "c1"),
      c1: jobicyPage([jobicyJob({ id: 2, url: "https://jobicy.com/jobs/2-platform-engineer", jobTitle: "Platform Engineer" })], "c2"),
      c2: jobicyPage([jobicyJob({ id: 3, url: "https://jobicy.com/jobs/3-data-engineer", jobTitle: "Data Engineer" })]),
    });
    const second = await searchJobicy({ query: "engineer", limit: 20, page: 2 });
    expect(second.leads.map((lead) => lead.sourceId)).toEqual(["2"]);
    expect(second.pagination).toMatchObject({ page: 2, hasMore: true, nextPage: 3 });
    expect(fetchMock.mock.calls.map(([url]) => new URL(url).searchParams.get("cursor"))).toEqual([null, "c1"]);
    const third = await searchJobicy({ query: "engineer", limit: 20, page: 3 });
    expect(third.leads.map((lead) => lead.sourceId)).toEqual(["3"]);
    expect(third.pagination.hasMore).toBe(false);
    const fourth = await searchJobicy({ query: "engineer", limit: 20, page: 4 });
    expect(fourth.leads).toEqual([]);
    expect(fourth.pagination.hasMore).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("truncates to the limit and points back at the same page", async () => {
    fetchMock.mockResolvedValue(jobicyPage([1, 2, 3].map((id) => jobicyJob({ id, url: `https://jobicy.com/jobs/${id}` }))));
    const result = await searchJobicy({ query: "*", limit: 2 });
    expect(result.leads).toHaveLength(2);
    expect(result.pagination).toMatchObject({ truncated: true, remainingOnPage: 1, nextPage: 1 });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://jobicy.com/api/jobs?count=50");
  });

  it("rejects unsupported pages, categories and countries before fetching", async () => {
    await expect(searchJobicy({ query: "engineer", limit: 5, page: 6 })).rejects.toMatchObject({ code: "source_filter_unsupported" });
    await expect(searchJobicy({ query: "engineer", category: "Dev & Ops", limit: 5 })).rejects.toMatchObject({ code: "source_filter_unsupported" });
    await expect(searchJobicy({ query: "engineer", country: "!!!", limit: 5 })).rejects.toMatchObject({ code: "source_filter_unsupported" });
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValue(jobicyPage([]));
    await searchJobicy({ query: "engineer", country: "Europe", limit: 5 });
    expect(new URL(fetchMock.mock.calls[0]![0]).searchParams.get("geo")).toBe("europe");
    await searchJobicy({ query: "engineer", country: "Canada", limit: 5 });
    expect(new URL(fetchMock.mock.calls[1]![0]).searchParams.get("geo")).toBe("canada");
  });
});
