import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanySchema } from "../src/domain/campaign.js";
import { JobSchema } from "../src/domain/job.js";
import { breezyAdapter } from "../src/sources/breezy.js";
import { breezyPage, breezyPosition } from "./fixtures/breezy.js";
import { json, stubRoutes, text } from "./fixtures/smbHttp.js";

const capturedAt = "2026-11-06T12:00:00.000Z";
const FEED = "https://acme.breezy.hr/json";
const PAGE = "https://acme.breezy.hr/p/";

function company(overrides: Record<string, unknown> = {}) {
  return CompanySchema.parse({ name: "Example Co", ats: "breezy", board: "acme", ...overrides });
}

function storedJob(externalId = "016614959b60") {
  return JobSchema.parse({
    id: "job_1", fingerprint: "f", ats: "breezy", companyName: "Example Co", board: "acme", externalId,
    title: "Platform Engineer", locationClass: "unknown", url: `${PAGE}${externalId}`, applyUrl: "", capturedAt,
  });
}

beforeEach(() => vi.stubEnv("AUTOAPPLY_MIN_INTERVAL_MS", "0"));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Breezy adapter", () => {
  it("normalizes the feed with the posting page's description, earliest date and structured pay", async () => {
    stubRoutes([[FEED, json([breezyPosition()])], [`${PAGE}016614959b60-platform-engineer`, text(breezyPage())]]);
    const [job] = await breezyAdapter.listJobs(company(), capturedAt);
    expect(JobSchema.parse(job)).toMatchObject({
      externalId: "016614959b60", url: `${PAGE}016614959b60-platform-engineer`,
      locationClass: "us-other", country: "US", postedAt: "2026-07-17T00:00:00.000Z", employmentType: "full-time",
      compensation: { min: 80000, max: 102000, currency: "USD", period: "year", source: "ats-structured" },
    });
    expect(job?.locationsRaw).toEqual(["Dallas, TX, United States"]);
    expect(job?.descriptionText).toContain("Operate dependable infrastructure.");
  });

  it("falls back to the feed's pay text without assuming a period, and reads remote-only locations", async () => {
    const remote = { name: "Remote", country: { name: "Canada", id: "CA" }, is_remote: true };
    stubRoutes([
      [FEED, json([breezyPosition({ salary: "$80,000 – $102,000", location: remote, locations: [remote] })])],
      [PAGE, text("<html>no metadata</html>")],
    ]);
    const [job] = await breezyAdapter.listJobs(company(), capturedAt);
    expect(job).toMatchObject({ workplaceType: "remote", locationClass: "remote-canada", country: "CA" });
    expect(job?.compensation).toMatchObject({ min: 80000, max: 102000, currency: "CAD", period: "unknown" });
    expect(job?.postedAt).toBe("2026-11-05T20:16:02.931Z");
  });

  it("skips malformed positions, never fetches pages off the tenant host, and filters by query", async () => {
    const calls = stubRoutes([
      [FEED, json([
        breezyPosition({ id: "aaaaaaaaaaaa", name: "Security Engineer", url: "https://evil.example/p/x" }),
        breezyPosition({ id: "bbbbbbbbbbbb", name: "Office Manager", department: "Operations" }),
        { id: "../escape", name: "Broken" },
      ])],
      [PAGE, text(breezyPage())],
    ]);
    const jobs = await breezyAdapter.listJobs(company({ query: "security" }), capturedAt);
    expect(jobs.map((job) => job.externalId)).toEqual(["aaaaaaaaaaaa"]);
    expect(jobs[0]?.url).toBe("https://acme.breezy.hr/p/016614959b60-platform-engineer");
    expect(calls.every((call) => new URL(call.url).hostname === "acme.breezy.hr")).toBe(true);
  });

  it("reports an unknown tenant as not found and validates board tokens", async () => {
    stubRoutes([[FEED, text("Career portal not found", 404)]]);
    await expect(breezyAdapter.verifyBoard!(company())).rejects.toMatchObject({ code: "not_found" });
    expect(() => breezyAdapter.listUrl(company({ board: "acme/p" }))).toThrow(/invalid_board|breezy\.hr, e\.g\. "acme"/);
  });

  it("verifies from the feed alone and probes the tenant JSON feed", async () => {
    const calls = stubRoutes([[FEED, json([breezyPosition(), breezyPosition({ id: "cccccccccccc", name: "Designer" })])]]);
    expect(await breezyAdapter.verifyBoard!(company())).toMatchObject({ ok: true, postings: 2 });
    expect(calls).toHaveLength(1);
    expect(breezyAdapter.probeUrls("47-Degrees")).toEqual(["https://47-degrees.breezy.hr/json"]);
  });

  it("parses posting URLs to the 12-character id", () => {
    const parse = (url: string) => breezyAdapter.parsePostingUrl!(new URL(url));
    expect(parse("https://acme.breezy.hr/p/016614959b60-platform-engineer")).toEqual({ board: "acme", externalId: "016614959b60" });
    expect(parse("https://acme.breezy.hr/p/016614959b60-platform-engineer/apply")).toEqual({ board: "acme", externalId: "016614959b60" });
    expect(parse("https://acme.breezy.hr/")).toBeNull();
    expect(parse("https://breezy.hr/p/016614959b60")).toBeNull();
  });

  it("fetches one posting and returns null once the feed no longer lists it", async () => {
    stubRoutes([[FEED, json([breezyPosition()])], [PAGE, text(breezyPage())]]);
    expect((await breezyAdapter.fetchPosting!(company(), "016614959b60", capturedAt))?.title).toBe("Platform Engineer");
    expect(await breezyAdapter.fetchPosting!(company(), "ffffffffffff", capturedAt)).toBeNull();
  });

  it("checks liveness against the complete feed: listed is open, absent is closed, failures unknown", async () => {
    stubRoutes([[FEED, json([breezyPosition()])]]);
    expect((await breezyAdapter.checkPosting!(storedJob())).status).toBe("open");
    expect((await breezyAdapter.checkPosting!(storedJob("ffffffffffff"))).status).toBe("closed");
    stubRoutes([[FEED, text("denied", 403)]]);
    expect((await breezyAdapter.checkPosting!(storedJob())).status).toBe("unknown");
  });
});
