import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanySchema } from "../src/domain/campaign.js";
import { ashbyAdapter } from "../src/sources/ashby.js";
import { greenhouseAdapter } from "../src/sources/greenhouse.js";
import { leverAdapter } from "../src/sources/lever.js";
import { recruiteeAdapter } from "../src/sources/recruitee.js";
import { smartrecruitersAdapter } from "../src/sources/smartrecruiters.js";
import { workableAdapter } from "../src/sources/workable.js";
import { workdayAdapter } from "../src/sources/workday.js";
import { makeJob } from "./factories.js";

/** Liveness checks, posting-URL parsing and single-posting fetches on the core ATS adapters. */

const capturedAt = "2026-10-01T00:00:00.000Z";
const LEVER_ID = "0f8b3c3e-1111-4222-8333-944445555666";
const ASHBY_ID = "a1b2c3d4-0000-4000-8000-123456789abc";

type Route = (url: string, init?: RequestInit) => Response | Promise<Response>;

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

function stub(route: Route) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const href = typeof url === "string" ? url : url.toString();
      calls.push(href);
      return route(href, init);
    }),
  );
  return calls;
}

function company(ats: string, board: string, overrides: Record<string, unknown> = {}) {
  return CompanySchema.parse({ name: "Acme", ats, board, ...overrides });
}

beforeEach(() => {
  process.env.AUTOAPPLY_MIN_INTERVAL_MS = "0";
});
afterEach(() => vi.unstubAllGlobals());

describe("Greenhouse", () => {
  const job = makeJob({ ats: "greenhouse", board: "acme", externalId: "4001" });

  it("checks one posting through the job endpoint", async () => {
    const calls = stub(() => json({ id: 4001, title: "Senior Security Engineer" }));
    expect(await greenhouseAdapter.checkPosting!(job)).toMatchObject({ status: "open", via: "api" });
    expect(calls[0]).toBe("https://boards-api.greenhouse.io/v1/boards/acme/jobs/4001");
  });

  it("reads 404 Job not found as closed", async () => {
    stub(() => json({ status: 404, error: "Job not found" }, 404));
    expect((await greenhouseAdapter.checkPosting!(job)).status).toBe("closed");
  });

  it("stays unknown when the answer does not identify the posting or the request is refused", async () => {
    stub(() => json({ questions: [] }));
    expect((await greenhouseAdapter.checkPosting!(job)).status).toBe("unknown");
    stub(() => json({}, 403));
    expect((await greenhouseAdapter.checkPosting!(job)).status).toBe("unknown");
  });

  it("parses board, embed and gh_jid posting URLs", () => {
    const parse = (value: string) => greenhouseAdapter.parsePostingUrl!(new URL(value));
    expect(parse("https://job-boards.greenhouse.io/acme/jobs/4001")).toEqual({ board: "acme", externalId: "4001" });
    expect(parse("https://boards.greenhouse.io/acme/jobs/4001?gh_src=x")).toEqual({ board: "acme", externalId: "4001" });
    expect(parse("https://job-boards.greenhouse.io/embed/job_app?for=acme&token=4001")).toEqual({ board: "acme", externalId: "4001" });
    expect(parse("https://boards.greenhouse.io/acme?gh_jid=4001")).toEqual({ board: "acme", externalId: "4001" });
    expect(parse("https://example.com/careers?gh_jid=4001")).toBeNull();
    expect(parse("https://job-boards.greenhouse.io/acme")).toBeNull();
  });

  it("fetches one posting, or null once it is gone", async () => {
    stub(() =>
      json({
        id: 4001,
        title: "Senior Security Engineer",
        absolute_url: "https://job-boards.greenhouse.io/acme/jobs/4001",
        content: "&lt;p&gt;Build guardrails.&lt;/p&gt;",
        location: { name: "San Francisco, CA" },
        first_published: "2026-09-20T00:00:00Z",
        pay_input_ranges: [{ min_cents: 20000000, max_cents: 25000000, currency_type: "USD" }],
      }),
    );
    const fetched = await greenhouseAdapter.fetchPosting!(company("greenhouse", "acme"), "4001", capturedAt);
    expect(fetched).toMatchObject({ externalId: "4001", companyName: "Acme", locationClass: "bay-area", descriptionText: "Build guardrails." });
    expect(fetched?.compensation?.max).toBe(250000);
    stub(() => json({ status: 404 }, 404));
    expect(await greenhouseAdapter.fetchPosting!(company("greenhouse", "acme"), "4001", capturedAt)).toBeNull();
    await expect(greenhouseAdapter.fetchPosting!(company("greenhouse", "acme"), "../x", capturedAt)).rejects.toThrow(/numeric/);
  });
});

