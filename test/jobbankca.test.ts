import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchText } from "../src/sources/http.js";
import { clearLeadCache } from "../src/sources/leads/common.js";
import { parseJobBankFeed, searchJobBankCa } from "../src/sources/leads/jobbankca.js";
import { jobBankEntries, jobBankEntry, jobBankFeed } from "./fixtures/jobbankca.js";

vi.mock("../src/sources/http.js", () => ({ fetchJson: vi.fn(), fetchText: vi.fn(), userAgent: () => "autoapply-test" }));
const fetchMock = vi.mocked(fetchText);

beforeEach(() => {
  fetchMock.mockReset();
  clearLeadCache();
});

describe("Job Bank lead source", () => {
  it("reads one Atom feed page, five seconds apart, into Canadian leads", async () => {
    fetchMock.mockResolvedValue(jobBankFeed(Object.values(jobBankEntries).map(jobBankEntry)));
    const result = await searchJobBankCa({ query: "software developer", location: "Toronto", limit: 20 });
    const endpoint = "https://www.jobbank.gc.ca/jobsearch/feed/jobSearchRSSfeed?searchstring=software+developer&locationstring=Toronto&page=1";
    expect(fetchMock).toHaveBeenCalledWith(endpoint, {
      allowedHosts: ["www.jobbank.gc.ca"], accept: "application/atom+xml, application/xml", minIntervalMs: 5000,
    });
    expect(result.leads[0]).toMatchObject({
      source: "jobbankca", sourceId: "50678571", sourceUrl: "https://www.jobbank.gc.ca/jobsearch/jobposting/50678571",
      title: "software developer", company: "Example Marketing",
      locations: ["Toronto (ON), Canada"], locationRestrictions: ["Canada"],
      description: "Job number: 10319685093\nSalary: $55,000.00 to $65,000.00 annually",
      salary: { min: 55000, max: 65000, currency: "CAD", period: "annually", provenance: "aggregator" },
      publishedAt: "2026-11-06T14:00:00.000Z",
      provenance: { kind: "aggregator", endpoint, publishedAtRaw: "2026-11-06T14:00:00Z" },
      mustVerifyEmployer: true,
    });
    expect(result.leads[1]?.salary).toMatchObject({ min: 96000, max: 100000, period: "annually" });
    expect(result.leads[2]?.salary).toMatchObject({ min: 55.31, max: 55.31, period: "hourly" });
    expect(result.pagination).toMatchObject({ page: 1, returned: 3, hasMore: false });
    expect(result.limitations.join(" ")).toMatch(/prohibit automated access/);
    expect(result.attribution.requirements.join(" ")).toMatch(/Do not republish/);
  });

  it("serves Canada only and rejects any other country before fetching", async () => {
    await expect(searchJobBankCa({ query: "developer", country: "US", limit: 5 })).rejects.toMatchObject({ code: "source_filter_unsupported" });
    expect(fetchMock).not.toHaveBeenCalled();
    fetchMock.mockResolvedValue(jobBankFeed([]));
    const result = await searchJobBankCa({ query: "developer", country: "Canada", limit: 5 });
    expect(result.leads).toEqual([]);
    expect(fetchMock.mock.calls[0]?.[0]).toContain("locationstring=&page=1");
  });

  it("signals another page only when the feed page is full, and truncates to the limit", async () => {
    const entries = Array.from({ length: 100 }, (_, index) => jobBankEntry({ ...jobBankEntries.annual, posting: String(50000000 + index) }));
    fetchMock.mockResolvedValue(jobBankFeed(entries));
    const result = await searchJobBankCa({ query: "developer", limit: 10, page: 2 });
    expect(fetchMock.mock.calls[0]?.[0]).toContain("page=2");
    expect(result.leads).toHaveLength(10);
    expect(result.pagination).toMatchObject({ page: 2, truncated: true, remainingOnPage: 90, nextPage: 2, hasMore: true });
  });

  it("keeps only https Job Bank links and refuses entity declarations", async () => {
    const offsite = jobBankEntry(jobBankEntries.annual).replace("https://www.jobbank.gc.ca/jobsearch/jobposting", "https://example.com/jobposting");
    expect(parseJobBankFeed(jobBankFeed([offsite]))).toHaveLength(1);
    fetchMock.mockResolvedValue(jobBankFeed([offsite]));
    await expect(searchJobBankCa({ query: "developer", limit: 5 })).rejects.toMatchObject({ code: "invalid_source_response" });
    expect(() => parseJobBankFeed(`<?xml version="1.0"?><!DOCTYPE feed [<!ENTITY a "b">]><feed></feed>`)).toThrow(/DOCTYPE/);
  });
});
