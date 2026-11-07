import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanySchema } from "../src/domain/campaign.js";
import { AppError } from "../src/util/errors.js";
import { logger } from "../src/util/logger.js";
import { parseUkgBoard, ukgAdapter } from "../src/sources/ukg.js";
import { readUkgPage } from "../src/sources/enterprise/ukgPage.js";
import { balancedObject } from "../src/sources/enterprise/markup.js";
import { payPeriod, structuredPay } from "../src/sources/enterprise/compensation.js";
import { countryCode, countryName, isCountryName, placeLabel, soleCountry } from "../src/sources/enterprise/country.js";
import {
  UKG_BOARD, UKG_ID, UKG_INTERNAL_PAGE, UKG_NOT_FOUND_PAGE, UKG_UNAVAILABLE_PAGE, ukgDetailPage, ukgOpportunity, ukgSearch,
} from "./fixtures/ukg.js";

const capturedAt = "2026-11-07T00:00:00.000Z";
const SECOND = "cd7c5f19-bb85-496f-be2e-260a71c85416";

function company(overrides: Record<string, unknown> = {}) {
  return CompanySchema.parse({ name: "Example Manufacturer", ats: "ultipro", board: UKG_BOARD, ...overrides });
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/html" } });
}

type Body = { opportunitySearch: { Top: number; Skip: number; QueryString: string } };

function stub(search: (body: Body) => Response, page: (id: string) => Response = (id) => html(ukgDetailPage({ Id: id }))): URL[] {
  const calls: URL[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    calls.push(url);
    if (url.pathname.endsWith("/LoadSearchResults")) return search(JSON.parse(String(init?.body)) as Body);
    return page(url.searchParams.get("opportunityId") ?? "");
  }));
  return calls;
}

