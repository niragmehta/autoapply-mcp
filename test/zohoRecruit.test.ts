import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanySchema } from "../src/domain/campaign.js";
import { JobSchema } from "../src/domain/job.js";
import { zohoRecords, zohoRecruitAdapter } from "../src/sources/zohoRecruit.js";
import { stubRoutes, text } from "./fixtures/smbHttp.js";
import { ZOHO_MISSING_PAGE, zohoPage, zohoRecord } from "./fixtures/zohoRecruit.js";

const capturedAt = "2026-11-06T12:00:00.000Z";
const PAGE = "https://acme.zohorecruit.com/jobs/Careers";
const ID = "747697000006478411";

function company(overrides: Record<string, unknown> = {}) {
  return CompanySchema.parse({ name: "Example Co", ats: "zohorecruit", board: "acme", ...overrides });
}

function storedJob(externalId = ID) {
  return JobSchema.parse({
    id: "job_1", fingerprint: "f", ats: "zohorecruit", companyName: "Example Co", board: "acme", externalId,
    title: "Cloud Infrastructure Engineer", locationClass: "unknown", url: "", applyUrl: "", capturedAt,
  });
}

beforeEach(() => vi.stubEnv("AUTOAPPLY_MIN_INTERVAL_MS", "0"));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("Zoho Recruit job list", () => {
  it("decodes the hidden input without executing scripts", () => {
    expect(zohoRecords(zohoPage([zohoRecord()]))).toEqual([zohoRecord()]);
  });

  it("tells an unknown tenant from a changed page", () => {
    expect(() => zohoRecords(ZOHO_MISSING_PAGE)).toThrow(expect.objectContaining({ code: "not_found" }));
    expect(() => zohoRecords("<html><title>Careers</title></html>")).toThrow(expect.objectContaining({ code: "invalid_source_payload" }));
    expect(() => zohoRecords('<input id="jobs" value="{&quot;a&quot;:1}">')).toThrow(/not an array/);
  });
});

describe("Zoho Recruit adapter", () => {
  it("normalizes every published record from one page", async () => {
    stubRoutes([[PAGE, text(zohoPage([zohoRecord()]))]]);
    const [job] = await zohoRecruitAdapter.listJobs(company(), capturedAt);
    expect(JobSchema.parse(job)).toMatchObject({
      externalId: ID, url: `${PAGE}/${ID}`, locationClass: "canada", country: "CA",
      postedAt: "2026-10-30T00:00:00.000Z", employmentType: "full time",
    });
    expect(job?.descriptionText).toContain("Operate our cloud & network.");
  });

  it("skips filled, unpublished and malformed records, flags remote roles and filters by query", async () => {
    stubRoutes([[PAGE, text(zohoPage([
      zohoRecord({ id: "1000001", Is_Locked: true }),
      zohoRecord({ id: "1000002", Publish: false }),
      zohoRecord({ id: "1000003", Remote_Job: true, City: null, State: null, Country: "United States" }),
      zohoRecord({ id: "1000004", Posting_Title: "Office Manager", Function: "Operations" }),
      { id: "x", Posting_Title: "Broken" },
    ]))]]);
    const jobs = await zohoRecruitAdapter.listJobs(company({ query: "infrastructure" }), capturedAt);
    expect(jobs.map((job) => [job.externalId, job.workplaceType, job.locationClass])).toEqual([["1000003", "remote", "remote-us"]]);
  });

  it("supports other data centres and rejects unknown ones", async () => {
    const calls = stubRoutes([["https://acme.zohorecruit.eu/jobs/Careers", text(zohoPage([]))]]);
    expect(await zohoRecruitAdapter.listJobs(company({ board: "acme.eu" }), capturedAt)).toEqual([]);
    expect(calls[0]?.url).toBe("https://acme.zohorecruit.eu/jobs/Careers");
    expect(() => zohoRecruitAdapter.listUrl(company({ board: "acme.xyz" }))).toThrow(/acme\.eu/);
  });

  it("verifies with one page, does not probe HTML-only hosts and parses posting URLs", async () => {
    stubRoutes([[PAGE, text(ZOHO_MISSING_PAGE)]]);
    await expect(zohoRecruitAdapter.verifyBoard!(company())).rejects.toMatchObject({ code: "not_found" });
    expect(zohoRecruitAdapter.probeUrls("acme")).toEqual([]);
    const parse = (url: string) => zohoRecruitAdapter.parsePostingUrl!(new URL(url));
    expect(parse(`https://acme.zohorecruit.com/jobs/Careers/${ID}/Cloud-Engineer`)).toEqual({ board: "acme", externalId: ID });
    expect(parse(`https://acme.zohorecruit.com.au/jobs/Emplois/${ID}`)).toEqual({ board: "acme.com.au", externalId: ID });
    expect(parse("https://acme.zohorecruit.com/jobs/Careers")).toBeNull();
  });

  it("fetches and checks postings against the career page", async () => {
    stubRoutes([[PAGE, text(zohoPage([zohoRecord(), zohoRecord({ id: "1000005", Is_Locked: true })]))]]);
    expect((await zohoRecruitAdapter.fetchPosting!(company(), ID, capturedAt))?.title).toBe("Cloud Infrastructure Engineer");
    expect(await zohoRecruitAdapter.fetchPosting!(company(), "1000005", capturedAt)).toBeNull();
    expect((await zohoRecruitAdapter.checkPosting!(storedJob())).status).toBe("open");
    expect((await zohoRecruitAdapter.checkPosting!(storedJob("1000005"))).status).toBe("closed");
    stubRoutes([[PAGE, text("<html><title>Careers</title>maintenance</html>")]]);
    expect((await zohoRecruitAdapter.checkPosting!(storedJob())).status).toBe("unknown");
  });
});
