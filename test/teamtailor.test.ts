import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanySchema } from "../src/domain/campaign.js";
import { JobSchema } from "../src/domain/job.js";
import { teamtailorAdapter } from "../src/sources/teamtailor.js";
import { json, stubRoutes, text } from "./fixtures/smbHttp.js";
import { teamtailorFeed, teamtailorItem } from "./fixtures/teamtailor.js";

const capturedAt = "2026-11-06T12:00:00.000Z";
const FEED = "https://acme.teamtailor.com/jobs.json";
const NA_FEED = "https://acme.na.teamtailor.com/jobs.json";

function company(overrides: Record<string, unknown> = {}) {
  return CompanySchema.parse({ name: "Example Co", ats: "teamtailor", board: "acme", ...overrides });
}

function storedJob(externalId = "8483649") {
  return JobSchema.parse({
    id: "job_1", fingerprint: "f", ats: "teamtailor", companyName: "Example Co", board: "acme", externalId,
    title: "Platform Engineer", locationClass: "unknown", url: "", applyUrl: "", capturedAt,
  });
}

beforeEach(() => vi.stubEnv("AUTOAPPLY_MIN_INTERVAL_MS", "0"));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Teamtailor adapter", () => {
  it("normalizes the JSON feed's text, schema.org location, date and published pay", async () => {
    stubRoutes([[FEED, json(teamtailorFeed([teamtailorItem({}, {
      baseSalary: { "@type": "MonetaryAmount", currency: "CAD", value: { "@type": "QuantitativeValue", minValue: 120000, maxValue: 150000, unitText: "YEAR" } },
    })]))]]);
    const [job] = await teamtailorAdapter.listJobs(company(), capturedAt);
    expect(JobSchema.parse(job)).toMatchObject({
      externalId: "8483649", url: "https://acme.teamtailor.com/jobs/8483649-platform-engineer",
      locationClass: "canada", country: "CA", postedAt: "2026-10-01T08:01:45.000Z", employmentType: "full_time",
      compensation: { min: 120000, max: 150000, currency: "CAD", period: "year", source: "ats-structured" },
    });
    expect(job?.descriptionText).toContain("Example Co builds document tools.");
  });

  it("marks telecommute postings remote and keeps foreign-only roles out of North American classes", async () => {
    stubRoutes([[FEED, json(teamtailorFeed([
      teamtailorItem({ id: "a", url: "https://acme.teamtailor.com/jobs/1-a" }, {
        identifier: { value: "1" }, jobLocationType: "TELECOMMUTE", applicantLocationRequirements: { "@type": "Country", name: "Spain" },
        jobLocation: [{ "@type": "Place", address: { addressLocality: "Madrid", addressCountry: "ES" } }],
      }),
      teamtailorItem({ id: "b", url: "https://careers.example.com/jobs/2-b", title: "Sales Lead" }, { identifier: { value: "2" } }),
      { id: "broken" },
    ]))]]);
    const jobs = await teamtailorAdapter.listJobs(company(), capturedAt);
    expect(jobs.map((job) => [job.externalId, job.workplaceType, job.locationClass])).toEqual([
      ["1", "remote", "other"], ["2", "unknown", "canada"],
    ]);
    expect(jobs[1]?.url).toBe("https://careers.example.com/jobs/2-b");
  });

  it("follows same-host next pages and rejects a next page on another host", async () => {
    stubRoutes([
      [`${FEED}?page=2`, json(teamtailorFeed([teamtailorItem({ id: "2", title: "Data Engineer" }, { identifier: { value: "2" } })]))],
      [FEED, json(teamtailorFeed([teamtailorItem()], { next_url: `${FEED}?page=2` }))],
    ]);
    expect((await teamtailorAdapter.verifyBoard!(company())).postings).toBe(2);
    stubRoutes([[FEED, json(teamtailorFeed([teamtailorItem()], { next_url: "https://evil.example/jobs.json" }))]]);
    await expect(teamtailorAdapter.verifyBoard!(company())).rejects.toMatchObject({ code: "source_host_not_allowed" });
  });

  it("retries a bare slug on the North American host, and reads explicit .na boards directly", async () => {
    const calls = stubRoutes([[FEED, text("Teamtailor — 404", 404)], [NA_FEED, json(teamtailorFeed([teamtailorItem()]))]]);
    expect(await teamtailorAdapter.listJobs(company(), capturedAt)).toHaveLength(1);
    expect(calls.map((call) => call.url)).toEqual([FEED, NA_FEED]);
    const direct = stubRoutes([[NA_FEED, json(teamtailorFeed([]))]]);
    expect(await teamtailorAdapter.listJobs(company({ board: "acme.na" }), capturedAt)).toEqual([]);
    expect(direct.map((call) => call.url)).toEqual([NA_FEED]);
    expect(() => teamtailorAdapter.listUrl(company({ board: "acme.eu" }))).toThrow(/"<slug>\.na"/);
  });

  it("probes both regions and parses posting URLs", () => {
    expect(teamtailorAdapter.probeUrls("Acme")).toEqual([FEED, NA_FEED]);
    const parse = (url: string) => teamtailorAdapter.parsePostingUrl!(new URL(url));
    expect(parse("https://acme.teamtailor.com/jobs/8483649-platform-engineer")).toEqual({ board: "acme", externalId: "8483649" });
    expect(parse("https://acme.na.teamtailor.com/en-US/jobs/733096-x")).toEqual({ board: "acme.na", externalId: "733096" });
    expect(parse("https://acme.teamtailor.com/jobs")).toBeNull();
    expect(parse("https://careers.example.com/jobs/8483649-x")).toBeNull();
  });

  it("fetches and checks postings against the complete feed", async () => {
    stubRoutes([[FEED, json(teamtailorFeed([teamtailorItem()]))]]);
    expect((await teamtailorAdapter.fetchPosting!(company(), "8483649", capturedAt))?.title).toBe("Platform Engineer");
    expect(await teamtailorAdapter.fetchPosting!(company(), "1", capturedAt)).toBeNull();
    expect((await teamtailorAdapter.checkPosting!(storedJob())).status).toBe("open");
    expect((await teamtailorAdapter.checkPosting!(storedJob("1"))).status).toBe("closed");
    stubRoutes([[FEED, text("denied", 403)]]);
    expect((await teamtailorAdapter.checkPosting!(storedJob())).status).toBe("unknown");
  });
});