describe("Lever", () => {
  const job = makeJob({ ats: "lever", board: "acme", externalId: LEVER_ID, url: `https://jobs.eu.lever.co/acme/${LEVER_ID}` });

  it("checks the posting on the region's API", async () => {
    const calls = stub(() => json({ id: LEVER_ID, text: "Engineer" }));
    expect((await leverAdapter.checkPosting!(job)).status).toBe("open");
    expect(calls[0]).toBe(`https://api.eu.lever.co/v0/postings/acme/${LEVER_ID}?mode=json`);
  });

  it("leaves an API 404 unknown, since confidential postings are hidden from the API", async () => {
    stub(() => json({ ok: false, error: "Document not found" }, 404));
    expect((await leverAdapter.checkPosting!(job)).status).toBe("unknown");
  });

  it("parses hosted and apply URLs", () => {
    expect(leverAdapter.parsePostingUrl!(new URL(`https://jobs.lever.co/acme/${LEVER_ID}/apply`))).toEqual({ board: "acme", externalId: LEVER_ID, region: "global" });
    expect(leverAdapter.parsePostingUrl!(new URL(`https://jobs.eu.lever.co/acme/${LEVER_ID}`))).toMatchObject({ region: "eu" });
    expect(leverAdapter.parsePostingUrl!(new URL("https://jobs.lever.co/acme"))).toBeNull();
  });

  it("fetches one posting", async () => {
    stub(() =>
      json({
        id: LEVER_ID,
        text: "Backend Engineer",
        hostedUrl: `https://jobs.lever.co/acme/${LEVER_ID}`,
        applyUrl: `https://jobs.lever.co/acme/${LEVER_ID}/apply`,
        createdAt: 1_790_000_000_000,
        categories: { location: "Toronto, ON", commitment: "Full-time" },
        descriptionPlain: "Design APIs.",
      }),
    );
    const fetched = await leverAdapter.fetchPosting!(company("lever", "acme"), LEVER_ID, capturedAt);
    expect(fetched).toMatchObject({ title: "Backend Engineer", externalId: LEVER_ID, locationClass: "canada" });
  });
});

describe("Ashby", () => {
  const job = makeJob({ ats: "ashby", board: "acme", externalId: ASHBY_ID });

  it("reads a listed posting as open and an unlisted one as closed", async () => {
    stub(() => json({ jobs: [{ id: ASHBY_ID.toUpperCase(), title: "Engineer", isListed: true }] }));
    expect((await ashbyAdapter.checkPosting!(job)).status).toBe("open");
    stub(() => json({ jobs: [{ id: "other", title: "Other" }] }));
    expect((await ashbyAdapter.checkPosting!(job)).status).toBe("closed");
  });

  it("leaves a board without the public API unknown", async () => {
    stub(() => json({}, 404));
    expect((await ashbyAdapter.checkPosting!(job)).status).toBe("unknown");
  });

  it("parses posting and application URLs", () => {
    expect(ashbyAdapter.parsePostingUrl!(new URL(`https://jobs.ashbyhq.com/acme/${ASHBY_ID}/application`))).toEqual({ board: "acme", externalId: ASHBY_ID });
    expect(ashbyAdapter.parsePostingUrl!(new URL(`https://jobs.ashbyhq.com/Acme%20Labs/${ASHBY_ID}`))).toEqual({ board: "Acme Labs", externalId: ASHBY_ID });
    expect(ashbyAdapter.parsePostingUrl!(new URL("https://jobs.ashbyhq.com/acme"))).toBeNull();
  });

  it("fetches one posting from the board listing", async () => {
    stub(() =>
      json({
        jobs: [{ id: ASHBY_ID, title: "Platform Engineer", location: "Remote - US", isRemote: true, workplaceType: "Remote", descriptionPlain: "Run Kubernetes.", jobUrl: `https://jobs.ashbyhq.com/acme/${ASHBY_ID}`, publishedAt: "2026-09-25T00:00:00Z" }],
      }),
    );
    const fetched = await ashbyAdapter.fetchPosting!(company("ashby", "acme"), ASHBY_ID, capturedAt);
    expect(fetched).toMatchObject({ title: "Platform Engineer", workplaceType: "remote" });
    expect(await ashbyAdapter.fetchPosting!(company("ashby", "acme"), "a1b2c3d4-0000-4000-8000-000000000000", capturedAt)).toBeNull();
  });
});

