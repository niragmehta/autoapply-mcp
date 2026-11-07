import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanySchema } from "../src/domain/campaign.js";
import { JobSchema } from "../src/domain/job.js";
import { doverAdapter } from "../src/sources/dover.js";
import { DOVER_CLIENT, DOVER_JOB, doverDetail, doverJob, doverPage, doverSlug } from "./fixtures/dover.js";
import { json, stubRoutes, text } from "./fixtures/smbHttp.js";

const capturedAt = "2026-11-06T12:00:00.000Z";
const SLUG = "https://app.dover.com/api/v1/careers-page-slug/acme";
const LIST = `https://app.dover.com/api/v1/careers-page/${DOVER_CLIENT}/jobs?limit=300&offset=`;
const DETAIL = "https://app.dover.com/api/v1/inbound/application-portal-job/";
const SECOND = "b47ec382-8577-49e6-be6e-b790bcdc8773";

function company(overrides: Record<string, unknown> = {}) {
  return CompanySchema.parse({ name: "Example Co", ats: "dover", board: "acme", ...overrides });
}

function storedJob() {
  return JobSchema.parse({
    id: "job_1", fingerprint: "f", ats: "dover", companyName: "Example Co", board: "acme", externalId: DOVER_JOB,
    title: "Software Engineer - AI", locationClass: "unknown", url: "", applyUrl: "", capturedAt,
  });
}

beforeEach(() => vi.stubEnv("AUTOAPPLY_MIN_INTERVAL_MS", "0"));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Dover adapter", () => {
  it("resolves the slug, lists jobs and reads each detail", async () => {
    stubRoutes([[SLUG, json(doverSlug())], [`${LIST}0`, json(doverPage([doverJob()]))], [`${DETAIL}${DOVER_JOB}`, json(doverDetail())]]);
    const [job] = await doverAdapter.listJobs(company(), capturedAt);
    expect(JobSchema.parse(job)).toMatchObject({
      externalId: DOVER_JOB, url: `https://app.dover.com/apply/acme/${DOVER_JOB}`, workplaceType: "hybrid",
      locationClass: "bay-area", postedAt: "2024-04-18T23:20:44.866Z", employmentType: "full_time",
      compensation: { min: 120000, max: 190000, currency: "USD", period: "year", source: "ats-structured" },
    });
    expect(job?.locationsRaw).toEqual(["Remote (Canada)", "Remote (United States)", "San Mateo, CA (Hybrid)"]);
    expect(job?.descriptionText).toContain("Build AI-native learning tools.");
  });

  it("drops sample, unpublished, inactive and private jobs, hides unshared pay and ignores region placeholders", async () => {
    const international = [{ location_type: "REMOTE", location_option: { display_name: "International", location_type: "REGION", country: "US" } }];
    stubRoutes([
      [SLUG, json(doverSlug())],
      [`${LIST}0`, json(doverPage([
        doverJob(),
        doverJob({ id: SECOND, title: "Designer", locations: international }),
        doverJob({ id: "00000000-0000-4000-8000-000000000001", is_sample: true }),
        doverJob({ id: "00000000-0000-4000-8000-000000000002", is_published: false }),
      ]))],
      [`${DETAIL}${DOVER_JOB}`, json(doverDetail({ is_private: true }))],
      [`${DETAIL}${SECOND}`, json(doverDetail({
        id: SECOND, title: "Designer", locations: international, workplace_type: "REMOTE",
        compensation: { lower_bound: 90000, upper_bound: 110000, currency_code: "USD", open_to_sharing_comp: false },
      }))],
    ]);
    const jobs = await doverAdapter.listJobs(company(), capturedAt);
    expect(jobs.map((job) => job.externalId)).toEqual([SECOND]);
    expect(jobs[0]).toMatchObject({ locationsRaw: ["Remote (Worldwide)"], country: "unknown", locationClass: "remote-global" });
    expect(jobs[0]?.compensation).toBeNull();
  });

  it("follows offset pagination while full pages report a next link", async () => {
    const fullPage = Array.from({ length: 300 }, (_, index) => doverJob({ id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`, title: "Generalist" }));
    const calls = stubRoutes([
      [SLUG, json(doverSlug())],
      [`${LIST}0`, json(doverPage(fullPage, "https://app.dover.com/next"))],
      [`${LIST}300`, json(doverPage([doverJob({ title: "Security Engineer" })]))],
    ]);
    expect((await doverAdapter.verifyBoard!(company())).postings).toBe(301);
    expect(calls.map((call) => call.url)).toEqual([SLUG, `${LIST}0`, `${LIST}300`]);
  });

  it("reports unknown slugs as not found and probes the slug endpoint", async () => {
    stubRoutes([[SLUG, json({ detail: "Not found." }, 404)]]);
    await expect(doverAdapter.listJobs(company(), capturedAt)).rejects.toMatchObject({ code: "not_found" });
    expect(doverAdapter.probeUrls("acme")).toEqual([SLUG]);
    expect(doverAdapter.probeUrls("acme corp")).toEqual([]);
    expect(() => doverAdapter.listUrl(company({ board: "acme/careers" }))).toThrow(/apply\/<slug>/);
  });

  it("parses apply URLs", () => {
    const parse = (url: string) => doverAdapter.parsePostingUrl!(new URL(url));
    expect(parse(`https://app.dover.com/apply/acme/${DOVER_JOB}?rs=1`)).toEqual({ board: "acme", externalId: DOVER_JOB });
    expect(parse("https://app.dover.com/apply/acme/not-a-uuid")).toBeNull();
    expect(parse(`https://jobs.example.com/apply/acme/${DOVER_JOB}`)).toBeNull();
  });

  it("fetches and checks one job through its detail endpoint", async () => {
    stubRoutes([[`${DETAIL}${DOVER_JOB}`, json(doverDetail())]]);
    expect((await doverAdapter.fetchPosting!(company(), DOVER_JOB, capturedAt))?.title).toBe("Software Engineer - AI");
    expect((await doverAdapter.checkPosting!(storedJob())).status).toBe("open");
    stubRoutes([[`${DETAIL}${DOVER_JOB}`, json(doverDetail({ active: false }))]]);
    expect(await doverAdapter.fetchPosting!(company(), DOVER_JOB, capturedAt)).toBeNull();
    expect((await doverAdapter.checkPosting!(storedJob())).status).toBe("closed");
    stubRoutes([[`${DETAIL}${DOVER_JOB}`, json({ detail: "Not found." }, 404)]]);
    expect(await doverAdapter.fetchPosting!(company(), DOVER_JOB, capturedAt)).toBeNull();
    expect((await doverAdapter.checkPosting!(storedJob())).status).toBe("closed");
    stubRoutes([[`${DETAIL}${DOVER_JOB}`, text("denied", 403)]]);
    expect((await doverAdapter.checkPosting!(storedJob())).status).toBe("unknown");
  });
});
