import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanySchema } from "../src/domain/campaign.js";
import { AppError } from "../src/util/errors.js";
import { logger } from "../src/util/logger.js";
import { parseTaleoBoard, taleoAdapter } from "../src/sources/taleo.js";
import { parseTaleoDetail, taleoHeadings, taleoLocationCell, taleoPlace, taleoPortal } from "../src/sources/enterprise/taleoPage.js";
import {
  TALEO_BOARD, TALEO_PRIVATE_SHELL, TALEO_SHELL, TALEO_UNAVAILABLE_PAGE, taleoDetailPage, taleoPage, taleoRow,
} from "./fixtures/taleo.js";

const capturedAt = "2026-11-07T00:00:00.000Z";

function company(overrides: Record<string, unknown> = {}) {
  return CompanySchema.parse({ name: "HDR", ats: "taleo", board: TALEO_BOARD, ...overrides });
}

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/html" } });
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

type Call = { url: URL; init?: RequestInit };

function stub(search: (body: Record<string, unknown>) => Response, detail: (job: string) => Response = (job) => html(taleoDetailPage(job)), shell = () => html(TALEO_SHELL)): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    calls.push({ url, init });
    if (url.pathname.endsWith("/jobsearch.ftl")) return shell();
    if (url.pathname.endsWith("/searchjobs")) return search(JSON.parse(String(init?.body)));
    return detail(url.searchParams.get("job") ?? "");
  }));
  return calls;
}

const ROW_DENVER = taleoRow("191953", "Aviation Engineer/Project Manager", '["United States-Colorado-Denver"]', "Mar 24, 2026");
const ROW_MULTI = taleoRow("197081", "Senior Project Manager - Power Transmission", '["Multiple Locations"]', "Oct 19, 2026");

