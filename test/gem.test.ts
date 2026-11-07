import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanySchema } from "../src/domain/campaign.js";
import { JobSchema } from "../src/domain/job.js";
import { gemAdapter } from "../src/sources/gem.js";
import { gemPost } from "./fixtures/gem.js";
import { json, stubRoutes, text } from "./fixtures/smbHttp.js";

const capturedAt = "2026-11-06T12:00:00.000Z";
const API = "https://api.gem.com/job_board/v0/acme/job_posts/";

function company(overrides: Record<string, unknown> = {}) {
  return CompanySchema.parse({ name: "Example Co", ats: "gem", board: "acme", ...overrides });
}

function storedJob() {
  return JobSchema.parse({
    id: "job_1", fingerprint: "f", ats: "gem", companyName: "Example Co", board: "acme", externalId: "4003629005",
    title: "Software Engineer", locationClass: "unknown", url: "", applyUrl: "", capturedAt,
  });
}

beforeEach(() => vi.stubEnv("AUTOAPPLY_MIN_INTERVAL_MS", "0"));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Gem adapter", () => {
  it("reads every post with its description from one documented request", async () => {
    const calls = stubRoutes([[API, json([gemPost(), gemPost({ id: "4605533005", title: "Staff Engineer", location_type: "remote", location: { name: "Remote, United States" }, offices: [] })])]]);
    const jobs = await gemAdapter.listJobs(company(), capturedAt);
    expect(calls).toHaveLength(1);
    expect(JobSchema.parse(jobs[0])).toMatchObject({
      externalId: "4003629005", url: "https://jobs.gem.com/acme/4003629005", workplaceType: "hybrid",
      locationClass: "bay-area", postedAt: "2022-03-25T18:46:39.000Z", employmentType: "full_time",
      compensation: { min: 163800, max: 306000, currency: "USD" },
    });
    expect(jobs[1]).toMatchObject({ workplaceType: "remote", locationClass: "remote-us" });
  });

  it("rebuilds off-host links, skips malformed posts and filters by title or department", async () => {
    stubRoutes([[API, json([
      gemPost({ absolute_url: "https://evil.example/acme/1", title: "Security Engineer" }),
      gemPost({ id: "2", title: "Recruiter", departments: [{ name: "People" }] }),
      { id: "", title: "" },
    ])]]);
    const jobs = await gemAdapter.listJobs(company({ query: "security" }), capturedAt);
    expect(jobs.map((job) => job.url)).toEqual(["https://jobs.gem.com/acme/4003629005"]);
  });

  it("reports unknown boards as not found, verifies with one request and probes the API", async () => {
    stubRoutes([[API, json({ code: 404, message: "Job board with vanity URL path acme not found" }, 404)]]);
    await expect(gemAdapter.verifyBoard!(company())).rejects.toMatchObject({ code: "not_found" });
    stubRoutes([[API, json([gemPost()])]]);
    expect(await gemAdapter.verifyBoard!(company())).toMatchObject({ ok: true, postings: 1, sampleTitles: ["Software Engineer"] });
    expect(gemAdapter.probeUrls("Acme")).toEqual([API]);
    expect(() => gemAdapter.listUrl(company({ board: "jobs.gem.com/acme" }))).toThrow(/jobs\.gem\.com\/<board>/);
  });

  it("parses posting URLs", () => {
    const parse = (url: string) => gemAdapter.parsePostingUrl!(new URL(url));
    expect(parse("https://jobs.gem.com/acme/4003629005")).toEqual({ board: "acme", externalId: "4003629005" });
    expect(parse("https://jobs.gem.com/acme/am9icG9zdDrmEc_QDH2AJLVNz4fQpF5Q")).toEqual({ board: "acme", externalId: "am9icG9zdDrmEc_QDH2AJLVNz4fQpF5Q" });
    expect(parse("https://jobs.gem.com/acme")).toBeNull();
    expect(parse("https://jobs.gem.com/acme/1/apply")).toBeNull();
  });

  it("fetches and checks one post through the documented single-post endpoint", async () => {
    stubRoutes([[`${API}4003629005`, json(gemPost())]]);
    expect((await gemAdapter.fetchPosting!(company(), "4003629005", capturedAt))?.title).toBe("Software Engineer");
    expect((await gemAdapter.checkPosting!(storedJob())).status).toBe("open");
    stubRoutes([[`${API}4003629005`, json({ code: 404, message: "Job post with ID 4003629005 not found" }, 404)]]);
    expect(await gemAdapter.fetchPosting!(company(), "4003629005", capturedAt)).toBeNull();
    expect((await gemAdapter.checkPosting!(storedJob())).status).toBe("closed");
    stubRoutes([[`${API}4003629005`, text("<html>login</html>")]]);
    expect((await gemAdapter.checkPosting!(storedJob())).status).toBe("unknown");
  });
});
