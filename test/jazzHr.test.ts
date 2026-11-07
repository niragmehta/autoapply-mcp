import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanySchema } from "../src/domain/campaign.js";
import { JobSchema } from "../src/domain/job.js";
import { jazzHrAdapter, parseJazzHrBoard } from "../src/sources/jazzHr.js";
import { jazzBoard, jazzCard, jazzPosting } from "./fixtures/jazzHr.js";
import { failure, redirect, stubRoutes, text } from "./fixtures/smbHttp.js";

const capturedAt = "2026-11-06T12:00:00.000Z";
const BOARD = "https://acme.applytojob.com/apply";
const POSTING = "https://acme.applytojob.com/apply/";

function company(overrides: Record<string, unknown> = {}) {
  return CompanySchema.parse({ name: "Example Co", ats: "jazzhr", board: "acme", ...overrides });
}

function storedJob(externalId = "gdWcbFq2mr") {
  return JobSchema.parse({
    id: "job_1", fingerprint: "f", ats: "jazzhr", companyName: "Example Co", board: "acme", externalId,
    title: "Platform Engineer", locationClass: "unknown", url: `${POSTING}${externalId}`, applyUrl: "", capturedAt,
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

describe("JazzHR board parsing", () => {
  it("reads cards with location and department, plus posting links outside a card", () => {
    const html = jazzBoard([jazzCard("gdWcbFq2mr", "Platform Engineer", "Remote", "Engineering")])
      .replace("</ul></div>", "</ul><p><a href='/apply/Xy12Ab34Cd/Data-Analyst'>Data Analyst</a></p></div>");
    expect(parseJazzHrBoard(html, "acme.applytojob.com")).toEqual([
      { id: "gdWcbFq2mr", title: "Platform Engineer", location: "Remote", department: "Engineering" },
      { id: "Xy12Ab34Cd", title: "Data Analyst", location: "", department: "" },
    ]);
  });

  it("ignores navigation, other hosts and lower-case path words", () => {
    const html = `<a href="/apply">Jobs</a><a href="/apply/resumebuild/x">Build</a>
      <a href="https://evil.example/apply/Ab12Cd34Ef/x">Elsewhere</a>`;
    expect(parseJazzHrBoard(html, "acme.applytojob.com")).toEqual([]);
  });
});

describe("JazzHR adapter", () => {
  it("joins board cards with each posting's schema.org metadata", async () => {
    stubRoutes([
      [BOARD, text(jazzBoard([jazzCard("gdWcbFq2mr", "Platform Engineer", "Remote")]))],
      [`${POSTING}gdWcbFq2mr`, text(jazzPosting())],
    ]);
    const [job] = await jazzHrAdapter.listJobs(company(), capturedAt);
    expect(JobSchema.parse(job)).toMatchObject({
      externalId: "gdWcbFq2mr", title: "Platform Engineer", url: `${POSTING}gdWcbFq2mr`,
      workplaceType: "remote", locationClass: "remote-us", country: "US", postedAt: "2026-10-07T00:00:00.000Z",
      employmentType: "full_time",
      compensation: { min: 140000, max: 170000, currency: "USD", period: "year", source: "ats-structured" },
    });
    expect(job?.locationsRaw).toEqual(["Remote", "Austin, TX, United States"]);
    expect(job?.descriptionText).toContain("Own our CI platform.");
  });

  it("drops expired postings, keeps listing data when a detail fails, and filters by query first", async () => {
    vi.stubEnv("AUTOAPPLY_SMB_DETAIL_LIMIT", "5");
    const calls = stubRoutes([
      [BOARD, text(jazzBoard([
        jazzCard("Aa11Bb22Cc", "Security Engineer", "Toronto, ON"),
        jazzCard("Dd33Ee44Ff", "Security Analyst"),
        jazzCard("Gg55Hh66Ii", "Account Executive"),
      ]))],
      [`${POSTING}Aa11Bb22Cc`, () => failure()],
      [`${POSTING}Dd33Ee44Ff`, text(jazzPosting({ validThrough: "2026-01-01" }))],
    ]);
    const jobs = await jazzHrAdapter.listJobs(company({ query: "security" }), capturedAt);
    expect(jobs.map((job) => [job.externalId, job.locationClass])).toEqual([["Aa11Bb22Cc", "canada"]]);
    expect(calls.some((call) => call.url.includes("Gg55Hh66Ii"))).toBe(false);
  }, 15_000);

  it("treats a vendor redirect as an unknown tenant and needs a JazzHR page", async () => {
    stubRoutes([[BOARD, redirect("https://info.jazzhr.com/job-seekers.html")]]);
    await expect(jazzHrAdapter.listJobs(company(), capturedAt)).rejects.toMatchObject({ code: "not_found" });
    stubRoutes([[BOARD, text("<html>parked domain</html>")]]);
    await expect(jazzHrAdapter.verifyBoard!(company())).rejects.toMatchObject({ code: "invalid_source_payload" });
    expect(() => jazzHrAdapter.boardUrl(company({ board: "acme.applytojob.com" }))).toThrow(/applytojob\.com, e\.g\. "acme"/);
  });

  it("verifies with one board request; HTML-only hosts are not probed", async () => {
    const calls = stubRoutes([[BOARD, text(jazzBoard([jazzCard("gdWcbFq2mr", "Platform Engineer")]))]]);
    expect(await jazzHrAdapter.verifyBoard!(company())).toMatchObject({ ok: true, postings: 1 });
    expect(calls).toHaveLength(1);
    expect(jazzHrAdapter.probeUrls("acme")).toEqual([]);
  });

  it("parses posting URLs with or without a slug", () => {
    const parse = (url: string) => jazzHrAdapter.parsePostingUrl!(new URL(url));
    expect(parse("https://acme.applytojob.com/apply/gdWcbFq2mr/Platform-Engineer")).toEqual({ board: "acme", externalId: "gdWcbFq2mr" });
    expect(parse("https://acme.applytojob.com/apply/gdWcbFq2mr")).toEqual({ board: "acme", externalId: "gdWcbFq2mr" });
    expect(parse("https://acme.applytojob.com/apply")).toBeNull();
    expect(parse("https://acme.example.com/apply/gdWcbFq2mr")).toBeNull();
  });

  it("fetches one posting, returning null when JazzHR answers 410 Gone", async () => {
    stubRoutes([[`${POSTING}gdWcbFq2mr`, text(jazzPosting())], [`${POSTING}Zz99Yy88Xx`, text("gone", 410)]]);
    expect((await jazzHrAdapter.fetchPosting!(company(), "gdWcbFq2mr", capturedAt))?.title).toBe("Platform Engineer");
    expect(await jazzHrAdapter.fetchPosting!(company(), "Zz99Yy88Xx", capturedAt)).toBeNull();
  });

  it("checks liveness from the posting page", async () => {
    stubRoutes([[`${POSTING}gdWcbFq2mr`, text(jazzPosting())]]);
    expect(await jazzHrAdapter.checkPosting!(storedJob())).toMatchObject({ status: "open", via: "page" });
    stubRoutes([[`${POSTING}gdWcbFq2mr`, text("gone", 410)]]);
    expect((await jazzHrAdapter.checkPosting!(storedJob())).status).toBe("closed");
    stubRoutes([[`${POSTING}gdWcbFq2mr`, text(jazzPosting({ validThrough: "2026-01-01" }))]]);
    expect((await jazzHrAdapter.checkPosting!(storedJob())).status).toBe("closed");
    stubRoutes([[`${POSTING}gdWcbFq2mr`, text("<html>maintenance</html>")]]);
    expect((await jazzHrAdapter.checkPosting!(storedJob())).status).toBe("unknown");
    stubRoutes([[`${POSTING}gdWcbFq2mr`, redirect("https://info.jazzhr.com/")]]);
    expect((await jazzHrAdapter.checkPosting!(storedJob())).status).toBe("unknown");
  });
});
