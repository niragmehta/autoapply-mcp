import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanySchema } from "../src/domain/campaign.js";
import { JobSchema } from "../src/domain/job.js";
import { bambooHrAdapter } from "../src/sources/bambooHr.js";
import { bambooDetail, bambooList, bambooRow } from "./fixtures/bambooHr.js";
import { failure, json, redirect, stubRoutes, text } from "./fixtures/smbHttp.js";

const capturedAt = "2026-11-06T12:00:00.000Z";
const LIST = "https://acme.bamboohr.com/careers/list";
const DETAIL = "https://acme.bamboohr.com/careers/";

function company(overrides: Record<string, unknown> = {}) {
  return CompanySchema.parse({ name: "Example Co", ats: "bamboohr", board: "acme", ...overrides });
}

beforeEach(() => {
  vi.stubEnv("AUTOAPPLY_MIN_INTERVAL_MS", "0");
  vi.stubEnv("AUTOAPPLY_SMB_DETAIL_LIMIT", undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("BambooHR adapter", () => {
  it("lists postings and reads each detail for description, absolute date, pay and remote area", async () => {
    const calls = stubRoutes([[LIST, json(bambooList())], [`${DETAIL}363/detail`, json(bambooDetail())]]);
    const [job] = await bambooHrAdapter.listJobs(company(), capturedAt);
    expect(JobSchema.parse(job)).toMatchObject({
      ats: "bamboohr", board: "acme", externalId: "363", title: "Senior Platform Engineer",
      url: "https://acme.bamboohr.com/careers/363", applyUrl: "https://acme.bamboohr.com/careers/363",
      workplaceType: "remote", locationClass: "remote-us", country: "US",
      postedAt: "2026-08-31T00:00:00.000Z", employmentType: "full-time",
      compensation: { min: 180000, max: 210000, currency: "USD", period: "year", source: "ats-structured" },
    });
    expect(job?.descriptionText).toContain("Build reliable infrastructure");
    expect(calls.map((call) => call.url)).toEqual([LIST, `${DETAIL}363/detail`]);
  });

  it("maps locationType 0/2 to on-site and hybrid offices and keeps an office country", async () => {
    stubRoutes([
      [LIST, json(bambooList([
        bambooRow({ id: "1", locationType: "0", location: { city: "Toronto", state: "Ontario" }, atsLocation: null }),
        bambooRow({ id: "2", locationType: "2", location: { city: "San Francisco", state: "California" }, atsLocation: null }),
      ]))],
      [`${DETAIL}1/detail`, json(bambooDetail({ locationType: "0", location: { city: "Toronto", state: "Ontario", addressCountry: "Canada" }, atsLocation: null, compensation: null }))],
      [`${DETAIL}2/detail`, json(bambooDetail({ locationType: "2", location: { city: "San Francisco", state: "California", addressCountry: "United States" }, atsLocation: null, compensation: "Competitive" }))],
    ]);
    const jobs = await bambooHrAdapter.listJobs(company(), capturedAt);
    expect(jobs.map((job) => [job.workplaceType, job.locationClass, job.country])).toEqual([
      ["onsite", "canada", "CA"], ["hybrid", "bay-area", "US"],
    ]);
    expect(jobs[1]?.compensation).toBeNull();
  });

  it("keeps the listing row when one detail fails and skips postings BambooHR no longer reports open", async () => {
    stubRoutes([
      [LIST, json(bambooList([bambooRow({ id: "1" }), bambooRow({ id: "2" }), bambooRow({ id: "3" }), { id: "bad" }]))],
      [`${DETAIL}1/detail`, text("forbidden", 403)],
      [`${DETAIL}2/detail`, json(bambooDetail({ jobOpeningStatus: "Filled" }))],
      [`${DETAIL}3/detail`, json(bambooDetail())],
    ]);
    const jobs = await bambooHrAdapter.listJobs(company(), capturedAt);
    expect(jobs.map((job) => job.externalId)).toEqual(["1", "3"]);
    expect(jobs[0]?.descriptionText).toBe("");
    expect(jobs[0]?.locationClass).toBe("remote-us");
  });

  it("matches company.query locally before spending detail requests and honours the detail cap", async () => {
    vi.stubEnv("AUTOAPPLY_SMB_DETAIL_LIMIT", "1");
    const calls = stubRoutes([
      [LIST, json(bambooList([
        bambooRow({ id: "1", jobOpeningName: "Account Executive", departmentLabel: "Sales" }),
        bambooRow({ id: "2", jobOpeningName: "Security Engineer" }),
        bambooRow({ id: "3", jobOpeningName: "Platform Security Lead" }),
      ]))],
      [DETAIL, json(bambooDetail())],
    ]);
    const jobs = await bambooHrAdapter.listJobs(company({ query: "security" }), capturedAt);
    expect(jobs.map((job) => job.externalId)).toEqual(["2", "3"]);
    expect(calls.filter((call) => call.url.includes("/detail"))).toHaveLength(1);
    expect(jobs[1]?.descriptionText).toBe("");
  });

  it("reports an unknown tenant (marketing-site redirect) as not found and validates the board", async () => {
    stubRoutes([[LIST, redirect("https://www.bamboohr.com")]]);
    await expect(bambooHrAdapter.listJobs(company(), capturedAt)).rejects.toMatchObject({ code: "not_found" });
    expect(() => bambooHrAdapter.listUrl(company({ board: "https://acme.bamboohr.com" })))
      .toThrow(/tenant subdomain.*e\.g\. "acme"/);
  });

  it("verifies with the single list request and probes the tenant list endpoint", async () => {
    const calls = stubRoutes([[LIST, json(bambooList([bambooRow(), bambooRow({ id: "2", jobOpeningName: "Designer" })]))]]);
    expect(await bambooHrAdapter.verifyBoard!(company())).toMatchObject({ ok: true, postings: 2, sampleTitles: ["Senior Platform Engineer", "Designer"] });
    expect(calls).toHaveLength(1);
    expect(bambooHrAdapter.probeUrls("Acme")).toEqual([LIST]);
    expect(bambooHrAdapter.probeUrls("Acme Corp")).toEqual([]);
  });

  it("parses share, detail and legacy posting URLs", () => {
    const parse = (url: string) => bambooHrAdapter.parsePostingUrl!(new URL(url));
    expect(parse("https://acme.bamboohr.com/careers/363")).toEqual({ board: "acme", externalId: "363" });
    expect(parse("https://acme.bamboohr.com/careers/363/detail")).toEqual({ board: "acme", externalId: "363" });
    expect(parse("https://acme.bamboohr.com/jobs/view.php?id=42")).toEqual({ board: "acme", externalId: "42" });
    expect(parse("https://www.bamboohr.com/careers/363")).toBeNull();
    expect(parse("https://acme.bamboohr.com/careers")).toBeNull();
  });

  it("fetches one posting and returns null once BambooHR no longer has it", async () => {
    stubRoutes([[`${DETAIL}363/detail`, json(bambooDetail())], [`${DETAIL}9/detail`, json({ type: "not_found" }, 404)]]);
    expect((await bambooHrAdapter.fetchPosting!(company(), "363", capturedAt))?.title).toBe("Senior Platform Engineer");
    expect(await bambooHrAdapter.fetchPosting!(company(), "9", capturedAt)).toBeNull();
  });

  it("checks liveness: open, closed for 404 or a non-open status, unknown for other failures", async () => {
    const job = JobSchema.parse({
      id: "job_1", fingerprint: "f", ats: "bamboohr", companyName: "Example Co", board: "acme", externalId: "363",
      title: "Engineer", locationClass: "unknown", url: "https://acme.bamboohr.com/careers/363", applyUrl: "", capturedAt,
    });
    stubRoutes([[`${DETAIL}363/detail`, json(bambooDetail())]]);
    expect(await bambooHrAdapter.checkPosting!(job)).toMatchObject({ status: "open", via: "api" });
    stubRoutes([[`${DETAIL}363/detail`, json({ type: "not_found" }, 404)]]);
    expect((await bambooHrAdapter.checkPosting!(job)).status).toBe("closed");
    stubRoutes([[`${DETAIL}363/detail`, json(bambooDetail({ jobOpeningStatus: "Closed" }))]]);
    expect((await bambooHrAdapter.checkPosting!(job)).status).toBe("closed");
    stubRoutes([[`${DETAIL}363/detail`, text("denied", 403)]]);
    expect((await bambooHrAdapter.checkPosting!(job)).status).toBe("unknown");
    stubRoutes([[`${DETAIL}363/detail`, () => failure()]]);
    expect((await bambooHrAdapter.checkPosting!(job)).status).toBe("unknown");
  });
});
