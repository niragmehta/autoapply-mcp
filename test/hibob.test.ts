import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanySchema } from "../src/domain/campaign.js";
import { JobSchema } from "../src/domain/job.js";
import { hibobAdapter } from "../src/sources/hibob.js";
import { HIBOB_ID, hibobAd, hibobResponse } from "./fixtures/hibob.js";
import { json, stubRoutes } from "./fixtures/smbHttp.js";

const capturedAt = "2026-11-06T12:00:00.000Z";
const API = "https://acme.careers.hibob.com/api/job-ad";

function company(overrides: Record<string, unknown> = {}) {
  return CompanySchema.parse({ name: "Example Co", ats: "hibob", board: "acme", ...overrides });
}

function storedJob(externalId = HIBOB_ID) {
  return JobSchema.parse({
    id: "job_1", fingerprint: "f", ats: "hibob", companyName: "Example Co", board: "acme", externalId,
    title: "Technical Support Specialist", locationClass: "unknown", url: "", applyUrl: "", capturedAt,
  });
}

beforeEach(() => vi.stubEnv("AUTOAPPLY_MIN_INTERVAL_MS", "0"));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("HiBob adapter", () => {
  it("names the tenant in the companyidentifier header and normalizes the full ad", async () => {
    const calls = stubRoutes([[API, json(hibobResponse())]]);
    const [job] = await hibobAdapter.listJobs(company(), capturedAt);
    expect(new Headers(calls[0]?.init?.headers).get("companyidentifier")).toBe("acme");
    expect(JobSchema.parse(job)).toMatchObject({
      externalId: HIBOB_ID, url: `https://acme.careers.hibob.com/jobs/${HIBOB_ID}`, workplaceType: "remote",
      locationClass: "remote-us", country: "US", postedAt: "2026-09-04T07:25:28.557Z", employmentType: "permanent",
      compensation: { min: 65000, max: 80000, currency: "USD", period: "year", source: "ats-structured" },
    });
    expect(job?.descriptionText).toContain("Three years of support experience");
  });

  it("classifies foreign sites, reads posting locations and skips malformed ads", async () => {
    stubRoutes([[API, json(hibobResponse([
      hibobAd({ id: "a1", site: "Barcelona", country: "Spain", workspaceTypeId: "hybrid", payTransparencyMinSalary: 0, payTransparencyMaxSalary: null }),
      hibobAd({ id: "b2", site: "Toronto Office", country: "Canada", workspaceTypeId: "onsite",
        postingLocations: [{ name: "Toronto Office", city: "Toronto", region: "ON", country: "Canada" }] }),
      { id: "", title: "" },
    ]))]]);
    const jobs = await hibobAdapter.listJobs(company(), capturedAt);
    expect(jobs.map((job) => [job.externalId, job.workplaceType, job.locationClass, job.compensation?.source ?? null])).toEqual([
      ["a1", "hybrid", "other", null], ["b2", "onsite", "canada", "ats-structured"],
    ]);
  });

  it("maps an unknown tenant's 401 to not found, and does not probe (the endpoint needs a header)", async () => {
    stubRoutes([[API, json({ servlet: "jersey", message: "Unauthorized", status: "401" }, 401)]]);
    await expect(hibobAdapter.verifyBoard!(company())).rejects.toMatchObject({ code: "not_found" });
    expect(hibobAdapter.probeUrls("acme")).toEqual([]);
    expect(() => hibobAdapter.listUrl(company({ board: "acme.careers.hibob.com" }))).toThrow(/careers\.hibob\.com, e\.g\. "acme"/);
  });

  it("parses posting and apply links", () => {
    const parse = (url: string) => hibobAdapter.parsePostingUrl!(new URL(url));
    expect(parse(`https://acme-641e1b39232b.careers.hibob.com/jobs/${HIBOB_ID}/apply`))
      .toEqual({ board: "acme-641e1b39232b", externalId: HIBOB_ID });
    expect(parse("https://acme.careers.hibob.com/jobs")).toBeNull();
    expect(parse(`https://acme.hibob.com/jobs/${HIBOB_ID}`)).toBeNull();
  });

  it("fetches and checks ads against the complete list", async () => {
    stubRoutes([[API, json(hibobResponse())]]);
    expect((await hibobAdapter.fetchPosting!(company(), HIBOB_ID, capturedAt))?.title).toBe("Technical Support Specialist");
    expect(await hibobAdapter.fetchPosting!(company(), "missing", capturedAt)).toBeNull();
    expect((await hibobAdapter.checkPosting!(storedJob())).status).toBe("open");
    expect((await hibobAdapter.checkPosting!(storedJob("missing"))).status).toBe("closed");
    stubRoutes([[API, json({ error: "bad gateway" }, 403)]]);
    expect((await hibobAdapter.checkPosting!(storedJob())).status).toBe("unknown");
  });
});
