import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanySchema } from "../src/domain/campaign.js";
import { AppError } from "../src/util/errors.js";
import { logger } from "../src/util/logger.js";
import { cornerstoneAdapter, parseCsodBoard } from "../src/sources/cornerstone.js";
import {
  CSOD_BOARD, CSOD_HOME, CSOD_NOT_FOUND, CSOD_TOKEN, csodDetail, csodPostings, csodRequisition, csodSearch,
} from "./fixtures/cornerstone.js";

const capturedAt = "2026-11-07T00:00:00.000Z";

function company(overrides: Record<string, unknown> = {}) {
  return CompanySchema.parse({ name: "Cornerstone OnDemand", ats: "csod", board: CSOD_BOARD, ...overrides });
}

let tenant = 0;
/** A board of its own, so the cached anonymous token never leaks between tests. */
function freshCompany(overrides: Record<string, unknown> = {}) {
  tenant += 1;
  return company({ board: `tenant${tenant}/2`, ...overrides });
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

type Routes = {
  home?: () => Response;
  search?: (body: Record<string, unknown>) => Response;
  detail?: (id: string) => Response;
  postings?: (id: string) => Response;
};

type Call = { url: URL; init?: RequestInit };

function stub(routes: Routes): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    calls.push({ url, init });
    if (url.pathname.includes("/home")) return (routes.home ?? (() => new Response(CSOD_HOME)))();
    if (url.pathname.endsWith("/career-site/v1/search")) {
      return (routes.search ?? (() => json(csodSearch([csodRequisition(11779, "Senior Software Engineer")]))))(JSON.parse(String(init?.body)));
    }
    const detailId = /requisitions\/(\d+)\/jobDetails/.exec(url.pathname)?.[1];
    if (detailId) return (routes.detail ?? (() => json(csodDetail())))(detailId);
    const postingId = /career-site\/v1\/requisition\/(\d+)/.exec(url.pathname)?.[1] ?? "";
    return (routes.postings ?? (() => json(csodPostings([{ careerSiteId: 2, startDate: "2026-11-06T00:00:00" }]))))(postingId);
  }));
  return calls;
}

