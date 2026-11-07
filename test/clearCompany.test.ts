import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanySchema } from "../src/domain/campaign.js";
import { JobSchema } from "../src/domain/job.js";
import { clearCompanyAdapter } from "../src/sources/clearCompany.js";
import { CLEAR_JOB, CLEAR_SITE, clearPage, clearRecord } from "./fixtures/clearCompany.js";
import { json, stubRoutes, text } from "./fixtures/smbHttp.js";

const capturedAt = "2026-11-06T12:00:00.000Z";
const API = `https://careers-api.clearcompany.com/v1/${CLEAR_SITE}`;
const SECOND = "5c4c12e9-d4b3-f9ed-ad88-081b9ea145fc";

function company(overrides: Record<string, unknown> = {}) {
  return CompanySchema.parse({ name: "Example Co", ats: "clearcompany", board: CLEAR_SITE.toUpperCase(), ...overrides });
}

function storedJob() {
  return JobSchema.parse({
    id: "job_1", fingerprint: "f", ats: "clearcompany", companyName: "Example Co", board: CLEAR_SITE, externalId: CLEAR_JOB,
    title: "Revenue Cycle Analyst", locationClass: "unknown", url: "", applyUrl: "", capturedAt,
  });
}

beforeEach(() => vi.stubEnv("AUTOAPPLY_MIN_INTERVAL_MS", "0"));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("ClearCompany adapter", () => {
  it("normalizes postings with UTC dates and pay kept only for US or Canadian roles", async () => {
    stubRoutes([[`${API}?pageIndex=0`, json(clearPage([
      clearRecord(),
      clearRecord({ id: SECOND, positionTitle: "Clinic Lead", locations: [{ city: "Leeds", country: "GB", isRemote: false }], location: "Leeds" }),
    ]))]]);
    const jobs = await clearCompanyAdapter.listJobs(company(), capturedAt);
    expect(JobSchema.parse(jobs[0])).toMatchObject({
      externalId: CLEAR_JOB, title: "Revenue Cycle Analyst", url: `https://acme.clearcompany.com/careers/jobs/${CLEAR_JOB}/apply`,
      locationClass: "us-other", country: "US", postedAt: "2025-09-10T00:00:00.000Z",
      compensation: { min: 65000, max: 80000, currency: "USD", period: "year", source: "ats-structured" },
    });
    expect(jobs[1]).toMatchObject({ locationClass: "other", compensation: null });
  });

  it("pages with 0-based pageIndex until totalCount and stops on a repeated page", async () => {
    const calls = stubRoutes([
      [`${API}?pageIndex=0`, json(clearPage([clearRecord()], 2))],
      [`${API}?pageIndex=1`, json(clearPage([clearRecord({ id: SECOND, applyLink: "mailto:jobs@example.com" })], 2, 1))],
    ]);
    const jobs = await clearCompanyAdapter.listJobs(company(), capturedAt);
    expect(jobs.map((job) => job.externalId)).toEqual([CLEAR_JOB, SECOND]);
    expect(jobs[1]?.url).toBe(`${API}/${SECOND}`);
    expect(calls).toHaveLength(2);
    const repeated = stubRoutes([[`${API}?pageIndex=`, json({ results: [clearRecord()] })]]);
    expect(await clearCompanyAdapter.listJobs(company(), capturedAt)).toHaveLength(1);
    expect(repeated).toHaveLength(2);
  });

  it("requires a siteId GUID, verifies with a small page and never probes", async () => {
    expect(() => clearCompanyAdapter.listUrl(company({ board: "acme" }))).toThrow(/siteId GUID/);
    stubRoutes([[`${API}?pageIndex=0&pageSize=5`, json(clearPage([clearRecord()], 9))]]);
    expect(await clearCompanyAdapter.verifyBoard!(company())).toMatchObject({ ok: true, postings: 9 });
    stubRoutes([[API, json({ title: "Not Found", status: 404 }, 404)]]);
    await expect(clearCompanyAdapter.verifyBoard!(company())).rejects.toMatchObject({ code: "not_found" });
    expect(clearCompanyAdapter.probeUrls("acme")).toEqual([]);
    expect(clearCompanyAdapter.parsePostingUrl).toBeUndefined();
  });

  it("fetches and checks one posting through its detail endpoint", async () => {
    stubRoutes([[`${API}/${CLEAR_JOB}`, json(clearRecord())]]);
    expect((await clearCompanyAdapter.fetchPosting!(company(), CLEAR_JOB, capturedAt))?.title).toBe("Revenue Cycle Analyst");
    expect((await clearCompanyAdapter.checkPosting!(storedJob())).status).toBe("open");
    stubRoutes([[`${API}/${CLEAR_JOB}`, json({ title: "Not Found", status: 404 }, 404)]]);
    expect(await clearCompanyAdapter.fetchPosting!(company(), CLEAR_JOB, capturedAt)).toBeNull();
    expect((await clearCompanyAdapter.checkPosting!(storedJob())).status).toBe("closed");
    stubRoutes([[`${API}/${CLEAR_JOB}`, text("denied", 403)]]);
    expect((await clearCompanyAdapter.checkPosting!(storedJob())).status).toBe("unknown");
  });
});
