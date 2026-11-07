import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanySchema } from "../src/domain/campaign.js";
import { JobSchema } from "../src/domain/job.js";
import { parsePersonioXml, personioAdapter } from "../src/sources/personio.js";
import { personioPage, personioPosition, personioSearch, personioXml } from "./fixtures/personio.js";
import { json, stubRoutes, text } from "./fixtures/smbHttp.js";

const capturedAt = "2026-11-06T12:00:00.000Z";
const BASE = "https://acme.jobs.personio.de";

function company(overrides: Record<string, unknown> = {}) {
  return CompanySchema.parse({ name: "Example Co", ats: "personio", board: "acme", ...overrides });
}

function storedJob(externalId = "2784397") {
  return JobSchema.parse({
    id: "job_1", fingerprint: "f", ats: "personio", companyName: "Example Co", board: "acme", externalId,
    title: "Platform Engineer", locationClass: "unknown", url: "", applyUrl: "", capturedAt,
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

describe("Personio XML feed", () => {
  it("reads offices, salary and any inline descriptions", () => {
    const inline = `<jobDescription><name>Your tasks</name><value><![CDATA[<p>Run the platform</p>]]></value></jobDescription>`;
    const [position] = parsePersonioXml(personioXml([personioPosition("1", `<additionalOffices><office>Remote</office></additionalOffices>`, inline)]));
    expect(position).toMatchObject({
      id: "1", name: "Platform & Reliability Engineer", offices: ["Toronto", "Remote"], department: "Engineering",
      employmentType: "permanent, full-time", createdAt: "2026-09-07T11:44:15.000Z",
      salary: { min: "120000.00", max: "140000.00", currency: "CAD", type: "yearly" },
    });
    expect(position?.descriptionHtml).toContain("Run the platform");
  });

  it("rejects DTDs and skips positions without a numeric id", () => {
    expect(() => parsePersonioXml(`<!DOCTYPE x [<!ENTITY a "b">]><workzag-jobs/>`)).toThrow(/DOCTYPE/);
    expect(parsePersonioXml(personioXml([personioPosition("abc")]))).toEqual([]);
  });
});

describe("Personio adapter", () => {
  it("joins the XML feed with each posting page's description and country", async () => {
    stubRoutes([[`${BASE}/xml`, text(personioXml([personioPosition()]), 200, "text/xml")], [`${BASE}/job/2784397`, text(personioPage())]]);
    const [job] = await personioAdapter.listJobs(company(), capturedAt);
    expect(JobSchema.parse(job)).toMatchObject({
      externalId: "2784397", url: `${BASE}/job/2784397`, locationClass: "canada", country: "CA",
      postedAt: "2026-09-07T11:44:15.000Z", employmentType: "permanent, full-time",
      compensation: { min: 120000, max: 140000, currency: "CAD", period: "year", source: "ats-structured" },
    });
    expect(job?.descriptionText).toContain("Run our platform.");
  });

  it("falls back to search.json when the XML feed is disabled", async () => {
    stubRoutes([
      [`${BASE}/xml`, text("This career page does not exist", 404)],
      [`${BASE}/search.json`, json([personioSearch()])],
      [`${BASE}/job/602632`, text(personioPage({ datePosted: "2022-02-22", jobLocation: { address: { addressLocality: "Berlin", addressCountry: "DE" } } }))],
    ]);
    const [job] = await personioAdapter.listJobs(company(), capturedAt);
    expect(job).toMatchObject({ externalId: "602632", postedAt: "2022-02-22T00:00:00.000Z", locationClass: "other", country: "DE" });
  });

  it("skips detail pages when the feed carries descriptions and filters by query", async () => {
    const inline = `<jobDescription><name>Role</name><value><![CDATA[<p>Inline text</p>]]></value></jobDescription>`;
    const calls = stubRoutes([[`${BASE}/xml`, text(personioXml([
      personioPosition("1", "", inline), personioPosition("2").replace("Platform &amp; Reliability Engineer", "Office Manager").replace("Engineering", "Operations"),
    ]), 200, "text/xml")]]);
    const jobs = await personioAdapter.listJobs(company({ query: "reliability" }), capturedAt);
    expect(jobs.map((job) => job.externalId)).toEqual(["1"]);
    expect(jobs[0]?.descriptionText).toContain("Inline text");
    expect(calls).toHaveLength(1);
  });

  it("verifies, probes search.json, validates boards and parses posting URLs", async () => {
    stubRoutes([[`${BASE}/xml`, text(personioXml([personioPosition()]), 200, "text/xml")]]);
    expect(await personioAdapter.verifyBoard!(company())).toMatchObject({ ok: true, postings: 1 });
    expect(personioAdapter.probeUrls("Acme")).toEqual([`${BASE}/search.json`]);
    expect(() => personioAdapter.listUrl(company({ board: "acme.jobs.personio.de" }))).toThrow(/jobs\.personio\.de, e\.g\. "acme"/);
    const parse = (url: string) => personioAdapter.parsePostingUrl!(new URL(url));
    expect(parse(`${BASE}/job/2784397?language=en`)).toEqual({ board: "acme", externalId: "2784397" });
    expect(parse("https://acme.jobs.personio.com/job/2784397")).toEqual({ board: "acme", externalId: "2784397" });
    expect(parse(`${BASE}/`)).toBeNull();
  });

  it("fetches one position and checks liveness on its page", async () => {
    stubRoutes([[`${BASE}/xml`, text(personioXml([personioPosition()]), 200, "text/xml")], [`${BASE}/job/2784397`, text(personioPage())]]);
    expect((await personioAdapter.fetchPosting!(company(), "2784397", capturedAt))?.title).toBe("Platform & Reliability Engineer");
    expect(await personioAdapter.fetchPosting!(company(), "1", capturedAt)).toBeNull();
    expect(await personioAdapter.checkPosting!(storedJob())).toMatchObject({ status: "open", via: "page" });
    stubRoutes([[`${BASE}/job/2784397`, text("not found", 404)]]);
    expect((await personioAdapter.checkPosting!(storedJob())).status).toBe("closed");
    stubRoutes([[`${BASE}/job/2784397`, text("<html>no metadata</html>")]]);
    expect((await personioAdapter.checkPosting!(storedJob())).status).toBe("unknown");
  });
});