describe("Workday", () => {
  const board = "acme/wd5/AcmeCareers";
  const path = "/job/US-CA-San-Francisco/Security-Engineer_JR100";
  const job = makeJob({ ats: "workday", board, externalId: "abc", url: `https://acme.wd5.myworkdayjobs.com/en-US/AcmeCareers${path}` });
  const detail = (overrides: Record<string, unknown> = {}) => ({
    jobPostingInfo: {
      id: "abc",
      title: "Security Engineer",
      jobDescription: "<p>Protect things.</p>",
      location: "US, CA, San Francisco",
      externalUrl: `https://acme.wd5.myworkdayjobs.com/AcmeCareers${path}`,
      startDate: "2026-09-01",
      posted: true,
      canApply: true,
      ...overrides,
    },
  });

  it("checks the CXS detail for the stored posting path", async () => {
    const calls = stub(() => json(detail()));
    expect((await workdayAdapter.checkPosting!(job)).status).toBe("open");
    expect(calls[0]).toBe(`https://acme.wd5.myworkdayjobs.com/wday/cxs/acme/AcmeCareers${path}`);
  });

  it("reads unpublished, closed-to-applications, 404 and withdrawn postings as closed", async () => {
    stub(() => json(detail({ posted: false })));
    expect((await workdayAdapter.checkPosting!(job)).status).toBe("closed");
    stub(() => json(detail({ canApply: false })));
    expect((await workdayAdapter.checkPosting!(job)).status).toBe("closed");
    stub(() => json({ errorCode: "S21", httpStatus: 404 }, 404));
    expect((await workdayAdapter.checkPosting!(job)).status).toBe("closed");
    stub(() => json({ errorCode: "S22", httpStatus: 403 }, 403));
    expect((await workdayAdapter.checkPosting!(job)).status).toBe("closed");
  });

  it("leaves other refusals unknown", async () => {
    stub(() => new Response("<html>blocked</html>", { status: 403 }));
    expect((await workdayAdapter.checkPosting!(job)).status).toBe("unknown");
  });

  it("parses tenant and myworkdaysite posting URLs into the board triple and job path", () => {
    expect(workdayAdapter.parsePostingUrl!(new URL(`https://acme.wd5.myworkdayjobs.com/en-US/AcmeCareers${path}`))).toEqual({ board, externalId: path });
    expect(workdayAdapter.parsePostingUrl!(new URL(`https://wd5.myworkdaysite.com/recruiting/acme/AcmeCareers${path}`))).toEqual({ board, externalId: path });
    expect(workdayAdapter.parsePostingUrl!(new URL("https://acme.wd5.myworkdayjobs.com/AcmeCareers"))).toBeNull();
  });

  it("fetches one posting by its path, or null once it is closed", async () => {
    stub(() => json(detail()));
    const fetched = await workdayAdapter.fetchPosting!(company("workday", board), path, capturedAt);
    expect(fetched).toMatchObject({ externalId: "abc", title: "Security Engineer", postedAt: "2026-09-01T00:00:00.000Z" });
    stub(() => json(detail({ canApply: false })));
    expect(await workdayAdapter.fetchPosting!(company("workday", board), path, capturedAt)).toBeNull();
    await expect(workdayAdapter.fetchPosting!(company("workday", board), "abc", capturedAt)).rejects.toThrow(/job\/ path/);
  });
});

