import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanySchema } from "../src/domain/campaign.js";
import { AppError } from "../src/util/errors.js";
import { logger } from "../src/util/logger.js";
import { parsePaylocityBoard, parsePaylocityDetail, paylocityAdapter, paylocityPageData } from "../src/sources/paylocity.js";
import { PAYLOCITY_BOARD, PAYLOCITY_NOT_FOUND, paylocityBoardPage, paylocityDetailPage, paylocityJob } from "./fixtures/paylocity.js";

const capturedAt = "2026-11-07T00:00:00.000Z";

function company(overrides: Record<string, unknown> = {}) {
  return CompanySchema.parse({ name: "CloudBees", ats: "paylocity", board: PAYLOCITY_BOARD, ...overrides });
}

function html(body: string, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { "content-type": "text/html", ...headers } });
}

function stub(board: () => Response, detail: (id: string) => Response = () => html(paylocityDetailPage())): URL[] {
  const calls: URL[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const url = new URL(input);
    calls.push(url);
    if (url.pathname.startsWith("/Recruiting/Jobs/All/")) return board();
    if (url.pathname === "/Recruiting/Jobs/JobNotFound") return html(PAYLOCITY_NOT_FOUND);
    return detail(url.pathname.split("/").pop() ?? "");
  }));
  return calls;
}

