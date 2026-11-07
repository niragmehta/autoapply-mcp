import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanySchema } from "../src/domain/campaign.js";
import { JobSchema } from "../src/domain/job.js";
import { pinpointAdapter } from "../src/sources/pinpoint.js";
import { PINPOINT_DEMO_DESCRIPTION, PINPOINT_UUID, pinpointPage, pinpointPosting } from "./fixtures/pinpoint.js";
import { json, stubRoutes, text } from "./fixtures/smbHttp.js";

const capturedAt = "2026-11-06T12:00:00.000Z";
const FEED = "https://acme.pinpointhq.com/postings.json";
const PAGE = `https://acme.pinpointhq.com/en/postings/${PINPOINT_UUID}`;
const OTHER = "7f0d1270-7754-4346-9c73-1fe45e086258";

function company(overrides: Record<string, unknown> = {}) {
  return CompanySchema.parse({ name: "Example Co", ats: "pinpoint", board: "acme", ...overrides });
}

function storedJob(externalId = PINPOINT_UUID) {
  return JobSchema.parse({
    id: "job_1", fingerprint: "f", ats: "pinpoint", companyName: "Example Co", board: "acme", externalId,
    title: "Senior Test Engineer", locationClass: "unknown", url: "", applyUrl: "", capturedAt,
  });
}

beforeEach(() => {
  vi.stubEnv("AUTOAPPLY_MIN_INTERVAL_MS", "0");
  vi.stubEnv("AUTOAPPLY_SMB_DETAIL_LIMIT", undefined);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Pinpoint adapter", () => {
  it("normalizes feed text and structured pay, with the page's date and country", async () => {
    stubRoutes([[FEED, json({ data: [pinpointPosting()] })], [PAGE, text(pinpointPage())]]);
    const [job] = await pinpointAdapter.listJobs(company(), capturedAt);
    expect(JobSchema.parse(job)).toMatchObject({
      externalId: PINPOINT_UUID, url: PAGE, workplaceType: "onsite", locationClass: "us-other", country: "US",
      postedAt: "2025-01-23T17:54:48.000Z", employmentType: "full time",
      compensation: { min: 110000, max: 180000, currency: "USD", period: "year", source: "ats-structured" },
    });
    expect(job?.locationsRaw).toEqual(["Redondo Beach, California"]);
    expect(job?.descriptionText).toContain("Design test systems");
    expect(job?.descriptionText).toContain("Minimum Qualifications");
  });

  it("drops seeded demo postings and passed deadlines, hides invisible pay, and keeps rows past the detail cap", async () => {
    vi.stubEnv("AUTOAPPLY_SMB_DETAIL_LIMIT", "0");
    const calls = stubRoutes([[FEED, json({ data: [
      pinpointPosting({ title: "Head of DEI - UK", description: PINPOINT_DEMO_DESCRIPTION }),
      pinpointPosting({ deadline_at: "2026-01-01T00:00:00Z" }),
      pinpointPosting({ path: `/en/postings/${OTHER}`, url: null, compensation_visible: false, title: "Test Technician" }),
      { title: "No id" },
    ] })]]);
    const jobs = await pinpointAdapter.listJobs(company(), capturedAt);
    expect(jobs.map((job) => [job.externalId, job.postedAt])).toEqual([[OTHER, null]]);
    expect(jobs[0]?.compensation?.source).not.toBe("ats-structured");
    expect(calls).toHaveLength(1);
  });

  it("verifies live postings, probes the feed and validates boards", async () => {
    stubRoutes([[FEED, json({ data: [pinpointPosting(), pinpointPosting({ description: PINPOINT_DEMO_DESCRIPTION })] })]]);
    expect(await pinpointAdapter.verifyBoard!(company())).toMatchObject({ ok: true, postings: 1 });
    stubRoutes([[FEED, new Response(null, { status: 404 })]]);
    await expect(pinpointAdapter.verifyBoard!(company())).rejects.toMatchObject({ code: "not_found" });
    expect(pinpointAdapter.probeUrls("Acme")).toEqual([FEED]);
    expect(() => pinpointAdapter.listUrl(company({ board: "acme-" }))).toThrow(/pinpointhq\.com, e\.g\. "acme"/);
  });

  it("parses posting URLs with or without a language prefix", () => {
    const parse = (url: string) => pinpointAdapter.parsePostingUrl!(new URL(url));
    expect(parse(PAGE)).toEqual({ board: "acme", externalId: PINPOINT_UUID });
    expect(parse(`https://acme.pinpointhq.com/postings/${PINPOINT_UUID}`)).toEqual({ board: "acme", externalId: PINPOINT_UUID });
    expect(parse("https://acme.pinpointhq.com/en/postings")).toBeNull();
    expect(parse(`https://app.pinpointhq.com/en/postings/${PINPOINT_UUID}`)).toBeNull();
  });

  it("fetches one posting from the feed and checks liveness on its page", async () => {
    stubRoutes([[FEED, json({ data: [pinpointPosting()] })], [PAGE, text(pinpointPage())]]);
    expect((await pinpointAdapter.fetchPosting!(company(), PINPOINT_UUID, capturedAt))?.title).toBe("Senior Test Engineer");
    expect(await pinpointAdapter.fetchPosting!(company(), OTHER, capturedAt)).toBeNull();
    expect(await pinpointAdapter.checkPosting!(storedJob())).toMatchObject({ status: "open", via: "page" });
    stubRoutes([[PAGE, text("missing", 404)]]);
    expect((await pinpointAdapter.checkPosting!(storedJob())).status).toBe("closed");
    stubRoutes([[PAGE, text("<html>maintenance</html>")]]);
    expect((await pinpointAdapter.checkPosting!(storedJob())).status).toBe("unknown");
    expect((await pinpointAdapter.checkPosting!(storedJob("290785"))).status).toBe("unknown");
  });
});
