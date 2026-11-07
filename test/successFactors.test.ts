import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanySchema } from "../src/domain/campaign.js";
import { AppError } from "../src/util/errors.js";
import { logger } from "../src/util/logger.js";
import { parseSuccessFactorsBoard, successFactorsAdapter } from "../src/sources/successFactors.js";
import { anyDate, epochSeconds, isoInstant, namedMonthDate, usDate } from "../src/sources/enterprise/dates.js";
import { parseSuccessFactorsTiles, slugLocation } from "../src/sources/enterprise/successFactorsPage.js";
import {
  SF_ERROR_PAGE, SF_HOST, SF_TILE_MANKATO, SF_TILE_WITH_SECTIONS, csbPage, sfDetailPage, sfTile, sfTilesFragment,
} from "./fixtures/successFactors.js";

const capturedAt = "2026-11-07T00:00:00.000Z";

function company(overrides: Record<string, unknown> = {}) {
  return CompanySchema.parse({ name: "ZF Group", ats: "successfactors", board: SF_HOST, ...overrides });
}

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/html" } });
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

type Call = { url: URL; init?: RequestInit };

function stub(routes: {
  tiles?: (startRow: number, url: URL) => Response;
  csb?: (body: Record<string, unknown>) => Response;
  page?: (url: URL) => Response;
}): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    calls.push({ url, init });
    if (url.pathname.endsWith("/tile-search-results/")) return (routes.tiles ?? (() => html("")))(Number(url.searchParams.get("startrow")), url);
    if (url.pathname.endsWith("/services/recruiting/v1/jobs")) return (routes.csb ?? (() => json({}, 404)))(JSON.parse(String(init?.body)));
    return (routes.page ?? (() => html(sfDetailPage())))(url);
  }));
  return calls;
}

function tile(index: number): string {
  return sfTile(String(1000 + index), `/job/Austin-Engineer-${index}-TX-73301/${1000 + index}/`, `Engineer ${index}`);
}