beforeEach(() => {
  process.env.AUTOAPPLY_MIN_INTERVAL_MS = "0";
  delete process.env.AUTOAPPLY_ULTIPRO_MAX_POSTINGS;
  delete process.env.AUTOAPPLY_ULTIPRO_MAX_DETAILS;
  vi.spyOn(logger, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.AUTOAPPLY_ULTIPRO_MAX_POSTINGS;
  delete process.env.AUTOAPPLY_ULTIPRO_MAX_DETAILS;
});

describe("enterprise pay and place helpers", () => {
  it("accepts only complete, ordered, currency-tagged pay", () => {
    expect(structuredPay({ min: "90000", max: 120000, currency: "usd", period: "year", raw: "x" }))
      .toEqual({ min: 90_000, max: 120_000, currency: "USD", period: "year", source: "ats-structured", raw: "x" });
    expect(structuredPay({ min: 22, max: null, currency: "USD", period: "hour", raw: "x" })).toMatchObject({ min: 22, max: null });
    expect(structuredPay({ min: null, max: undefined, currency: "USD", period: "year", raw: "x" })).toBeNull();
    expect(structuredPay({ min: 0, max: 0, currency: "USD", period: "year", raw: "x" })).toBeNull();
    expect(structuredPay({ min: 200, max: 100, currency: "USD", period: "year", raw: "x" })).toBeNull();
    expect(structuredPay({ min: 1, max: 2, currency: "Dollars", period: "year", raw: "x" })).toBeNull();
    expect(structuredPay({ min: -5, max: "abc", currency: "USD", period: "year", raw: "x" })).toBeNull();
  });

  it("maps pay-period labels", () => {
    expect(["Annually", "YEAR", "Salaried", "HR", "Hourly", "Monthly", "per week", null].map(payPeriod))
      .toEqual(["year", "year", "year", "hour", "hour", "month", "unknown", "unknown"]);
  });

  it("names countries and keeps only one agreed country", () => {
    expect(["USA", "United States of America", "u.s.", "CAN", "Canada", "IN", 7].map(countryCode)).toEqual(["US", "US", "US", "CA", "CA", undefined, undefined]);
    expect(countryName("IN")).toBe("India");
    expect(countryName("GBR")).toBe("GBR");
    expect(isCountryName("Germany")).toBe(true);
    expect(isCountryName("Engineer III")).toBe(false);
    expect(soleCountry(["US", "USA", ""])).toBe("US");
    expect(soleCountry(["US", "IN"])).toBeUndefined();
    expect(soleCountry(["IN"])).toBeUndefined();
    expect(soleCountry([])).toBeUndefined();
    expect(placeLabel({ city: "Toronto", region: "ON", country: "CA" })).toBe("Toronto, ON, Canada");
    expect(placeLabel({ city: "Pune", region: "MH", country: "India" })).toBe("Pune, India");
    expect(placeLabel({ city: "Austin", region: "TX" })).toBe("Austin, TX");
  });
});

describe("ukg board", () => {
  it("splits host, tenant and board id across UKG's hosts", () => {
    expect(parseUkgBoard(UKG_BOARD)).toEqual({ host: "recruiting.ultipro.com", tenant: "MIC1014MICS", boardId: "aba7ab7f-e037-4961-b6cf-c1491e2105e0" });
    expect(parseUkgBoard("recruiting2.ultipro.com/VER1018VALLC/EA4D56D0-A413-48C6-87F7-32D00FD2EEF4").boardId)
      .toBe("ea4d56d0-a413-48c6-87f7-32d00fd2eef4");
    expect(parseUkgBoard("parkohio.rec.pro.ukg.net/PAR1048POII/bf75d22e-0799-448d-b549-f0200d2fb3d4").host).toBe("parkohio.rec.pro.ukg.net");
  });

  it.each(["recruiting.ultipro.com/MIC1014MICS", "example.com/MIC1014MICS/aba7ab7f-e037-4961-b6cf-c1491e2105e0", "recruiting.ultipro.com/MIC1014MICS/not-a-guid"])(
    "rejects %s", (board) => {
      expect(() => parseUkgBoard(board)).toThrow(AppError);
      expect(() => parseUkgBoard(board)).toThrow(/MIC1014MICS/);
    },
  );

  it("names the board a pasted job board URL points at", () => {
    expect(() => parseUkgBoard("https://recruiting.ultipro.com/MIC1014MICS/JobBoard/aba7ab7f-e037-4961-b6cf-c1491e2105e0/?q=&o=postedDateDesc"))
      .toThrow(new RegExp(`use the board "${UKG_BOARD.replace(/[./]/g, "\\$&")}"`));
  });

  it("builds the board page and search endpoint", () => {
    expect(ukgAdapter.boardUrl(company())).toBe("https://recruiting.ultipro.com/MIC1014MICS/JobBoard/aba7ab7f-e037-4961-b6cf-c1491e2105e0/");
    expect(ukgAdapter.listUrl(company())).toMatch(/\/JobBoardView\/LoadSearchResults$/);
    expect(ukgAdapter.probeUrls("micro")).toEqual([]);
  });
});

describe("ukg page parsing", () => {
  it("cuts the embedded record out despite braces and quotes in the description", () => {
    const page = readUkgPage(ukgDetailPage(), UKG_ID);
    expect(page.status).toBe("record");
    expect(page.status === "record" && page.record.Description).toContain('{first piece} before "release"');
    expect(balancedObject('x({"a":"}"', 0)).toBeNull();
  });

  it("tells a record for another id from a notice", () => {
    expect(readUkgPage(ukgDetailPage(), SECOND).status).toBe("unreadable");
    expect(readUkgPage(UKG_UNAVAILABLE_PAGE, UKG_ID)).toMatchObject({ status: "unavailable" });
    expect(readUkgPage("<html></html>", UKG_ID).status).toBe("unreadable");
  });
});

describe("ukg listing", () => {
  it("merges search results with each opportunity page", async () => {
    stub(() => json(ukgSearch([ukgOpportunity()])));

    const [job] = await ukgAdapter.listJobs(company(), capturedAt);

    expect(job).toMatchObject({
      ats: "ultipro",
      externalId: UKG_ID,
      title: "2nd Shift QA Inspector",
      url: `https://recruiting.ultipro.com/MIC1014MICS/JobBoard/aba7ab7f-e037-4961-b6cf-c1491e2105e0/OpportunityDetail?opportunityId=${UKG_ID}`,
      locationsRaw: ["Manchester, NH, United States"],
      country: "US",
      postedAt: "2025-10-22T18:35:00.879Z",
      employmentType: "full-time",
      compensation: { min: 22, max: 28, currency: "USD", period: "hour", source: "ats-structured" },
    });
    expect(job!.applyUrl).toBe(job!.url);
    expect(job!.descriptionText).toContain("Evaluate conformance");
  });

  it("prefers explicit annual pay over the pay range", async () => {
    stub(() => json(ukgSearch([ukgOpportunity()])), () => html(ukgDetailPage({ CompensationAnnualMinimum: 90000, CompensationAnnualMaximum: 120000, CompensationCurrencyCode: "USD" })));
    const [job] = await ukgAdapter.listJobs(company(), capturedAt);
    expect(job!.compensation).toMatchObject({ min: 90_000, max: 120_000, period: "year" });
  });

  it("drops closed or unavailable opportunities and keeps one whose page fails", async () => {
    const ids = [UKG_ID, SECOND, "55a29141-d79e-4a97-9ff7-5215507ad209"];
    stub(
      () => json(ukgSearch(ids.map((Id) => ukgOpportunity({ Id })))),
      (id) => (id === UKG_ID ? html(ukgDetailPage({ Id: id, OpportunityIsClosed: true })) : id === SECOND ? html(UKG_UNAVAILABLE_PAGE) : html("blocked", 403)),
    );

    const jobs = await ukgAdapter.listJobs(company(), capturedAt);

    expect(jobs.map((job) => job.externalId)).toEqual(["55a29141-d79e-4a97-9ff7-5215507ad209"]);
    expect(jobs[0]!.descriptionText).toContain("Quality Component Process Inspector");
  });

  it("skips malformed results", async () => {
    stub(() => json(ukgSearch([{ Id: "nope", Title: "Bad" }, ukgOpportunity()])));
    expect((await ukgAdapter.listJobs(company(), capturedAt)).map((job) => job.externalId)).toEqual([UKG_ID]);
  });

  it("pages by Skip until the total and sends the query", async () => {
    process.env.AUTOAPPLY_ULTIPRO_MAX_DETAILS = "0";
    const ids = (from: number, count: number) => Array.from({ length: count }, (_unused, index) =>
      ukgOpportunity({ Id: `00000000-0000-0000-0000-${String(from + index).padStart(12, "0")}` }));
    const bodies: Body[] = [];
    stub((body) => {
      bodies.push(body);
      return json(ukgSearch(body.opportunitySearch.Skip === 0 ? ids(0, 50) : ids(50, 3), 53));
    });

    const jobs = await ukgAdapter.listJobs(company({ query: "inspector" }), capturedAt);

    expect(jobs).toHaveLength(53);
    expect(bodies.map((body) => body.opportunitySearch.Skip)).toEqual([0, 50]);
    expect(bodies[0]!.opportunitySearch).toMatchObject({ Top: 50, QueryString: "inspector" });
  });

  it("caps postings and opportunity pages", async () => {
    process.env.AUTOAPPLY_ULTIPRO_MAX_POSTINGS = "2";
    process.env.AUTOAPPLY_ULTIPRO_MAX_DETAILS = "1";
    const calls = stub(() => json(ukgSearch([ukgOpportunity(), ukgOpportunity({ Id: SECOND }), ukgOpportunity({ Id: "55a29141-d79e-4a97-9ff7-5215507ad209" })], 300)));

    expect(await ukgAdapter.listJobs(company(), capturedAt)).toHaveLength(2);
    expect(calls.filter((url) => url.pathname.endsWith("/OpportunityDetail"))).toHaveLength(1);
  });

  it("verifies with a five-row search", async () => {
    stub(() => json(ukgSearch([ukgOpportunity()], 37)));
    expect(await ukgAdapter.verifyBoard!(company())).toMatchObject({ ok: true, postings: 37 });
  });
});

describe("ukg postings", () => {
  it("recognizes an opportunity URL", () => {
    expect(ukgAdapter.parsePostingUrl!(new URL(`https://recruiting.ultipro.com/MIC1014MICS/JobBoard/aba7ab7f-e037-4961-b6cf-c1491e2105e0/OpportunityDetail?opportunityId=${UKG_ID.toUpperCase()}`)))
      .toEqual({ board: UKG_BOARD, externalId: UKG_ID });
    expect(ukgAdapter.parsePostingUrl!(new URL("https://recruiting.ultipro.com/MIC1014MICS/JobBoard/aba7ab7f-e037-4961-b6cf-c1491e2105e0/"))).toBeNull();
    expect(ukgAdapter.parsePostingUrl!(new URL(`https://example.com/X/JobBoard/aba7ab7f-e037-4961-b6cf-c1491e2105e0/OpportunityDetail?opportunityId=${UKG_ID}`))).toBeNull();
  });

  it("fetches one open posting and returns null for a closed one", async () => {
    stub(() => json(ukgSearch([])));
    expect(await ukgAdapter.fetchPosting!(company(), UKG_ID, capturedAt)).toMatchObject({ title: "2nd Shift QA Inspector" });
    stub(() => json(ukgSearch([])), () => html(ukgDetailPage({ OpportunityIsClosed: true })));
    expect(await ukgAdapter.fetchPosting!(company(), UKG_ID, capturedAt)).toBeNull();
    await expect(ukgAdapter.fetchPosting!(company(), "x", capturedAt)).rejects.toThrow(/not a UKG opportunity id/);
  });

  it("reads open, closed and unknown from the opportunity page", async () => {
    stub(() => json(ukgSearch([ukgOpportunity()])));
    const [job] = await ukgAdapter.listJobs(company(), capturedAt);
    vi.unstubAllGlobals();

    stub(() => json(ukgSearch([])));
    expect(await ukgAdapter.checkPosting!(job!)).toMatchObject({ status: "open", via: "page" });

    for (const [page, reason] of [
      [ukgDetailPage({ OpportunityIsClosed: true }), /closed/],
      [UKG_UNAVAILABLE_PAGE, /not available/],
      [UKG_NOT_FOUND_PAGE, /cannot find/],
      [UKG_INTERNAL_PAGE, /internal candidates/],
    ] as const) {
      stub(() => json(ukgSearch([])), () => html(page));
      expect(await ukgAdapter.checkPosting!(job!)).toMatchObject({ status: "closed", detail: expect.stringMatching(reason) });
    }

    stub(() => json(ukgSearch([])), () => html("<html>sign-in wall</html>"));
    expect(await ukgAdapter.checkPosting!(job!)).toMatchObject({ status: "unknown" });

    stub(() => json(ukgSearch([])), () => html("blocked", 403));
    expect(await ukgAdapter.checkPosting!(job!)).toMatchObject({ status: "unknown" });

    expect(await ukgAdapter.checkPosting!({ ...job!, externalId: "x" })).toMatchObject({ status: "unknown" });
    expect(await ukgAdapter.checkPosting!({ ...job!, board: "x" })).toMatchObject({ status: "unknown" });
  });
});
