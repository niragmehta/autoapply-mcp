import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanySchema } from "../src/domain/campaign.js";
import { AppError } from "../src/util/errors.js";
import { logger } from "../src/util/logger.js";
import { avatureAdapter, parseAvatureBoard } from "../src/sources/avature.js";
import { avatureDetailUrl, avatureJobId, avatureTotal, parseAvatureCards, parseAvatureDetail } from "../src/sources/enterprise/avaturePage.js";
import { AVATURE_BOARD, avatureCard, avatureDetailPage, avatureSearchPage } from "./fixtures/avature.js";

const capturedAt = "2026-11-07T00:00:00.000Z";

function company(overrides: Record<string, unknown> = {}) {
  return CompanySchema.parse({ name: "Bloomberg", ats: "avature", board: AVATURE_BOARD, ...overrides });
}

function html(body: string, status = 200): Response {
  return new Response(body, { status, headers: { "content-type": "text/html" } });
}

function stub(search: (url: URL) => Response, detail: (id: string) => Response = () => html(avatureDetailPage())): URL[] {
  const calls: URL[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const url = new URL(input);
    calls.push(url);
    if (url.pathname.includes("/SearchJobs")) return search(url);
    return detail(avatureJobId(url.pathname) ?? "");
  }));
  return calls;
}

function cards(from: number, count: number): string[] {
  return Array.from({ length: count }, (_unused, index) => avatureCard(String(from + index), `Engineer ${from + index}`));
}

