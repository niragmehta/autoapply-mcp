import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanySchema } from "../src/domain/campaign.js";
import { JobSchema } from "../src/domain/job.js";
import { ripplingAdapter } from "../src/sources/rippling.js";
import { RIPPLING_ID, ripplingDetail, ripplingItem, ripplingPage } from "./fixtures/rippling.js";
import { json, stubRoutes, text } from "./fixtures/smbHttp.js";

const capturedAt = "2026-11-06T12:00:00.000Z";
const API = "https://ats.rippling.com/api/v2/board/acme/jobs";
const OTHER_ID = "e1394313-6e36-401f-91ec-1d44fa616ed0";

function company(overrides: Record<string, unknown> = {}) {
  return CompanySchema.parse({ name: "Example Co", ats: "rippling", board: "acme", ...overrides });
}

function storedJob() {
  return JobSchema.parse({
    id: "job_1", fingerprint: "f", ats: "rippling", companyName: "Example Co", board: "acme", externalId: RIPPLING_ID,
    title: "Technical Program Manager", locationClass: "unknown", url: "", applyUrl: "", capturedAt,
  });
}

beforeEach(() => vi.stubEnv("AUTOAPPLY_MIN_INTERVAL_MS", "0"));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Rippling adapter", () => {
  it("lists the board and reads each posting for description, date and pay range", async () => {
    stubRoutes([[`${API}?page=0`, json(ripplingPage([ripplingItem()]))], [`${API}/${RIPPLING_ID}`, json(ripplingDetail())]]);
    const [job] = await ripplingAdapter.listJobs(company(), capturedAt);
    expect(JobSchema.parse(job)).toMatchObject({
      externalId: RIPPLING_ID, url: `https://ats.rippling.com/acme/jobs/${RIPPLING_ID}`,
      workplaceType: "remote", locationClass: "remote-us", country: "US",
      postedAt: "2026-08-24T16:38:14.937Z", employmentType: "salaried, full-time",
      compensation: { min: 187000, max: 207000, currency: "USD", period: "year", source: "ats-structured" },
    });
    expect(job?.descriptionText).toContain("Coordinate delivery across teams.");
    expect(job?.descriptionText).toContain("Example Co builds networks.");
  });

  it("walks every page, spans same-unit ranges and refuses mixed units", async () => {
    const hybrid = { name: "San Francisco, CA", country: "United States", countryCode: "US", workplaceType: "HYBRID" };
    stubRoutes([
      [`${API}?page=0`, json(ripplingPage([ripplingItem()], 0, 2))],
      [`${API}?page=1`, json(ripplingPage([ripplingItem({ id: OTHER_ID, name: "Data Engineer", locations: [hybrid] })], 1, 2))],
      [`${API}/${RIPPLING_ID}`, json(ripplingDetail({ payRangeDetails: [
        { location: "A", currency: "USD", frequency: "YEAR", rangeStart: 150000, rangeEnd: 180000 },
        { location: "B", currency: "USD", frequency: "YEAR", rangeStart: 170000, rangeEnd: 200000 },
      ] }))],
      [`${API}/${OTHER_ID}`, json(ripplingDetail({ uuid: OTHER_ID, payRangeDetails: [
        { location: "A", currency: "USD", frequency: "YEAR", rangeStart: 150000, rangeEnd: 180000 },
        { location: "B", currency: "USD", frequency: "HOUR", rangeStart: 70, rangeEnd: 90 },
      ] }))],
    ]);
    const jobs = await ripplingAdapter.listJobs(company(), capturedAt);
    expect(jobs.map((job) => job.externalId)).toEqual([RIPPLING_ID, OTHER_ID]);
    expect(jobs[0]?.compensation).toMatchObject({ min: 150000, max: 200000, period: "year" });
    expect(jobs[1]).toMatchObject({ workplaceType: "hybrid", locationClass: "bay-area" });
    expect(jobs[1]?.compensation?.source).not.toBe("ats-structured");
  });

  it("keeps listing data when a posting detail fails and filters by query before details", async () => {
    const calls = stubRoutes([
      [`${API}?page=0`, json(ripplingPage([ripplingItem(), ripplingItem({ id: OTHER_ID, name: "Sales Lead", department: { name: "Sales" } })]))],
      [`${API}/${RIPPLING_ID}`, text("denied", 403)],
    ]);
    const jobs = await ripplingAdapter.listJobs(company({ query: "program" }), capturedAt);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ externalId: RIPPLING_ID, descriptionText: "", locationClass: "remote-us" });
    expect(calls.some((call) => call.url.endsWith(OTHER_ID))).toBe(false);
  });

  it("verifies cheaply, probes the board API and rejects path-shaped boards", async () => {
    const calls = stubRoutes([[`${API}?page=0&pageSize=5`, json({ ...ripplingPage([ripplingItem()]), totalItems: 33 })]]);
    expect(await ripplingAdapter.verifyBoard!(company())).toMatchObject({ ok: true, postings: 33 });
    expect(calls).toHaveLength(1);
    expect(ripplingAdapter.probeUrls("Acme")).toEqual([`${API}?page=0&pageSize=1`]);
    expect(ripplingAdapter.probeUrls("acme corp")).toEqual([]);
    expect(() => ripplingAdapter.listUrl(company({ board: "acme/jobs" }))).toThrow(/ats\.rippling\.com\/<slug>\/jobs/);
  });

  it("parses posting URLs, including a locale prefix", () => {
    const parse = (url: string) => ripplingAdapter.parsePostingUrl!(new URL(url));
    expect(parse(`https://ats.rippling.com/acme/jobs/${RIPPLING_ID}`)).toEqual({ board: "acme", externalId: RIPPLING_ID });
    expect(parse(`https://ats.rippling.com/en-US/acme/jobs/${RIPPLING_ID}`)).toEqual({ board: "acme", externalId: RIPPLING_ID });
    expect(parse("https://ats.rippling.com/acme/jobs")).toBeNull();
    expect(parse(`https://example.com/acme/jobs/${RIPPLING_ID}`)).toBeNull();
  });

  it("fetches one posting, and checks liveness through the posting endpoint", async () => {
    stubRoutes([[`${API}/${RIPPLING_ID}`, json(ripplingDetail())]]);
    expect((await ripplingAdapter.fetchPosting!(company(), RIPPLING_ID, capturedAt))?.locationsRaw).toEqual(["Remote (DC, US)"]);
    expect((await ripplingAdapter.checkPosting!(storedJob())).status).toBe("open");
    stubRoutes([[`${API}/${RIPPLING_ID}`, json({ ok: false, error: "There was a client validation error" }, 404)]]);
    expect(await ripplingAdapter.fetchPosting!(company(), RIPPLING_ID, capturedAt)).toBeNull();
    expect((await ripplingAdapter.checkPosting!(storedJob())).status).toBe("closed");
    stubRoutes([[`${API}/${RIPPLING_ID}`, json({ unexpected: true })]]);
    expect((await ripplingAdapter.checkPosting!(storedJob())).status).toBe("unknown");
  });
});
