import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanySchema } from "../src/domain/campaign.js";
import { AppError } from "../src/util/errors.js";
import { logger } from "../src/util/logger.js";
import { icimsAdapter, parseIcimsBoard } from "../src/sources/icims.js";
import { icimsLocation, parseIcimsCards } from "../src/sources/enterprise/icimsPage.js";
import { readJobPosting } from "../src/sources/enterprise/jobPosting.js";
import { findJobPosting, jsonLdNodes } from "../src/sources/enterprise/markup.js";
import {
  ICIMS_CARD_PLANNER, ICIMS_CARD_TESTER, ICIMS_HOST, ICIMS_MISSING_PAGE, icimsCard, icimsDetailPage, icimsSearchPage,
} from "./fixtures/icims.js";

const capturedAt = "2026-11-07T00:00:00.000Z";

function company(overrides: Record<string, unknown> = {}) {
  return CompanySchema.parse({ name: "General Dynamics Mission Systems", ats: "icims", board: ICIMS_HOST, ...overrides });
}

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/html" } });
}

type Call = { url: URL };

function stub(search: (page: number, url: URL) => Response, posting: (id: string) => Response): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const url = new URL(input);
    calls.push({ url });
    if (url.pathname === "/jobs/search") return search(Number(url.searchParams.get("pr")), url);
    return posting(/^\/jobs\/(\d+)\//.exec(url.pathname)?.[1] ?? "");
  }));
  return calls;
}