beforeEach(() => {
  process.env.AUTOAPPLY_MIN_INTERVAL_MS = "0";
  delete process.env.AUTOAPPLY_CSOD_MAX_POSTINGS;
  delete process.env.AUTOAPPLY_CSOD_MAX_DETAILS;
  vi.spyOn(logger, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.AUTOAPPLY_CSOD_MAX_POSTINGS;
  delete process.env.AUTOAPPLY_CSOD_MAX_DETAILS;
});

describe("cornerstone board", () => {
  it("reads host, career site id and an optional corp name", () => {
    expect(parseCsodBoard(CSOD_BOARD)).toEqual({ host: "cornerstone.csod.com", siteId: 2, corp: "cornerstone" });
    expect(parseCsodBoard("cornerstone/2")).toEqual({ host: "cornerstone.csod.com", siteId: 2, corp: "cornerstone" });
    expect(parseCsodBoard("career-ohb.csod.com/4/career-ohb")).toMatchObject({ siteId: 4, corp: "career-ohb" });
  });

  it.each(["cornerstone.csod.com", "cornerstone.csod.com/x", "example.com/2", "cornerstone/2/c/d"])("rejects %s", (board) => {
    expect(() => parseCsodBoard(board)).toThrow(AppError);
    expect(() => parseCsodBoard(board)).toThrow(/cornerstone\.csod\.com\/2/);
  });

  it("names the board a pasted career-site URL points at", () => {
    expect(() => parseCsodBoard("https://acme.csod.com/ux/ats/careersite/5/home?c=acme-corp")).toThrow(/use the board "acme\.csod\.com\/5\/acme-corp"/);
  });

  it("builds the career-site home and the search endpoint", () => {
    expect(cornerstoneAdapter.boardUrl(company())).toBe("https://cornerstone.csod.com/ux/ats/careersite/2/home?c=cornerstone");
    expect(cornerstoneAdapter.listUrl(company())).toBe("https://cornerstone.csod.com/services/x/career-site/v1/search");
    expect(cornerstoneAdapter.probeUrls("cornerstone")).toEqual([]);
  });
});

describe("cornerstone listing", () => {
  it("boots the anonymous token once and sends it with every API call", async () => {
    const calls = stub({});

    const [job] = await cornerstoneAdapter.listJobs(company(), capturedAt);

    expect(job).toMatchObject({
      ats: "csod",
      externalId: "11779",
      title: "Senior Software Engineer",
      url: "https://cornerstone.csod.com/ux/ats/careersite/2/home/requisition/11779?c=cornerstone",
      locationsRaw: ["Santa Monica, CA, United States"],
      locationClass: "us-other",
      country: "US",
      postedAt: "2026-11-06T00:00:00.000Z",
    });
    expect(job!.applyUrl).toBe(job!.url);
    expect(job!.compensation).toMatchObject({ min: 150_000, max: 190_000 });
    const api = calls.filter((call) => call.url.pathname.startsWith("/services/"));
    expect(api.every((call) => new Headers(call.init?.headers).get("authorization") === `Bearer ${CSOD_TOKEN}`)).toBe(true);

    const again = stub({});
    await cornerstoneAdapter.listJobs(company(), capturedAt);
    expect(again.filter((call) => call.url.pathname.includes("/home"))).toHaveLength(0);
  });

  it("drops a foreign region code and keeps the country name", async () => {
    stub({ search: () => json(csodSearch([csodRequisition(1, "Designer", "IN", "Hyderabad", "TG")])) });
    const [job] = await cornerstoneAdapter.listJobs(freshCompany(), capturedAt);
    expect(job).toMatchObject({ locationsRaw: ["Hyderabad, India"], locationClass: "other" });
  });

  it("pages until the total and sends the query", async () => {
    process.env.AUTOAPPLY_CSOD_MAX_DETAILS = "0";
    const bodies: Record<string, unknown>[] = [];
    stub({
      search: (body) => {
        bodies.push(body);
        const page = Number(body.pageNumber);
        const count = page === 1 ? 25 : 2;
        return json(csodSearch(Array.from({ length: count }, (_unused, index) => csodRequisition(page * 100 + index, `Role ${index}`)), 27));
      },
    });

    const jobs = await cornerstoneAdapter.listJobs(freshCompany({ query: "designer" }), capturedAt);

    expect(jobs).toHaveLength(27);
    expect(bodies.map((body) => body.pageNumber)).toEqual([1, 2]);
    expect(bodies[0]).toMatchObject({ careerSiteId: 2, pageSize: 25, searchText: "designer", cultureId: 1, cultureName: "en-US" });
  });

  it("caps postings and details, keeps failing details and drops missing requisitions", async () => {
    process.env.AUTOAPPLY_CSOD_MAX_POSTINGS = "3";
    process.env.AUTOAPPLY_CSOD_MAX_DETAILS = "2";
    const calls = stub({
      search: () => json(csodSearch([csodRequisition(1, "One"), csodRequisition(2, "Two"), csodRequisition(3, "Three"), csodRequisition(4, "Four")], 400)),
      detail: (id) => (id === "1" ? json(CSOD_NOT_FOUND, 404) : json({ message: "nope" }, 403)),
    });

    const jobs = await cornerstoneAdapter.listJobs(freshCompany(), capturedAt);

    expect(jobs.map((job) => job.externalId)).toEqual(["2", "3"]);
    expect(calls.filter((call) => call.url.pathname.includes("/jobDetails"))).toHaveLength(2);
  });

  it("fails clearly when the home page carries no token", async () => {
    stub({ home: () => new Response("<html>Unauthorized</html>") });
    await expect(cornerstoneAdapter.listJobs(freshCompany(), capturedAt)).rejects.toThrow(/no anonymous career-site token/);
  });

  it("verifies with one small search", async () => {
    stub({ search: () => json(csodSearch([csodRequisition(1, "Engineer")], 129)) });
    expect(await cornerstoneAdapter.verifyBoard!(freshCompany())).toMatchObject({ ok: true, postings: 129 });
  });
});

describe("cornerstone postings", () => {
  it("recognizes a requisition URL", () => {
    expect(cornerstoneAdapter.parsePostingUrl!(new URL("https://cornerstone.csod.com/ux/ats/careersite/2/home/requisition/11779?c=cornerstone")))
      .toEqual({ board: CSOD_BOARD, externalId: "11779" });
    expect(cornerstoneAdapter.parsePostingUrl!(new URL("https://career-ohb.csod.com/ux/ats/careersite/4/home/requisition/88?c=ohb")))
      .toEqual({ board: "career-ohb.csod.com/4/ohb", externalId: "88" });
    expect(cornerstoneAdapter.parsePostingUrl!(new URL("https://cornerstone.csod.com/ux/ats/careersite/2/home?c=cornerstone"))).toBeNull();
  });

  it("fetches an open requisition and returns null once it is unposted or gone", async () => {
    const board = freshCompany();
    stub({});
    expect(await cornerstoneAdapter.fetchPosting!(board, "11779", capturedAt)).toMatchObject({ title: "Senior Software Engineer", postedAt: "2026-11-06T23:00:14.000Z" });
    stub({ postings: () => json(csodPostings([])) });
    expect(await cornerstoneAdapter.fetchPosting!(board, "11779", capturedAt)).toBeNull();
    stub({ detail: () => json(CSOD_NOT_FOUND, 404) });
    expect(await cornerstoneAdapter.fetchPosting!(board, "11779", capturedAt)).toBeNull();
    await expect(cornerstoneAdapter.fetchPosting!(board, "x", capturedAt)).rejects.toThrow(/not a Cornerstone requisition id/);
  });

  it("reads open, closed and unknown from the requisition's postings", async () => {
    const board = freshCompany();
    stub({});
    const [job] = await cornerstoneAdapter.listJobs(board, capturedAt);
    vi.unstubAllGlobals();

    stub({});
    expect(await cornerstoneAdapter.checkPosting!(job!)).toMatchObject({ status: "open", via: "api" });

    stub({ postings: () => json(csodPostings([{ careerSiteId: 9 }])) });
    expect(await cornerstoneAdapter.checkPosting!(job!)).toMatchObject({ status: "closed" });

    stub({ postings: () => json(csodPostings([{ careerSiteId: 2, endDate: "2020-01-01T00:00:00" }])) });
    expect(await cornerstoneAdapter.checkPosting!(job!)).toMatchObject({ status: "closed" });

    stub({ postings: () => json(csodPostings([{ careerSiteId: 2, startDate: "2999-01-01T00:00:00" }])) });
    expect(await cornerstoneAdapter.checkPosting!(job!)).toMatchObject({ status: "closed" });

    stub({ detail: () => json(CSOD_NOT_FOUND, 404) });
    expect(await cornerstoneAdapter.checkPosting!(job!)).toMatchObject({ status: "closed" });

    stub({ detail: () => json({ message: "CSOD Unauthorized" }, 401) });
    expect(await cornerstoneAdapter.checkPosting!(job!)).toMatchObject({ status: "unknown" });

    expect(await cornerstoneAdapter.checkPosting!({ ...job!, externalId: "x" })).toMatchObject({ status: "unknown" });
    expect(await cornerstoneAdapter.checkPosting!({ ...job!, board: "bad" })).toMatchObject({ status: "unknown" });
  });
});