beforeEach(() => {
  process.env.AUTOAPPLY_MIN_INTERVAL_MS = "0";
  delete process.env.AUTOAPPLY_AVATURE_MAX_POSTINGS;
  delete process.env.AUTOAPPLY_AVATURE_MAX_DETAILS;
  vi.spyOn(logger, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.AUTOAPPLY_AVATURE_MAX_POSTINGS;
  delete process.env.AUTOAPPLY_AVATURE_MAX_DETAILS;
});

describe("avature board", () => {
  it("reads the host and site path, defaulting a bare tenant to /careers", () => {
    expect(parseAvatureBoard(AVATURE_BOARD)).toEqual({ host: "bloomberg.avature.net", site: "careers" });
    expect(parseAvatureBoard("bloomberg")).toEqual({ host: "bloomberg.avature.net", site: "careers" });
    expect(parseAvatureBoard("jobs.siemens.com/en_US/externaljobs")).toEqual({ host: "jobs.siemens.com", site: "en_US/externaljobs" });
  });

  it.each(["bloomberg.avature.net/a b", "bloomberg.avature.net/a/b/c/d"])("rejects %s", (board) => {
    expect(() => parseAvatureBoard(board)).toThrow(AppError);
    expect(() => parseAvatureBoard(board)).toThrow(/bloomberg\.avature\.net\/careers/);
  });

  it("names the board a pasted search URL points at", () => {
    expect(() => parseAvatureBoard("https://bloomberg.avature.net/careers/SearchJobs/?search=java")).toThrow(/use the board "bloomberg\.avature\.net\/careers"/);
  });

  it("builds search urls and guesses the usual portal for a slug", () => {
    expect(avatureAdapter.boardUrl(company())).toBe("https://bloomberg.avature.net/careers/SearchJobs");
    expect(avatureAdapter.listUrl(company({ query: "java" }))).toBe("https://bloomberg.avature.net/careers/SearchJobs/?search=java&jobOffset=0");
    expect(avatureAdapter.probeUrls("acme")).toEqual(["https://acme.avature.net/careers/SearchJobs"]);
    expect(avatureAdapter.probeUrls("a b")).toEqual([]);
  });
});

describe("avature parsing", () => {
  it("reads cards by their JobDetail title link, ignoring Apply and Save buttons", () => {
    const [card] = parseAvatureCards(avatureSearchPage([avatureCard("46045", "Aim Buyside Client Support Specialist", "London, United Kingdom", "02-May-2026")]), "https://bloomberg.avature.net");
    expect(card).toEqual({
      id: "46045",
      url: "https://bloomberg.avature.net/careers/JobDetail/Aim-Buyside-Client-Support-Specialist/46045",
      title: "Aim Buyside Client Support Specialist",
      location: "London, United Kingdom",
      postedAt: "2026-05-02T00:00:00.000Z",
    });
  });

  it("reads query-style job ids, the results total and the detail fields", () => {
    expect(avatureJobId("/careers/JobDetail?jobId=123")).toBe("123");
    expect(avatureTotal(avatureSearchPage([], 326))).toBe(326);
    expect(parseAvatureDetail(avatureDetailPage())).toMatchObject({ title: "Senior Software Engineer - Hadoop Infrastructure", locations: ["New York"] });
    expect(parseAvatureDetail("<html><meta name=\"avature.portal.page\" content=\"Error\"/></html>")).toBeNull();
  });

  it("keeps a query-style job id in the posting url and drops tracking parameters", () => {
    expect(avatureDetailUrl(new URL("https://x.avature.net/careers/JobDetail?source=feed&jobId=77"))).toBe("https://x.avature.net/careers/JobDetail?jobId=77");
    expect(avatureDetailUrl(new URL("https://x.avature.net/careers/JobDetail/Data-Engineer/77?utm=1"))).toBe("https://x.avature.net/careers/JobDetail/Data-Engineer/77");
    expect(avatureDetailUrl(new URL("https://x.avature.net/careers/SearchJobs/"))).toBeNull();

    const queryCard = avatureCard("77", "Data Engineer").replace(/href="[^"]+"/, 'href="/careers/JobDetail?jobId=77&amp;source=feed"');
    const [card] = parseAvatureCards(avatureSearchPage([queryCard]), "https://bloomberg.avature.net");
    expect(card).toMatchObject({ id: "77", url: "https://bloomberg.avature.net/careers/JobDetail?jobId=77" });
  });
});

describe("avature listing", () => {
  it("merges search cards with job pages", async () => {
    stub(() => html(avatureSearchPage([avatureCard("20462", "Senior Software Engineer - Data Governance")])));

    const [job] = await avatureAdapter.listJobs(company(), capturedAt);

    expect(job).toMatchObject({
      ats: "avature",
      externalId: "20462",
      title: "Senior Software Engineer - Data Governance",
      url: "https://bloomberg.avature.net/careers/JobDetail/Senior-Software-Engineer-Data-Governance/20462",
      locationsRaw: ["New York, New York, United States of America"],
      country: "US",
    });
    expect(job!.applyUrl).toBe(job!.url);
    expect(job!.descriptionText).toContain("Bloomberg runs on data!");
    expect(job!.compensation).toMatchObject({ min: 160_000, max: 240_000 });
  });

  it("pages by offset until the announced total and sends the query", async () => {
    process.env.AUTOAPPLY_AVATURE_MAX_DETAILS = "0";
    const calls = stub((url) => html(avatureSearchPage(url.searchParams.get("jobOffset") === "0" ? cards(0, 12) : cards(12, 3), 15)));

    const jobs = await avatureAdapter.listJobs(company({ query: "software" }), capturedAt);

    expect(jobs).toHaveLength(15);
    expect(calls.map((url) => url.searchParams.get("jobOffset"))).toEqual(["0", "12"]);
    expect(calls[0]!.searchParams.get("search")).toBe("software");
  });

  it("switches to a bare offset parameter when jobOffset is ignored", async () => {
    process.env.AUTOAPPLY_AVATURE_MAX_DETAILS = "0";
    const calls = stub((url) => html(avatureSearchPage(url.searchParams.get("offset") === "6" ? cards(6, 2) : cards(0, 6), 8)));

    const jobs = await avatureAdapter.listJobs(company(), capturedAt);

    expect(jobs).toHaveLength(8);
    expect(calls.map((url) => url.search)).toEqual(["?jobOffset=0", "?jobOffset=6", "?offset=6"]);
  });

  it("caps postings and detail pages, keeps failing pages and drops removed postings", async () => {
    process.env.AUTOAPPLY_AVATURE_MAX_POSTINGS = "3";
    process.env.AUTOAPPLY_AVATURE_MAX_DETAILS = "2";
    const calls = stub(
      () => html(avatureSearchPage(cards(0, 6), 60)),
      (id) => (id === "0" ? html("Error", 404) : html("blocked", 403)),
    );

    const jobs = await avatureAdapter.listJobs(company(), capturedAt);

    expect(jobs.map((job) => job.externalId)).toEqual(["1", "2"]);
    expect(calls.filter((url) => url.pathname.includes("/JobDetail/"))).toHaveLength(2);
  });

  it("verifies from the first results page", async () => {
    stub(() => html(avatureSearchPage(cards(0, 2), 326)));
    expect(await avatureAdapter.verifyBoard!(company())).toMatchObject({ ok: true, postings: 326 });
  });
});

describe("avature postings", () => {
  it.each([
    ["https://bloomberg.avature.net/careers/JobDetail/Senior-Software-Engineer/45958", { board: AVATURE_BOARD, externalId: "45958" }],
    ["https://jobs.siemens.com/en_US/externaljobs/JobDetail/Engineer/123456", { board: "jobs.siemens.com/en_US/externaljobs", externalId: "123456" }],
    ["https://careers.example.com/careers/JobDetail?jobId=77", { board: "careers.example.com/careers", externalId: "77" }],
  ])("recognizes %s", (raw, ref) => {
    expect(avatureAdapter.parsePostingUrl!(new URL(raw))).toEqual(ref);
  });

  it("ignores search pages", () => {
    expect(avatureAdapter.parsePostingUrl!(new URL("https://bloomberg.avature.net/careers/SearchJobs"))).toBeNull();
  });

  it("fetches one posting with a placeholder slug", async () => {
    const calls = stub(() => html(""));
    const job = await avatureAdapter.fetchPosting!(company(), "45958", capturedAt);
    expect(calls[0]!.pathname).toBe("/careers/JobDetail/job/45958");
    expect(job).toMatchObject({ title: "Senior Software Engineer - Hadoop Infrastructure", locationsRaw: ["New York"] });

    stub(() => html(""), () => html("Error", 404));
    expect(await avatureAdapter.fetchPosting!(company(), "1", capturedAt)).toBeNull();
    await expect(avatureAdapter.fetchPosting!(company(), "x", capturedAt)).rejects.toThrow(/not an Avature job id/);
  });

  it("reads open, closed and unknown from the job page", async () => {
    stub(() => html(avatureSearchPage([avatureCard("45958", "Senior Software Engineer")])));
    const [job] = await avatureAdapter.listJobs(company(), capturedAt);
    vi.unstubAllGlobals();

    stub(() => html(""));
    expect(await avatureAdapter.checkPosting!(job!)).toMatchObject({ status: "open", via: "page" });

    // A removed posting redirects to /careers/Error, which answers 404.
    stub(() => html(""), () => html("Error", 404));
    expect(await avatureAdapter.checkPosting!(job!)).toMatchObject({ status: "closed" });

    stub(() => html(""), () => html("<html>challenge</html>"));
    expect(await avatureAdapter.checkPosting!(job!)).toMatchObject({ status: "unknown" });

    expect(await avatureAdapter.checkPosting!({ ...job!, url: "https://evil.example.com/careers/JobDetail/x/1" })).toMatchObject({ status: "unknown" });
    expect(await avatureAdapter.checkPosting!({ ...job!, board: "a/b c" })).toMatchObject({ status: "unknown" });

    // Only JobDetail pages are checked, so a 404 elsewhere is never read as closed.
    const blocked = stub(() => html("gone", 404), () => html("gone", 404));
    expect(await avatureAdapter.checkPosting!({ ...job!, url: "https://bloomberg.avature.net/careers/SearchJobs/" })).toMatchObject({ status: "unknown" });
    expect(blocked).toHaveLength(0);

    const calls = stub(() => html(""));
    expect(await avatureAdapter.checkPosting!({ ...job!, url: "https://bloomberg.avature.net/careers/JobDetail?src=feed&jobId=45958" })).toMatchObject({ status: "open" });
    expect(calls.map((url) => url.href)).toEqual(["https://bloomberg.avature.net/careers/JobDetail?jobId=45958"]);
  });
});
