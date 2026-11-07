import { beforeEach, describe, expect, it, vi } from "vitest";
import { fetchText } from "../src/sources/http.js";
import { clearLeadCache } from "../src/sources/leads/common.js";
import { parseWwrFeed, searchWeWorkRemotely } from "../src/sources/leads/weworkremotely.js";
import { wwrFeed, wwrItem } from "./fixtures/weworkremotely.js";

vi.mock("../src/sources/http.js", () => ({ fetchJson: vi.fn(), fetchText: vi.fn(), userAgent: () => "autoapply-test" }));
const fetchMock = vi.mocked(fetchText);
const JOB = "https://weworkremotely.com/remote-jobs/example-co-site-reliability-engineer";
const FEED = "https://weworkremotely.com/remote-jobs.rss";

function feed(): string {
  return wwrFeed([
    wwrItem({ title: "Example Co: Site Reliability Engineer", region: "USA Only", country: "🇺🇸 United States of America", skills: "kubernetes, aws" }),
    wwrItem({ title: "Other Inc: Senior Engineer, Platform", region: "Europe Only", link: "https://weworkremotely.com/remote-jobs/other-inc-senior-engineer" }),
    wwrItem({ title: "Expired Ltd: Site Reliability Engineer", link: "https://weworkremotely.com/remote-jobs/expired", expiresAt: "Wed, 02 Dec 2020 07:31:12 +0000" }),
    wwrItem({ title: "Data Engineer without a company prefix", link: "https://weworkremotely.com/remote-jobs/plain" }),
    wwrItem({ title: "Offsite Co: Engineer", link: "http://offsite.example.com/job" }),
  ]);
}

beforeEach(() => {
  fetchMock.mockReset();
  clearLeadCache();
});

describe("We Work Remotely lead source", () => {
  it("reads the RSS feed into linked, unverified leads with the company split from the title", async () => {
    fetchMock.mockResolvedValue(feed());
    const result = await searchWeWorkRemotely({ query: "engineer", country: "US", limit: 20 });
    expect(fetchMock).toHaveBeenCalledWith(FEED, {
      allowedHosts: ["weworkremotely.com"], accept: "application/rss+xml, application/xml", minIntervalMs: 700,
    });
    expect(result.leads.map((lead) => lead.sourceUrl)).toEqual([JOB, "https://weworkremotely.com/remote-jobs/plain"]);
    expect(result.leads[0]).toMatchObject({
      source: "weworkremotely", sourceId: JOB, title: "Site Reliability Engineer", company: "Example Co",
      locations: ["Remote — USA Only, United States of America"], locationRestrictions: ["USA Only", "United States of America"],
      publishedAt: "2026-11-02T07:31:12.000Z",
      provenance: { kind: "aggregator", endpoint: FEED, publishedAtRaw: "Mon, 02 Nov 2026 07:31:12 +0000" },
      mustVerifyEmployer: true,
    });
    expect(result.leads[0]?.description).toContain("<strong>Headquarters:</strong>");
    expect(result.leads[1]).toMatchObject({ title: "Data Engineer without a company prefix", company: "" });
    expect(result.limitations).toContain("1 malformed listing(s) in this response were skipped.");
    expect(result.attribution.requirements.join(" ")).toMatch(/link back/);
  });

  it("filters by query, location and company and drops expired listings", async () => {
    fetchMock.mockResolvedValue(feed());
    const titles = async (input: Record<string, unknown>) =>
      (await searchWeWorkRemotely({ query: "engineer", limit: 20, ...input })).leads.map((lead) => lead.company);
    expect(await titles({})).toEqual(["Example Co", "Other Inc", ""]);
    expect(await titles({ location: "europe" })).toEqual(["Other Inc"]);
    expect(await titles({ company: "example" })).toEqual(["Example Co"]);
    expect(await titles({ query: "kubernetes" })).toEqual(["Example Co"]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reads one category feed by slug and rejects anything else before fetching", async () => {
    fetchMock.mockResolvedValue(feed());
    await searchWeWorkRemotely({ query: "*", category: "remote-devops-sysadmin-jobs", limit: 5 });
    expect(fetchMock.mock.calls[0]?.[0]).toBe("https://weworkremotely.com/categories/remote-devops-sysadmin-jobs.rss");
    for (const category of ["../admin", "DevOps", "remote jobs"]) {
      await expect(searchWeWorkRemotely({ query: "*", category, limit: 5 })).rejects.toMatchObject({ code: "source_filter_unsupported" });
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("refuses feeds with entity declarations", () => {
    expect(() => parseWwrFeed(`<?xml version="1.0"?><!DOCTYPE rss [<!ENTITY x "boom">]><rss><channel><item><title>&x;</title></item></channel></rss>`))
      .toThrow(expect.objectContaining({ code: "unsafe_xml" }));
    expect(parseWwrFeed(wwrFeed([]))).toEqual([]);
  });
});