beforeEach(() => {
  process.env.AUTOAPPLY_MIN_INTERVAL_MS = "0";
  delete process.env.AUTOAPPLY_PAYLOCITY_MAX_POSTINGS;
  delete process.env.AUTOAPPLY_PAYLOCITY_MAX_DETAILS;
  vi.spyOn(logger, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.AUTOAPPLY_PAYLOCITY_MAX_POSTINGS;
  delete process.env.AUTOAPPLY_PAYLOCITY_MAX_DETAILS;
});

describe("paylocity board", () => {
  it("accepts the board GUID", () => {
    expect(parsePaylocityBoard(PAYLOCITY_BOARD.toUpperCase())).toBe(PAYLOCITY_BOARD);
  });

  it.each(["cloudbees", "a432d829", "4628579"])("rejects %s", (board) => {
    expect(() => parsePaylocityBoard(board)).toThrow(AppError);
    expect(() => parsePaylocityBoard(board)).toThrow(/a432d829-f701-4cf3-9108-56ef703b2ac5/);
  });

  it("names the GUID of a pasted board URL", () => {
    expect(() => parsePaylocityBoard(`https://recruiting.paylocity.com/Recruiting/Jobs/All/${PAYLOCITY_BOARD}/CloudBees-Inc`))
      .toThrow(new RegExp(`use the board "${PAYLOCITY_BOARD}"`));
  });

  it("builds the board page and offers no probes or URL parsing", () => {
    expect(paylocityAdapter.boardUrl(company())).toBe(`https://recruiting.paylocity.com/Recruiting/Jobs/All/${PAYLOCITY_BOARD}`);
    expect(paylocityAdapter.listUrl(company())).toBe(paylocityAdapter.boardUrl(company()));
    expect(paylocityAdapter.probeUrls("cloudbees")).toEqual([]);
    // A Details URL does not name its board.
    expect(paylocityAdapter.parsePostingUrl).toBeUndefined();
  });
});

describe("paylocity parsing", () => {
  it("reads the board's pageData and a Details page", () => {
    expect(paylocityPageData(paylocityBoardPage([paylocityJob()])).Jobs).toHaveLength(1);
    expect(() => paylocityPageData(PAYLOCITY_NOT_FOUND)).toThrow(/without a job board/);
    const detail = parsePaylocityDetail(paylocityDetailPage());
    expect(detail).toMatchObject({ title: "Principal Software Engineer, CBCI", location: "Denver, CO" });
    expect(detail!.descriptionHtml).toContain("base salary range");
    expect(detail!.descriptionHtml).not.toContain("Apply</a>");
  });
});

describe("paylocity listing", () => {
  it("reads every posting from one board page and descriptions from Details pages", async () => {
    const calls = stub(() => html(paylocityBoardPage([paylocityJob()])));

    const [job] = await paylocityAdapter.listJobs(company(), capturedAt);

    expect(job).toMatchObject({
      ats: "paylocity",
      externalId: "4628579",
      title: "Principal Software Engineer, CBCI",
      url: "https://recruiting.paylocity.com/Recruiting/Jobs/Details/4628579",
      locationsRaw: ["Denver, CO - Hybrid"],
      locationClass: "us-other",
      workplaceType: "hybrid",
      postedAt: "2026-10-30T15:31:56.000Z",
    });
    expect(job!.applyUrl).toBe(job!.url);
    expect(job!.compensation).toMatchObject({ min: 200_000, max: 230_000 });
    expect(calls).toHaveLength(2);
  });

  it("skips internal and malformed postings and hides locations the employer hides", async () => {
    process.env.AUTOAPPLY_PAYLOCITY_MAX_DETAILS = "0";
    stub(() => html(paylocityBoardPage([
      paylocityJob({ JobId: 1, IsInternal: true }),
      { JobId: "x", JobTitle: "Broken" },
      paylocityJob({ JobId: 2, ShouldDisplayLocation: false, IsRemote: true, IndeedRemoteType: 2 }),
    ])));

    const jobs = await paylocityAdapter.listJobs(company(), capturedAt);

    expect(jobs.map((job) => [job.externalId, job.locationsRaw, job.workplaceType])).toEqual([["2", [], "remote"]]);
    expect(jobs[0]!.descriptionText).toContain("Job Type: Full-time");
  });

  it("caps postings and Details pages, keeps failing pages and drops removed ones", async () => {
    process.env.AUTOAPPLY_PAYLOCITY_MAX_POSTINGS = "3";
    process.env.AUTOAPPLY_PAYLOCITY_MAX_DETAILS = "2";
    const calls = stub(
      () => html(paylocityBoardPage([1, 2, 3, 4].map((JobId) => paylocityJob({ JobId })))),
      (id) => (id === "1" ? html("", 302, { location: "/Recruiting/Jobs/JobNotFound" }) : html("blocked", 403)),
    );

    const jobs = await paylocityAdapter.listJobs(company(), capturedAt);

    expect(jobs.map((job) => job.externalId)).toEqual(["2", "3"]);
    expect(calls.filter((url) => url.pathname.startsWith("/Recruiting/Jobs/Details/"))).toHaveLength(2);
  });

  it("reports an unknown board instead of an empty one", async () => {
    stub(() => html("", 302, { location: "/Recruiting/Jobs/JobNotFound" }));
    await expect(paylocityAdapter.listJobs(company(), capturedAt)).rejects.toThrow(/without a job board/);
  });

  it("verifies from the board page alone", async () => {
    const calls = stub(() => html(paylocityBoardPage([paylocityJob(), paylocityJob({ JobId: 9 })])));
    expect(await paylocityAdapter.verifyBoard!(company())).toMatchObject({ ok: true, postings: 2 });
    expect(calls).toHaveLength(1);
  });
});

describe("paylocity postings", () => {
  it("fetches one posting from its Details page", async () => {
    stub(() => html(""));
    expect(await paylocityAdapter.fetchPosting!(company(), "4628579", capturedAt)).toMatchObject({
      title: "Principal Software Engineer, CBCI", locationsRaw: ["Denver, CO"],
    });
    stub(() => html(""), () => html("", 302, { location: "/Recruiting/Jobs/JobNotFound" }));
    expect(await paylocityAdapter.fetchPosting!(company(), "1", capturedAt)).toBeNull();
    await expect(paylocityAdapter.fetchPosting!(company(), "x", capturedAt)).rejects.toThrow(/not a Paylocity job id/);
  });

  it("reads open, closed and unknown from the Details page", async () => {
    stub(() => html(paylocityBoardPage([paylocityJob()])));
    const [job] = await paylocityAdapter.listJobs(company(), capturedAt);
    vi.unstubAllGlobals();

    stub(() => html(""));
    expect(await paylocityAdapter.checkPosting!(job!)).toMatchObject({ status: "open", via: "page" });

    stub(() => html(""), () => html("", 302, { location: "/Recruiting/Jobs/JobNotFound" }));
    expect(await paylocityAdapter.checkPosting!(job!)).toMatchObject({ status: "closed" });

    stub(() => html(""), () => html("<html>maintenance</html>"));
    expect(await paylocityAdapter.checkPosting!(job!)).toMatchObject({ status: "unknown" });

    stub(() => html(""), () => html("", 302, { location: "https://evil.example.com/" }));
    expect(await paylocityAdapter.checkPosting!(job!)).toMatchObject({ status: "unknown" });

    expect(await paylocityAdapter.checkPosting!({ ...job!, externalId: "x" })).toMatchObject({ status: "unknown" });
    expect(await paylocityAdapter.checkPosting!({ ...job!, board: "x" })).toMatchObject({ status: "unknown" });
  });
});
