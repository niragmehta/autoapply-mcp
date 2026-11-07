import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanySchema } from "../src/domain/campaign.js";
import { AppError } from "../src/util/errors.js";
import { logger } from "../src/util/logger.js";
import { jobviteAdapter, parseJobviteBoard } from "../src/sources/jobvite.js";
import { parseJobviteFeed, parseJobviteList } from "../src/sources/enterprise/jobvitePage.js";
import {
  JOBVITE_COMPANY_ID, JOBVITE_FEED, JOBVITE_MISSING_PAGE, JOBVITE_ROWS, JOBVITE_SLUG, jobviteDetailPage, jobviteListPage,
} from "./fixtures/jobvite.js";

const capturedAt = "2026-11-07T00:00:00.000Z";

function company(overrides: Record<string, unknown> = {}) {
  return CompanySchema.parse({ name: "Tyler Technologies", ats: "jobvite", board: JOBVITE_SLUG, ...overrides });
}

function text(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { "content-type": "text/html", ...headers } });
}

function stub(routes: { list?: () => Response; feed?: () => Response; posting?: (id: string) => Response }): URL[] {
  const calls: URL[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const url = new URL(input);
    calls.push(url);
    if (url.hostname === "app.jobvite.com") return (routes.feed ?? (() => text(JOBVITE_FEED)))();
    if (url.pathname.endsWith("/jobs")) return (routes.list ?? (() => text(jobviteListPage(JOBVITE_ROWS))))();
    return (routes.posting ?? (() => text(jobviteDetailPage())))(url.pathname.split("/").pop() ?? "");
  }));
  return calls;
}