describe("SmartRecruiters", () => {
  const job = makeJob({ ats: "smartrecruiters", board: "Acme", externalId: "744000001" });

  it("decides from the active flag and visibility", async () => {
    stub(() => json({ id: "744000001", name: "Engineer", active: true, visibility: "PUBLIC" }));
    expect((await smartrecruitersAdapter.checkPosting!(job)).status).toBe("open");
    stub(() => json({ id: "744000001", name: "Engineer", active: false }));
    expect((await smartrecruitersAdapter.checkPosting!(job)).status).toBe("closed");
  });

  it("does not read the 400 an unknown id gets as closed", async () => {
    stub(() => json({ httpCode: 400, code: "ILLEGAL_ARGUMENT" }, 400));
    expect((await smartrecruitersAdapter.checkPosting!(job)).status).toBe("unknown");
  });

  it("parses posting URLs with or without a slug", () => {
    expect(smartrecruitersAdapter.parsePostingUrl!(new URL("https://jobs.smartrecruiters.com/Acme/744000001-security-engineer"))).toEqual({ board: "Acme", externalId: "744000001" });
    expect(smartrecruitersAdapter.parsePostingUrl!(new URL("https://jobs.smartrecruiters.com/Acme"))).toBeNull();
  });
});

describe("Workable", () => {
  const job = makeJob({ ats: "workable", board: "acme", externalId: "ABC123" });

  it("reads published as open and 404 as closed", async () => {
    const calls = stub(() => json({ state: "published" }));
    expect((await workableAdapter.checkPosting!(job)).status).toBe("open");
    expect(calls[0]).toBe("https://apply.workable.com/api/v2/accounts/acme/jobs/ABC123");
    stub(() => new Response("Job not found", { status: 404 }));
    expect((await workableAdapter.checkPosting!(job)).status).toBe("closed");
    stub(() => json({ state: "draft" }));
    expect((await workableAdapter.checkPosting!(job)).status).toBe("unknown");
  });

  it("parses account posting URLs but not bare share links", () => {
    expect(workableAdapter.parsePostingUrl!(new URL("https://apply.workable.com/acme/j/ABC123/"))).toEqual({ board: "acme", externalId: "ABC123" });
    expect(workableAdapter.parsePostingUrl!(new URL("https://apply.workable.com/j/ABC123"))).toBeNull();
  });
});

describe("Recruitee", () => {
  const job = makeJob({ ats: "recruitee", board: "acme", externalId: "123", url: "https://acme.recruitee.com/o/platform-engineer" });
  const feed = (offers: string) => new Response(`<offers>${offers}</offers>`, { status: 200, headers: { "content-type": "application/xml" } });
  const offer = (id: string, slug: string, extra = "") =>
    `<offer><id>${id}</id><slug>${slug}</slug><title>Platform Engineer</title><description><![CDATA[<p>Run systems.</p>]]></description>${extra}</offer>`;

  it("reads a posting the feed still carries as open, and a missing or closed one as closed", async () => {
    stub(() => feed(offer("123", "platform-engineer")));
    expect((await recruiteeAdapter.checkPosting!(job)).status).toBe("open");
    stub(() => feed(offer("999", "other-role")));
    expect((await recruiteeAdapter.checkPosting!(job)).status).toBe("closed");
    stub(() => feed(offer("123", "platform-engineer", "<status>closed</status>")));
    expect((await recruiteeAdapter.checkPosting!(job)).status).toBe("closed");
  });

  it("parses offer URLs and fetches by slug", async () => {
    expect(recruiteeAdapter.parsePostingUrl!(new URL("https://acme.recruitee.com/o/platform-engineer/c/new"))).toEqual({ board: "acme", externalId: "platform-engineer" });
    stub(() => feed(offer("123", "platform-engineer")));
    const fetched = await recruiteeAdapter.fetchPosting!(company("recruitee", "acme"), "platform-engineer", capturedAt);
    expect(fetched).toMatchObject({ externalId: "123", title: "Platform Engineer" });
  });
});