beforeEach(() => {
  process.env.AUTOAPPLY_MIN_INTERVAL_MS = "0";
  delete process.env.AUTOAPPLY_ICIMS_MAX_POSTINGS;
  delete process.env.AUTOAPPLY_ICIMS_MAX_DETAILS;
  vi.spyOn(logger, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.AUTOAPPLY_ICIMS_MAX_POSTINGS;
  delete process.env.AUTOAPPLY_ICIMS_MAX_DETAILS;
});

describe("icims board", () => {
  it("accepts the portal host and expands a bare tenant to its careers portal", () => {
    expect(parseIcimsBoard("careers-gdms.icims.com")).toBe("careers-gdms.icims.com");
    expect(parseIcimsBoard("USCareers-Acme.iCIMS.com")).toBe("uscareers-acme.icims.com");
    expect(parseIcimsBoard("gdms")).toBe("careers-gdms.icims.com");
  });

  it.each(["www.icims.com", "careers.example.com", "acme/jobs", "icims.com"])("rejects %s", (board) => {
    expect(() => parseIcimsBoard(board)).toThrow(AppError);
    expect(() => parseIcimsBoard(board)).toThrow(/careers-gdms\.icims\.com/);
  });

  it("names the board a pasted portal URL points at", () => {
    expect(() => parseIcimsBoard("https://careers-gdms.icims.com/jobs/search?ss=1"))
      .toThrow(/use the board "careers-gdms\.icims\.com"/);
  });

  it("builds portal urls and guesses the usual portal for a slug", () => {
    expect(icimsAdapter.boardUrl(company())).toBe("https://careers-gdms.icims.com/jobs/search?ss=1");
    expect(icimsAdapter.listUrl(company({ query: "software" }))).toBe(
      "https://careers-gdms.icims.com/jobs/search?ss=1&in_iframe=1&pr=0&searchKeyword=software",
    );
    expect(icimsAdapter.probeUrls("acme")).toEqual(["https://careers-acme.icims.com/jobs/search?ss=1&in_iframe=1&pr=0"]);
    expect(icimsAdapter.probeUrls("not a slug")).toEqual([]);
  });
});

describe("icims page parsing", () => {
  it("reads cards whatever their theme adds around the fields", () => {
    const [planner] = parseIcimsCards(icimsSearchPage([ICIMS_CARD_PLANNER]), ICIMS_HOST);
    expect(planner).toMatchObject({
      id: "79192",
      url: "https://careers-gdms.icims.com/jobs/79192/advanced-manufacturing-planning-specialist/job",
      title: "Advanced Manufacturing Planning Specialist",
      postedAt: "2026-11-06T00:00:00.000Z",
    });
    expect(planner!.fields).toContainEqual({ label: "Job Location", value: "US-MN-Bloomington" });
    expect(planner!.summary).toContain("Department of Defense Secret");
  });

  it("drops cards linking off the portal", () => {
    const foreign = ICIMS_CARD_TESTER.replace(`https://${ICIMS_HOST}`, "https://evil.example.com");
    expect(parseIcimsCards(icimsSearchPage([foreign, ICIMS_CARD_PLANNER]), ICIMS_HOST).map((card) => card.id)).toEqual(["79192"]);
  });

  it("rewrites country-region-city locations for the classifier", () => {
    expect(icimsLocation("US-MN-Bloomington")).toBe("Bloomington, MN, United States");
    // Tamil Nadu's "TN" must not read as Tennessee.
    expect(icimsLocation("IN-TN-Chennai")).toBe("Chennai, India");
    expect(icimsLocation("Remote")).toBe("Remote");
  });

  it("flattens JSON-LD arrays and graphs and skips unavailable address parts", () => {
    const page = `<script type="application/ld+json" nonce="x">{"@graph":[{"@type":"Organization"},{"@type":["JobPosting"],"title":"Engineer","jobLocation":{"address":{"addressLocality":"UNAVAILABLE","addressRegion":"ON","addressCountry":"CA"}},"jobLocationType":"TELECOMMUTE","baseSalary":{"currency":"CAD","value":{"minValue":90000,"maxValue":120000,"unitText":"YEAR"}}}]}</script><script type="application/ld+json">not json</script>`;
    expect(jsonLdNodes(page)).toHaveLength(2);
    const fields = readJobPosting(findJobPosting(page)!);
    expect(fields).toMatchObject({ title: "Engineer", locations: ["ON, Canada"], country: "CA", isRemote: true });
    expect(fields.compensation).toMatchObject({ min: 90_000, max: 120_000, currency: "CAD", period: "year", source: "ats-structured" });
  });

  it("drops a foreign region code from a JSON-LD address", () => {
    const page = `<script type="application/ld+json">{"@type":"JobPosting","title":"Engineer","jobLocation":[{"address":{"addressLocality":"Chennai","addressRegion":"TN","addressCountry":"IN"}},{"address":{"addressLocality":"Austin","addressRegion":"TX","addressCountry":"US"}}]}</script>`;
    const fields = readJobPosting(findJobPosting(page)!);
    expect(fields.locations).toEqual(["Chennai, India", "Austin, TX, United States"]);
    // Two countries: the posting is not pinned to either.
    expect(fields.country).toBeUndefined();
  });
});

describe("icims listing", () => {
  it("merges each card with its posting page", async () => {
    stub(() => html(icimsSearchPage([ICIMS_CARD_PLANNER])), () => html(icimsDetailPage()));

    const [job] = await icimsAdapter.listJobs(company(), capturedAt);

    expect(job).toMatchObject({
      ats: "icims",
      externalId: "79192",
      title: "Advanced Manufacturing Planning Specialist",
      url: "https://careers-gdms.icims.com/jobs/79192/advanced-manufacturing-planning-specialist/job",
      locationsRaw: ["Bloomington, MN, United States"],
      country: "US",
      postedAt: "2026-11-06T05:00:00.000Z",
      employmentType: "full-time",
    });
    expect(job!.applyUrl).toBe(job!.url);
    expect(job!.descriptionText).toContain("Basic Qualifications");
    expect(job!.descriptionText).toContain("Combined Salary Range");
    expect(job!.compensation).toMatchObject({ min: 91_193, max: 98_674 });
  });

  it("falls back to card fields past the detail cap", async () => {
    process.env.AUTOAPPLY_ICIMS_MAX_DETAILS = "0";
    const calls = stub(() => html(icimsSearchPage([ICIMS_CARD_PLANNER])), () => html(icimsDetailPage()));

    const [job] = await icimsAdapter.listJobs(company(), capturedAt);

    expect(calls).toHaveLength(1);
    expect(job).toMatchObject({ locationsRaw: ["Bloomington, MN, United States"], country: "US", postedAt: "2026-11-06T00:00:00.000Z" });
    expect(job!.descriptionText).toContain("Department of Defense Secret");
    expect(job!.compensation).toMatchObject({ min: 91_193, max: 98_674 });
  });

  it("caps detail requests", async () => {
    process.env.AUTOAPPLY_ICIMS_MAX_DETAILS = "1";
    const calls = stub(() => html(icimsSearchPage([ICIMS_CARD_PLANNER, ICIMS_CARD_TESTER])), () => html(icimsDetailPage()));

    await icimsAdapter.listJobs(company(), capturedAt);

    expect(calls.filter((call) => call.url.pathname !== "/jobs/search")).toHaveLength(1);
  });

  it("pages until the pager's last page", async () => {
    process.env.AUTOAPPLY_ICIMS_MAX_DETAILS = "0";
    const calls = stub(
      (page) => html(icimsSearchPage(page === 0 ? [icimsCard("1"), icimsCard("2")] : [icimsCard("3")], page, 2)),
      () => html(icimsDetailPage()),
    );

    const jobs = await icimsAdapter.listJobs(company(), capturedAt);

    expect(jobs.map((job) => job.externalId)).toEqual(["1", "2", "3"]);
    expect(calls.map((call) => call.url.searchParams.get("pr"))).toEqual(["0", "1"]);
  });

  it("stops when a portal without a pager repeats or empties a page", async () => {
    process.env.AUTOAPPLY_ICIMS_MAX_DETAILS = "0";
    const calls = stub((page) => html(icimsSearchPage(page < 2 ? [icimsCard(String(page))] : [icimsCard("1")], 0, null)), () => html(""));

    const jobs = await icimsAdapter.listJobs(company(), capturedAt);

    expect(jobs.map((job) => job.externalId)).toEqual(["0", "1"]);
    expect(calls).toHaveLength(3);
  });

  it("stops at the posting cap", async () => {
    process.env.AUTOAPPLY_ICIMS_MAX_POSTINGS = "2";
    process.env.AUTOAPPLY_ICIMS_MAX_DETAILS = "0";
    const calls = stub(() => html(icimsSearchPage([icimsCard("1"), icimsCard("2"), icimsCard("3")], 0, 9)), () => html(""));

    expect(await icimsAdapter.listJobs(company(), capturedAt)).toHaveLength(2);
    expect(calls).toHaveLength(1);
  });

  it("keeps a posting whose page fails and drops one iCIMS reports gone", async () => {
    stub(
      () => html(icimsSearchPage([icimsCard("1"), icimsCard("2"), icimsCard("3")])),
      (id) => (id === "1" ? html("blocked", 403) : id === "2" ? html(ICIMS_MISSING_PAGE, 410) : html(icimsDetailPage({ title: "Engineer 3" }))),
    );

    const jobs = await icimsAdapter.listJobs(company(), capturedAt);

    expect(jobs.map((job) => [job.externalId, job.title])).toEqual([["1", "Engineer 1"], ["3", "Engineer 3"]]);
  });

  it("sends the campaign query as the portal keyword search", async () => {
    const calls = stub(() => html(icimsSearchPage([])), () => html(""));

    await icimsAdapter.listJobs(company({ query: "software engineer" }), capturedAt);

    expect(calls[0]!.url.searchParams.get("searchKeyword")).toBe("software engineer");
  });

  it("verifies a board from the first results page", async () => {
    const calls = stub(() => html(icimsSearchPage([ICIMS_CARD_PLANNER, ICIMS_CARD_TESTER])), () => html(""));

    expect(await icimsAdapter.verifyBoard!(company())).toMatchObject({ ok: true, postings: 2 });
    expect(calls).toHaveLength(1);
  });
});

describe("icims postings", () => {
  it.each([
    ["https://careers-gdms.icims.com/jobs/79192/advanced-manufacturing-planning-specialist/job?in_iframe=1", "79192"],
    ["https://careers-gdms.icims.com/jobs/79192/job", "79192"],
  ])("recognizes %s", (raw, id) => {
    expect(icimsAdapter.parsePostingUrl!(new URL(raw))).toEqual({ board: ICIMS_HOST, externalId: id });
  });

  it.each(["https://careers-gdms.icims.com/jobs/search?ss=1", "https://example.com/jobs/1/x/job"])("ignores %s", (raw) => {
    expect(icimsAdapter.parsePostingUrl!(new URL(raw))).toBeNull();
  });

  it("fetches one posting from its page", async () => {
    stub(() => html(""), () => html(icimsDetailPage()));
    const job = await icimsAdapter.fetchPosting!(company(), "79192", capturedAt);
    expect(job).toMatchObject({ externalId: "79192", url: "https://careers-gdms.icims.com/jobs/79192/job", country: "US" });
  });

  it("returns null for a posting iCIMS no longer has", async () => {
    stub(() => html(""), () => html(ICIMS_MISSING_PAGE, 410));
    expect(await icimsAdapter.fetchPosting!(company(), "1", capturedAt)).toBeNull();
  });

  async function storedJob() {
    stub(() => html(icimsSearchPage([ICIMS_CARD_PLANNER])), () => html(icimsDetailPage()));
    const [job] = await icimsAdapter.listJobs(company(), capturedAt);
    vi.unstubAllGlobals();
    return job!;
  }

  it("reads open and closed from the posting page", async () => {
    const job = await storedJob();
    stub(() => html(""), () => html(icimsDetailPage()));
    expect(await icimsAdapter.checkPosting!(job)).toMatchObject({ status: "open", via: "page" });

    stub(() => html(""), () => html(ICIMS_MISSING_PAGE, 410));
    expect(await icimsAdapter.checkPosting!(job)).toMatchObject({ status: "closed" });

    stub(() => html(""), () => html(ICIMS_MISSING_PAGE));
    expect(await icimsAdapter.checkPosting!(job)).toMatchObject({ status: "closed" });

    stub(() => html(""), () => html(icimsDetailPage({ validThrough: "2020-01-01T00:00:00.000Z" })));
    expect(await icimsAdapter.checkPosting!(job)).toMatchObject({ status: "closed" });
  });

  it("reports unknown for blocked or unreadable pages", async () => {
    const job = await storedJob();
    stub(() => html(""), () => html("<html>challenge</html>", 403));
    expect(await icimsAdapter.checkPosting!(job)).toMatchObject({ status: "unknown" });

    stub(() => html(""), () => html("<html>no structured data</html>"));
    expect(await icimsAdapter.checkPosting!(job)).toMatchObject({ status: "unknown" });

    expect(await icimsAdapter.checkPosting!({ ...job, board: "https://bad" })).toMatchObject({ status: "unknown" });
    expect(await icimsAdapter.checkPosting!({ ...job, externalId: "../1" })).toMatchObject({ status: "unknown" });
    await expect(icimsAdapter.fetchPosting!(company(), "abc", capturedAt)).rejects.toThrow(/not an iCIMS job id/);
  });
});