beforeEach(() => {
  process.env.AUTOAPPLY_MIN_INTERVAL_MS = "0";
  delete process.env.AUTOAPPLY_JOBVITE_MAX_POSTINGS;
  delete process.env.AUTOAPPLY_JOBVITE_MAX_DETAILS;
  vi.spyOn(logger, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.AUTOAPPLY_JOBVITE_MAX_POSTINGS;
  delete process.env.AUTOAPPLY_JOBVITE_MAX_DETAILS;
});

describe("jobvite board", () => {
  it("accepts the vanity slug", () => {
    expect(parseJobviteBoard("TylerTech")).toBe("tylertech");
  });

  it.each(["tyler tech", "jobs.jobvite.com/tylertech", ""])("rejects %j", (board) => {
    expect(() => parseJobviteBoard(board)).toThrow(AppError);
  });

  it("names the slug of a pasted board URL", () => {
    expect(() => parseJobviteBoard("https://jobs.jobvite.com/tylertech/jobs")).toThrow(/use the board "tylertech"/);
  });

  it("builds the job list page and probes it for a slug", () => {
    expect(jobviteAdapter.listUrl(company())).toBe("https://jobs.jobvite.com/tylertech/jobs");
    expect(jobviteAdapter.boardUrl(company())).toBe("https://jobs.jobvite.com/tylertech/jobs");
    expect(jobviteAdapter.probeUrls("Acme")).toEqual(["https://jobs.jobvite.com/acme/jobs"]);
    expect(jobviteAdapter.probeUrls("a b")).toEqual([]);
  });
});

describe("jobvite parsing", () => {
  it("merges feed rows that share an id and drops unusable ones", () => {
    const jobs = parseJobviteFeed(JOBVITE_FEED);
    expect(jobs.map((job) => [job.id, job.locations])).toEqual([
      ["odUyAfwZ", ["Vancouver, BC, Canada"]],
      ["odCGAfwP", ["Plano, TX, United States", "Ahmedabad, Gujarat, India"]],
    ]);
    expect(jobs[0]!.descriptionHtml).toContain("<p>The Professional Services Manager leads the Implementation &amp; Data Conversion teams.</p>");
  });

  it("stops at an unterminated job instead of scanning on", () => {
    expect(parseJobviteFeed("<result><job><id>abcd1234</id><title>Open")).toEqual([]);
  });

  it("reads list rows, leaving multi-location rows without a place", () => {
    expect(parseJobviteList(jobviteListPage(JOBVITE_ROWS), JOBVITE_SLUG)).toEqual([
      { id: "odUyAfwZ", title: "Professional Service Manager", location: "Vancouver, BC" },
      { id: "odCGAfwP", title: "Receptionist", location: "" },
    ]);
  });
});

describe("jobvite listing", () => {
  it("reads the feed found through the board page", async () => {
    const calls = stub({});

    const jobs = await jobviteAdapter.listJobs(company(), capturedAt);

    expect(calls.map((url) => url.hostname)).toEqual(["jobs.jobvite.com", "app.jobvite.com"]);
    // Branded tenants redirect the board off jobs.jobvite.com without these.
    expect(calls[0]!.search).toBe("?nl=1&fr=true");
    expect(calls[1]!.searchParams.get("c")).toBe(JOBVITE_COMPANY_ID);
    expect(jobs).toHaveLength(2);
    expect(jobs[0]).toMatchObject({
      ats: "jobvite",
      externalId: "odUyAfwZ",
      url: "https://jobs.jobvite.com/tylertech/job/odUyAfwZ",
      locationClass: "canada",
      country: "CA",
      postedAt: "2026-08-26T00:00:00.000Z",
      employmentType: "full-time",
      compensation: { min: 110_000, max: 140_000, currency: "CAD", period: "year", source: "ats-structured" },
    });
    expect(jobs[0]!.applyUrl).toBe(jobs[0]!.url);
    expect(jobs[0]!.descriptionText).toContain("Implementation & Data Conversion");
    // Open in the US and India: no single published country, so the US office decides.
    expect(jobs[1]).toMatchObject({ country: "US", locationClass: "us-other" });
  });

  it("falls back to posting pages when the feed is refused", async () => {
    // A 429 takes the same path after http.ts has spent its retries.
    const calls = stub({ feed: () => text("Forbidden", 403) });

    const jobs = await jobviteAdapter.listJobs(company(), capturedAt);

    expect(jobs.map((job) => [job.externalId, job.locationsRaw])).toEqual([
      ["odUyAfwZ", ["Plano, Texas"]],
      ["odCGAfwP", ["Plano, Texas"]],
    ]);
    expect(jobs[0]!.descriptionText).toContain("first point of contact");
    expect(calls.filter((url) => url.pathname.includes("/job/"))).toHaveLength(2);
  });

  it("caps detail pages on the fallback path and keeps rows whose page fails", async () => {
    process.env.AUTOAPPLY_JOBVITE_MAX_DETAILS = "1";
    const calls = stub({ list: () => text(jobviteListPage(JOBVITE_ROWS, null)), posting: () => text("blocked", 403) });

    const jobs = await jobviteAdapter.listJobs(company(), capturedAt);

    expect(jobs.map((job) => [job.externalId, job.locationsRaw])).toEqual([["odUyAfwZ", ["Vancouver, BC"]], ["odCGAfwP", []]]);
    expect(calls.filter((url) => url.pathname.includes("/job/"))).toHaveLength(1);
  });

  it("drops a posting that disappeared and parses salary notes from the page", async () => {
    stub({
      list: () => text(jobviteListPage(JOBVITE_ROWS, null)),
      posting: (id) => (id === "odCGAfwP" ? text(JOBVITE_MISSING_PAGE) : text(jobviteDetailPage("Professional Service Manager", "Vancouver,\n BC", "<br>Salary: CAD 110000.00 - 140000.00 Annually<br>"))),
    });

    const jobs = await jobviteAdapter.listJobs(company(), capturedAt);

    expect(jobs.map((job) => job.externalId)).toEqual(["odUyAfwZ"]);
    expect(jobs[0]!.locationsRaw).toEqual(["Vancouver, BC"]);
    expect(jobs[0]!.compensation).toMatchObject({ min: 110_000, max: 140_000, currency: "CAD" });
  });

  it("stops at the posting cap", async () => {
    process.env.AUTOAPPLY_JOBVITE_MAX_POSTINGS = "1";
    stub({});
    expect(await jobviteAdapter.listJobs(company(), capturedAt)).toHaveLength(1);
  });

  it("returns an empty board when the board lists nothing", async () => {
    stub({ list: () => text(jobviteListPage([])), feed: () => text("<html>NoJobs</html>") });
    expect(await jobviteAdapter.listJobs(company(), capturedAt)).toEqual([]);
  });

  it("verifies from the job list page alone", async () => {
    const calls = stub({});
    expect(await jobviteAdapter.verifyBoard!(company())).toMatchObject({ ok: true, postings: 2 });
    expect(calls).toHaveLength(1);
  });
});

describe("jobvite postings", () => {
  it.each([
    ["https://jobs.jobvite.com/tylertech/job/odUyAfwZ", "odUyAfwZ"],
    ["https://jobs.jobvite.com/careers/tylertech/job/odUyAfwZ/apply", "odUyAfwZ"],
  ])("recognizes %s", (raw, id) => {
    expect(jobviteAdapter.parsePostingUrl!(new URL(raw))).toEqual({ board: "tylertech", externalId: id });
  });

  it.each(["https://jobs.jobvite.com/tylertech/jobs", "https://app.jobvite.com/CompanyJobs/Job.aspx?c=q6NaVfwI&j=odUyAfwZ"])("ignores %s", (raw) => {
    expect(jobviteAdapter.parsePostingUrl!(new URL(raw))).toBeNull();
  });

  it("fetches one posting from its page", async () => {
    stub({});
    expect(await jobviteAdapter.fetchPosting!(company(), "odCGAfwP", capturedAt)).toMatchObject({ title: "Receptionist", locationsRaw: ["Plano, Texas"] });
    stub({ posting: () => text(JOBVITE_MISSING_PAGE) });
    expect(await jobviteAdapter.fetchPosting!(company(), "oAAAAAAA", capturedAt)).toBeNull();
    await expect(jobviteAdapter.fetchPosting!(company(), "../x", capturedAt)).rejects.toThrow(/not a Jobvite job id/);
  });

  it("reads open, closed and unknown from the posting page", async () => {
    stub({});
    const [job] = await jobviteAdapter.listJobs(company(), capturedAt);
    vi.unstubAllGlobals();

    stub({});
    expect(await jobviteAdapter.checkPosting!(job!)).toMatchObject({ status: "open", via: "page" });

    // Jobvite answers a removed posting with a 303 to the list page and an error banner.
    stub({ posting: () => new Response(null, { status: 303, headers: { location: "/careers/tylertech/jobs?error=404" } }), list: () => text(JOBVITE_MISSING_PAGE) });
    expect(await jobviteAdapter.checkPosting!(job!)).toMatchObject({ status: "closed" });

    stub({ posting: () => text("<html>maintenance</html>") });
    expect(await jobviteAdapter.checkPosting!(job!)).toMatchObject({ status: "unknown" });

    stub({ posting: () => new Response(null, { status: 302, headers: { location: "https://evil.example.com/" } }) });
    expect(await jobviteAdapter.checkPosting!(job!)).toMatchObject({ status: "unknown" });

    expect(await jobviteAdapter.checkPosting!({ ...job!, externalId: "../x" })).toMatchObject({ status: "unknown" });
    expect(await jobviteAdapter.checkPosting!({ ...job!, board: "a b" })).toMatchObject({ status: "unknown" });
  });
});