beforeEach(() => {
  process.env.AUTOAPPLY_MIN_INTERVAL_MS = "0";
  delete process.env.AUTOAPPLY_TALEO_MAX_POSTINGS;
  delete process.env.AUTOAPPLY_TALEO_MAX_DETAILS;
  vi.spyOn(logger, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.AUTOAPPLY_TALEO_MAX_POSTINGS;
  delete process.env.AUTOAPPLY_TALEO_MAX_DETAILS;
});

describe("taleo board", () => {
  it("splits host and career section", () => {
    expect(parseTaleoBoard(TALEO_BOARD)).toEqual({ host: "hdr.taleo.net", section: "ex" });
  });

  it.each(["hdr.taleo.net", "chp.tbe.taleo.net/ex", "example.com/ex", "hdr.taleo.net/e x"])("rejects %s", (board) => {
    expect(() => parseTaleoBoard(board)).toThrow(AppError);
    expect(() => parseTaleoBoard(board)).toThrow(/hdr\.taleo\.net\/ex/);
  });

  it("names the board a pasted search URL points at", () => {
    expect(() => parseTaleoBoard("https://hdr.taleo.net/careersection/ex/jobsearch.ftl?lang=en")).toThrow(/use the board "hdr\.taleo\.net\/ex"/);
  });

  it("builds the section's search page and search endpoint", () => {
    expect(taleoAdapter.boardUrl(company())).toBe("https://hdr.taleo.net/careersection/ex/jobsearch.ftl?lang=en");
    expect(taleoAdapter.listUrl(company())).toBe("https://hdr.taleo.net/careersection/rest/jobboard/searchjobs?lang=en");
    expect(taleoAdapter.probeUrls("hdr")).toEqual([]);
  });
});

describe("taleo page parsing", () => {
  it("reads the portal number and result columns from the search page", () => {
    expect(taleoPortal(TALEO_SHELL)).toBe("101430233");
    expect(taleoHeadings(TALEO_SHELL)).toEqual(["Requisition Title", "Location", "Posting Date"]);
    expect(taleoPortal(TALEO_PRIVATE_SHELL)).toBeNull();
  });

  it("reorders country-region-city and splits multi-location cells", () => {
    expect(taleoPlace("United States-Colorado-Denver")).toBe("Denver, Colorado, United States");
    expect(taleoPlace("United States-North Carolina-Winston-Salem")).toBe("Winston-Salem, North Carolina, United States");
    expect(taleoPlace("India-Tamil Nadu-Chennai")).toBe("Chennai, India");
    expect(taleoPlace("Engineer III - Systems")).toBe("Engineer III - Systems");
    expect(taleoLocationCell('["United States-Arizona-Phoenix, United States-Utah-Salt Lake City","Multiple Locations"]'))
      .toEqual(["Phoenix, Arizona, United States", "Salt Lake City, Utah, United States"]);
  });

  it("reads a job page's initialHistory even with a literal percent sign", () => {
    const detail = parseTaleoDetail(taleoDetailPage(), "191953");
    expect(detail).toMatchObject({
      title: "Aviation Engineer/Project Manager",
      locations: ["Denver, Colorado, United States"],
      postedAt: "2026-03-24T00:00:00.000Z",
      employmentType: "Full-time",
    });
    expect(detail!.descriptionHtml).toContain("Travel up to 50% may be required.");
    expect(detail!.descriptionHtml).toContain("Required Qualifications");
    expect(parseTaleoDetail(TALEO_UNAVAILABLE_PAGE, "1")).toBeNull();
  });
});

describe("taleo listing", () => {
  it("maps columns by heading and merges job pages", async () => {
    const calls = stub(() => json(taleoPage([ROW_DENVER, ROW_MULTI])), (job) => html(taleoDetailPage(job, " Senior Project Manager", job === "197081" ? "United States-Arizona-Phoenix, United States-California-Irvine" : "United States-Colorado-Denver")));

    const jobs = await taleoAdapter.listJobs(company(), capturedAt);

    expect(jobs[0]).toMatchObject({
      ats: "taleo",
      externalId: "191953",
      title: "Aviation Engineer/Project Manager",
      url: "https://hdr.taleo.net/careersection/ex/jobdetail.ftl?job=191953&lang=en",
      locationsRaw: ["Denver, Colorado, United States"],
      country: "US",
      postedAt: "2026-03-24T00:00:00.000Z",
      employmentType: "full-time",
    });
    expect(jobs[0]!.applyUrl).toBe(jobs[0]!.url);
    expect(jobs[0]!.descriptionText).toContain("employee-owners");
    // "Multiple Locations" in the list falls back to the job page's places.
    expect(jobs[1]!.locationsRaw).toEqual(["Phoenix, Arizona, United States", "Irvine, California, United States"]);
    const search = calls.find((call) => call.url.pathname.endsWith("/searchjobs"))!;
    expect(search.url.searchParams.get("portal")).toBe("101430233");
    expect(new Headers(search.init!.headers).get("x-requested-with")).toBe("XMLHttpRequest");
  });

  it("pages by page number until the reported total", async () => {
    process.env.AUTOAPPLY_TALEO_MAX_DETAILS = "0";
    const bodies: number[] = [];
    stub((body) => {
      bodies.push(Number(body.pageNo));
      // Uneven pages: a short first page is not the end.
      return json(body.pageNo === 1 ? taleoPage([ROW_DENVER], "3") : body.pageNo === 2 ? taleoPage([ROW_MULTI, taleoRow("3", "Third", "[]", "")], "3") : taleoPage([], "3"));
    });

    const jobs = await taleoAdapter.listJobs(company({ query: "engineer" }), capturedAt);

    expect(jobs.map((job) => job.externalId)).toEqual(["191953", "197081", "3"]);
    expect(bodies).toEqual([1, 2]);
  });

  it("sends the campaign query as the keyword", async () => {
    let keyword = "";
    stub((body) => {
      keyword = (body.fieldData as { fields: { KEYWORD: string } }).fields.KEYWORD;
      return json(taleoPage([]));
    });
    await taleoAdapter.listJobs(company({ query: "project manager" }), capturedAt);
    expect(keyword).toBe("project manager");
  });

  it("caps postings and detail pages", async () => {
    process.env.AUTOAPPLY_TALEO_MAX_POSTINGS = "2";
    process.env.AUTOAPPLY_TALEO_MAX_DETAILS = "1";
    const rows = [ROW_DENVER, ROW_MULTI, taleoRow("3", "Third", "[]", "")];
    const calls = stub(() => json(taleoPage(rows, 900)));

    expect(await taleoAdapter.listJobs(company(), capturedAt)).toHaveLength(2);
    expect(calls.filter((call) => call.url.pathname.endsWith("/jobdetail.ftl"))).toHaveLength(1);
  });

  it("keeps a row whose page fails, drops an unavailable job and skips malformed rows", async () => {
    stub(
      () => json(taleoPage([ROW_DENVER, ROW_MULTI, { contestNo: "../x", column: [] }, taleoRow("4", "Fourth", "[]", "")])),
      (job) => (job === "191953" ? html("blocked", 403) : job === "197081" ? html(TALEO_UNAVAILABLE_PAGE) : html(taleoDetailPage(job))),
    );

    const jobs = await taleoAdapter.listJobs(company(), capturedAt);

    expect(jobs.map((job) => job.externalId)).toEqual(["191953", "4"]);
    expect(jobs[0]!.descriptionText).toBe("");
  });

  it("refuses a private career section clearly", async () => {
    stub(() => json(taleoPage([])), undefined, () => html(TALEO_PRIVATE_SHELL));
    await expect(taleoAdapter.listJobs(company(), capturedAt)).rejects.toThrow(/private or unavailable/);
  });

  it("verifies with the search page and one search", async () => {
    const calls = stub(() => json(taleoPage([ROW_DENVER], 2319)));
    expect(await taleoAdapter.verifyBoard!(company())).toMatchObject({ ok: true, postings: 2319, sampleTitles: ["Aviation Engineer/Project Manager"] });
    expect(calls).toHaveLength(2);
  });
});

describe("taleo postings", () => {
  it("recognizes a job page URL", () => {
    expect(taleoAdapter.parsePostingUrl!(new URL("https://hdr.taleo.net/careersection/ex/jobdetail.ftl?job=191953&lang=en")))
      .toEqual({ board: TALEO_BOARD, externalId: "191953" });
    expect(taleoAdapter.parsePostingUrl!(new URL("https://hdr.taleo.net/careersection/ex/jobsearch.ftl"))).toBeNull();
    expect(taleoAdapter.parsePostingUrl!(new URL("https://chp.tbe.taleo.net/careersection/ex/jobdetail.ftl?job=1"))).toBeNull();
  });

  it("fetches one posting from its page", async () => {
    stub(() => json(taleoPage([])));
    expect(await taleoAdapter.fetchPosting!(company(), "191953", capturedAt)).toMatchObject({
      title: "Aviation Engineer/Project Manager", locationsRaw: ["Denver, Colorado, United States"],
    });
    stub(() => json(taleoPage([])), () => html(TALEO_UNAVAILABLE_PAGE));
    expect(await taleoAdapter.fetchPosting!(company(), "1", capturedAt)).toBeNull();
    await expect(taleoAdapter.fetchPosting!(company(), "../1", capturedAt)).rejects.toMatchObject({ code: "invalid_posting_id" });
  });

  it("reads open, closed and unknown from the job page", async () => {
    stub(() => json(taleoPage([ROW_DENVER])));
    const [job] = await taleoAdapter.listJobs(company(), capturedAt);
    vi.unstubAllGlobals();

    stub(() => json(taleoPage([])));
    expect(await taleoAdapter.checkPosting!(job!)).toMatchObject({ status: "open", via: "page" });

    stub(() => json(taleoPage([])), () => html(TALEO_UNAVAILABLE_PAGE));
    expect(await taleoAdapter.checkPosting!(job!)).toMatchObject({ status: "closed" });

    stub(() => json(taleoPage([])), () => html("<html>maintenance</html>"));
    expect(await taleoAdapter.checkPosting!(job!)).toMatchObject({ status: "unknown" });

    stub(() => json(taleoPage([])), () => html("blocked", 403));
    expect(await taleoAdapter.checkPosting!(job!)).toMatchObject({ status: "unknown" });

    expect(await taleoAdapter.checkPosting!({ ...job!, externalId: "../1" })).toMatchObject({ status: "unknown" });
    expect(await taleoAdapter.checkPosting!({ ...job!, board: "x" })).toMatchObject({ status: "unknown" });
  });
});