beforeEach(() => {
  process.env.AUTOAPPLY_MIN_INTERVAL_MS = "0";
  delete process.env.AUTOAPPLY_SUCCESSFACTORS_MAX_POSTINGS;
  delete process.env.AUTOAPPLY_SUCCESSFACTORS_MAX_DETAILS;
  vi.spyOn(logger, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.AUTOAPPLY_SUCCESSFACTORS_MAX_POSTINGS;
  delete process.env.AUTOAPPLY_SUCCESSFACTORS_MAX_DETAILS;
});

describe("enterprise date readers", () => {
  it("reads ISO dates and offsets written without a colon", () => {
    expect(isoInstant("2026-11-06")).toBe("2026-11-06T00:00:00.000Z");
    expect(isoInstant("2026-06-16T00:00:00.000+0000")).toBe("2026-06-16T00:00:00.000Z");
    expect(isoInstant("2026-11-06T19:48:29+00:00")).toBe("2026-11-06T19:48:29.000Z");
    expect(isoInstant("2026-11-07T02:28:00")).toBe("2026-11-07T02:28:00.000Z");
    expect(isoInstant("2026-02-30")).toBeNull();
    expect(isoInstant("Nov 6")).toBeNull();
    expect(isoInstant(20261106)).toBeNull();
  });

  it("reads US month-first dates with two- or four-digit years", () => {
    expect(usDate("11/6/2026")).toBe("2026-11-06T00:00:00.000Z");
    expect(usDate("7/3/25")).toBe("2025-07-03T00:00:00.000Z");
    expect(usDate("13/1/2026")).toBeNull();
    expect(usDate(null)).toBeNull();
  });

  it("reads spelled-out months, including Java's Date.toString", () => {
    expect(namedMonthDate("Oct 16, 2026")).toBe("2026-10-16T00:00:00.000Z");
    expect(namedMonthDate("16-Oct-2026")).toBe("2026-10-16T00:00:00.000Z");
    expect(namedMonthDate("September 1 2026")).toBe("2026-09-01T00:00:00.000Z");
    expect(namedMonthDate("Fri Nov 06 02:01:00 UTC 2026")).toBe("2026-11-06T02:01:00.000Z");
    expect(namedMonthDate("Fri Foo 06 02:01:00 UTC 2026")).toBeNull();
    expect(namedMonthDate("Smarch 3, 2026")).toBeNull();
    expect(namedMonthDate(undefined)).toBeNull();
  });

  it("reads epoch seconds and tries every format in turn", () => {
    expect(epochSeconds(1793923200)).toBe("2026-11-06T00:00:00.000Z");
    expect(epochSeconds("1793923200")).toBe("2026-11-06T00:00:00.000Z");
    expect(epochSeconds(0)).toBeNull();
    expect(epochSeconds("soon")).toBeNull();
    expect(anyDate("11/6/2026")).toBe("2026-11-06T00:00:00.000Z");
    expect(anyDate("Nov 6, 2026")).toBe("2026-11-06T00:00:00.000Z");
    expect(anyDate("recently")).toBeNull();
  });
});

describe("successfactors board", () => {
  it("accepts a career-site host with an optional brand path", () => {
    expect(parseSuccessFactorsBoard("jobs.zf.com")).toEqual({ host: "jobs.zf.com", prefix: "" });
    expect(parseSuccessFactorsBoard("careers.example.com/Bluebeam")).toEqual({ host: "careers.example.com", prefix: "/Bluebeam" });
  });

  it.each(["zf", "jobs.zf.com/a b", "jobs.zf.com/a/b/c"])("rejects %s", (board) => {
    expect(() => parseSuccessFactorsBoard(board)).toThrow(AppError);
    expect(() => parseSuccessFactorsBoard(board)).toThrow(/jobs\.zf\.com/);
  });

  it("names the host of a pasted careers URL", () => {
    expect(() => parseSuccessFactorsBoard("https://jobs.zf.com/search/?q=engineer")).toThrow(/use the board "jobs\.zf\.com"/);
  });

  it("builds the tile endpoint with the query and newest-first sort", () => {
    const url = new URL(successFactorsAdapter.listUrl(company({ query: "software" })));
    expect(url.pathname).toBe("/tile-search-results/");
    expect(Object.fromEntries(url.searchParams)).toEqual({ q: "software", sortColumn: "referencedate", sortDirection: "desc", startrow: "0" });
    expect(successFactorsAdapter.boardUrl(company())).toBe("https://jobs.zf.com/search/");
    expect(successFactorsAdapter.probeUrls("zf")).toEqual([]);
  });
});

describe("successfactors tiles", () => {
  it("reads each tile once despite its three responsive copies", () => {
    const tiles = parseSuccessFactorsTiles(sfTilesFragment([SF_TILE_MANKATO, SF_TILE_WITH_SECTIONS]));
    expect(tiles).toEqual([
      { id: "1445700033", path: "/job/North-Mankato-Virtual-Career-Conversation-MN-56003/1445700033/", title: "Virtual Career Conversation", location: "North Mankato, MN 56003", postedAt: null },
      { id: "1445741233", path: "/job/Farmington-Hills-Project-Manager-III-MI-48331/1445741233/", title: "Project Manager III", location: "Farmington Hills, MI", postedAt: "2026-11-06T00:00:00.000Z" },
    ]);
  });

  it("recovers a city from the slug only when the title lines up", () => {
    expect(slugLocation("/job/El-Marqu%C3%A9s-General-Accountant-Quer-76246/1/", "General Accountant")).toBe("El Marqués");
    expect(slugLocation("/job/General-Accountant/1/", "General Accountant")).toBe("");
    expect(slugLocation("/job/%E0%A4%A/1/", "Engineer")).toBe("");
  });
});

describe("successfactors listing", () => {
  it("merges tiles with job-page microdata", async () => {
    stub({ tiles: () => html(sfTilesFragment([SF_TILE_MANKATO])) });

    const [job] = await successFactorsAdapter.listJobs(company(), capturedAt);

    expect(job).toMatchObject({
      ats: "successfactors",
      externalId: "1445700033",
      title: "Virtual Career Conversation",
      url: "https://jobs.zf.com/job/North-Mankato-Virtual-Career-Conversation-MN-56003/1445700033/",
      locationsRaw: ["North Mankato, MN, United States"],
      country: "US",
      postedAt: "2026-11-06T02:01:00.000Z",
    });
    expect(job!.descriptionText).toContain("At ZF you are part of something greater!");
    expect(job!.compensation).toMatchObject({ min: 72_000, max: 90_000 });
  });

  it("drops a foreign region code from the job page address", async () => {
    stub({ tiles: () => html(sfTilesFragment([SF_TILE_MANKATO])), page: () => html(sfDetailPage({ city: "Chennai", region: "TN", country: "IN" })) });

    const [job] = await successFactorsAdapter.listJobs(company(), capturedAt);

    expect(job).toMatchObject({ locationsRaw: ["Chennai, India"], locationClass: "other" });
  });

  it("keeps tile fields past the detail cap and when a job page fails", async () => {
    process.env.AUTOAPPLY_SUCCESSFACTORS_MAX_DETAILS = "1";
    const calls = stub({
      tiles: () => html(sfTilesFragment([SF_TILE_MANKATO, SF_TILE_WITH_SECTIONS])),
      page: () => html("blocked", 403),
    });

    const jobs = await successFactorsAdapter.listJobs(company(), capturedAt);

    expect(jobs.map((job) => [job.externalId, job.locationsRaw[0]])).toEqual([
      ["1445700033", "North Mankato, MN 56003"],
      ["1445741233", "Farmington Hills, MI"],
    ]);
    expect(calls.filter((call) => call.url.pathname.startsWith("/job/"))).toHaveLength(1);
  });

  it("drops a posting whose page redirects to the error page", async () => {
    stub({ tiles: () => html(sfTilesFragment([SF_TILE_MANKATO, SF_TILE_WITH_SECTIONS])), page: (url) => (url.pathname.includes("1445700033") ? html(SF_ERROR_PAGE) : html(sfDetailPage({ title: "Project Manager III" }))) });

    const jobs = await successFactorsAdapter.listJobs(company(), capturedAt);

    expect(jobs.map((job) => job.externalId)).toEqual(["1445741233"]);
  });

  it("advances startrow by tiles read and stops on a short page", async () => {
    process.env.AUTOAPPLY_SUCCESSFACTORS_MAX_DETAILS = "0";
    const calls = stub({
      tiles: (start) => html(sfTilesFragment(start === 0 ? [tile(0), tile(1), tile(2)] : [tile(3)])),
    });

    const jobs = await successFactorsAdapter.listJobs(company({ query: "engineer" }), capturedAt);

    expect(jobs).toHaveLength(4);
    expect(calls.map((call) => call.url.searchParams.get("startrow"))).toEqual(["0", "3"]);
    expect(calls[0]!.url.searchParams.get("q")).toBe("engineer");
  });

  it("stops when the site ignores startrow and repeats a page", async () => {
    process.env.AUTOAPPLY_SUCCESSFACTORS_MAX_DETAILS = "0";
    const calls = stub({ tiles: () => html(sfTilesFragment([tile(0), tile(1)])) });

    expect(await successFactorsAdapter.listJobs(company(), capturedAt)).toHaveLength(2);
    expect(calls).toHaveLength(2);
  });

  it("stops at the posting cap", async () => {
    process.env.AUTOAPPLY_SUCCESSFACTORS_MAX_POSTINGS = "2";
    process.env.AUTOAPPLY_SUCCESSFACTORS_MAX_DETAILS = "0";
    const calls = stub({ tiles: () => html(sfTilesFragment([tile(0), tile(1), tile(2)])) });

    expect(await successFactorsAdapter.listJobs(company(), capturedAt)).toHaveLength(2);
    expect(calls).toHaveLength(1);
  });

  it("falls back to the CSB search API when the tile endpoint is an empty shell", async () => {
    const calls = stub({
      tiles: () => html("<!DOCTYPE html>"),
      csb: (body) => json(csbPage(body.pageNumber === 0
        ? Array.from({ length: 10 }, (_unused, index) => ({ id: String(index + 1), title: `Associate ${index + 1}` }))
        : [{ id: "11", title: "Bodyworker associate", start: "7/3/25", location: ["Greer, SC, USA, <br/>"] }], 11)),
    });

    const jobs = await successFactorsAdapter.listJobs(company({ board: "jobs.bmwgroup.com", query: "associate" }), capturedAt);

    expect(jobs).toHaveLength(11);
    expect(jobs[10]).toMatchObject({
      externalId: "11",
      url: "https://jobs.bmwgroup.com/job/Bodyworker-associate/11-en_US",
      postedAt: "2025-07-03T00:00:00.000Z",
      locationsRaw: ["Greer, SC, USA"],
      country: "US",
    });
    const bodies = calls.filter((call) => call.init?.body).map((call) => JSON.parse(String(call.init!.body)));
    expect(bodies.map((body) => body.pageNumber)).toEqual([0, 1]);
    expect(bodies[0]).toMatchObject({ keywords: "associate", locale: "en_US", sortBy: "date" });
  });

  it("treats a missing CSB API on an empty tile board as an empty board", async () => {
    stub({ tiles: () => html("<!DOCTYPE html>"), csb: () => json({ message: "nope" }, 404) });
    expect(await successFactorsAdapter.listJobs(company(), capturedAt)).toEqual([]);
  });

  it("verifies from the first tile page, falling back to CSB", async () => {
    stub({ tiles: () => html(sfTilesFragment([SF_TILE_MANKATO])) });
    expect(await successFactorsAdapter.verifyBoard!(company())).toMatchObject({ ok: true, postings: 1 });

    stub({ tiles: () => html("<!DOCTYPE html>"), csb: () => json(csbPage([{ id: "1", title: "Associate" }], 215)) });
    expect(await successFactorsAdapter.verifyBoard!(company())).toMatchObject({ ok: true, postings: 215, sampleTitles: ["Associate"] });
  });
});

describe("successfactors postings", () => {
  it.each([
    ["https://jobs.zf.com/job/North-Mankato-Virtual-Career-Conversation-MN-56003/1445700033/", { board: "jobs.zf.com", externalId: "1445700033" }],
    ["https://careers.example.com/Bluebeam/job/Austin-Engineer-TX-73301/123456/", { board: "careers.example.com/Bluebeam", externalId: "123456" }],
  ])("recognizes %s", (raw, ref) => {
    expect(successFactorsAdapter.parsePostingUrl!(new URL(raw))).toEqual(ref);
  });

  it.each(["https://jobs.bmwgroup.com/job/Bodyworker-associate/149752-en_US", "https://jobs.zf.com/search/"])("ignores %s", (raw) => {
    expect(successFactorsAdapter.parsePostingUrl!(new URL(raw))).toBeNull();
  });

  it("fetches one posting by id with a placeholder slug", async () => {
    const calls = stub({});
    const job = await successFactorsAdapter.fetchPosting!(company(), "1445700033", capturedAt);
    expect(calls[0]!.url.pathname).toBe("/job/job/1445700033/");
    expect(job).toMatchObject({ externalId: "1445700033", title: "Virtual Career Conversation", country: "US" });

    stub({ page: () => html(SF_ERROR_PAGE) });
    expect(await successFactorsAdapter.fetchPosting!(company(), "1", capturedAt)).toBeNull();
    await expect(successFactorsAdapter.fetchPosting!(company(), "1-en_US", capturedAt)).rejects.toThrow(/numeric/);
  });

  async function storedJob() {
    stub({ tiles: () => html(sfTilesFragment([SF_TILE_MANKATO])) });
    const [job] = await successFactorsAdapter.listJobs(company(), capturedAt);
    vi.unstubAllGlobals();
    return job!;
  }

  it("reads open, closed and unknown from the job page", async () => {
    const job = await storedJob();
    stub({});
    expect(await successFactorsAdapter.checkPosting!(job)).toMatchObject({ status: "open", via: "page" });

    stub({ page: () => html(SF_ERROR_PAGE) });
    expect(await successFactorsAdapter.checkPosting!(job)).toMatchObject({ status: "closed" });

    stub({ page: () => html("gone", 404) });
    expect(await successFactorsAdapter.checkPosting!(job)).toMatchObject({ status: "closed" });

    stub({ page: () => html("<html>Just a moment...</html>", 403) });
    expect(await successFactorsAdapter.checkPosting!(job)).toMatchObject({ status: "unknown" });

    stub({ page: () => html("<html>an unrecognised page</html>") });
    expect(await successFactorsAdapter.checkPosting!(job)).toMatchObject({ status: "unknown" });

    expect(await successFactorsAdapter.checkPosting!({ ...job, url: "https://evil.example.com/job/x/1/" })).toMatchObject({ status: "unknown" });

    // A stored URL that is not a job page must never be read as closed from a 404.
    const calls = stub({ page: () => html("gone", 404) });
    expect(await successFactorsAdapter.checkPosting!({ ...job, url: new URL("/search/?q=x", job.url).href })).toMatchObject({ status: "unknown" });
    expect(calls).toHaveLength(0);
  });

  it("confirms a CSB posting through search and never calls it closed from a miss", async () => {
    const csbJob = { ...(await storedJob()), board: "jobs.bmwgroup.com", title: "Bodyworker associate", url: "https://jobs.bmwgroup.com/job/Bodyworker-associate/149752-en_US" };
    stub({ csb: () => json(csbPage([{ id: "149752", title: "Bodyworker associate" }], 1)) });
    expect(await successFactorsAdapter.checkPosting!(csbJob)).toMatchObject({ status: "open", via: "api" });

    stub({ csb: () => json(csbPage([], 0)) });
    expect(await successFactorsAdapter.checkPosting!(csbJob)).toMatchObject({ status: "unknown" });
  });
});
