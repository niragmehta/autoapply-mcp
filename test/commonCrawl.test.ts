import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CompanySchema } from "../src/domain/campaign.js";
import { openDatabase, type Db } from "../src/db/database.js";
import { allHarvestedBoards, insertHarvestedBoards, listHarvestRuns } from "../src/db/repositories/harvest.js";
import { boardFromCrawlUrl, cdxPageCount, harvestKey, listCrawlIndexes, parseCdxLines, type FetchLike } from "../src/sourcing/ccIndex.js";
import { harvestBoards, type HarvestProgress } from "../src/sourcing/commonCrawl.js";

/** Common Crawl is stubbed throughout; slugs and tenants are fictional. */

const lines = (...urls: string[]) => urls.map((url) => JSON.stringify({ url })).join("\n");

const COLLINFO = JSON.stringify([
  { id: "CC-MAIN-2026-39", name: "September 2026 Index", from: "2026-09-04", to: "2026-09-17" },
  { id: "CC-MAIN-2026-43", name: "October 2026 Index", from: "2026-10-05", to: "2026-10-18" },
  { id: "not-an-index", name: "junk" },
]);

type Route = { status: number; body: string } | Array<{ status: number; body: string }>;

/** Routes requests by a substring of the URL; an array is served in order, repeating the last entry. */
function stubFetch(routes: Record<string, Route>): { fetchImpl: FetchLike; requests: string[] } {
  const requests: string[] = [];
  const served = new Map<string, number>();
  const fetchImpl: FetchLike = async (url) => {
    requests.push(url);
    const key = Object.keys(routes).find((pattern) => url.includes(pattern));
    if (!key) return new Response("no captures", { status: 404 });
    const route = routes[key]!;
    const list = Array.isArray(route) ? route : [route];
    const count = served.get(key) ?? 0;
    served.set(key, count + 1);
    const response = list[Math.min(count, list.length - 1)]!;
    return new Response(response.body, { status: response.status });
  };
  return { fetchImpl, requests };
}

const fast = { sleep: async () => undefined, baseDelayMs: 1, pageDelayMs: 0 };

let db: Db;
beforeEach(() => {
  db = openDatabase(":memory:");
});
afterEach(() => {
  db.close();
});

describe("boardFromCrawlUrl", () => {
  it("recognizes each ATS's board URLs", () => {
    expect(boardFromCrawlUrl("https://job-boards.greenhouse.io/AcmeRobotics/jobs/4001")).toEqual({ ats: "greenhouse", board: "acmerobotics", region: "global" });
    expect(boardFromCrawlUrl("http://boards.greenhouse.io/embed/job_app?for=globex&token=1")).toEqual({ ats: "greenhouse", board: "globex", region: "global" });
    expect(boardFromCrawlUrl("https://jobs.ashbyhq.com/Initech/0f0291a3?utm_source=x")).toEqual({ ats: "ashby", board: "Initech", region: "global" });
    expect(boardFromCrawlUrl("https://jobs.eu.lever.co/hooli/2bb177ff/apply")).toEqual({ ats: "lever", board: "hooli", region: "eu" });
    expect(boardFromCrawlUrl("https://vandelay.wd5.myworkdayjobs.com/en-US/External_Careers/job/x")).toEqual({
      ats: "workday",
      board: "vandelay/wd5/External_Careers",
      region: "global",
    });
  });

  it("skips reserved paths, API endpoints and other hosts", () => {
    expect(boardFromCrawlUrl("https://boards.greenhouse.io/embed/job_board/js")).toBeNull();
    expect(boardFromCrawlUrl("https://job-boards.greenhouse.io/robots.txt")).toBeNull();
    expect(boardFromCrawlUrl("https://jobs.ashbyhq.com/api/non-user-graphql")).toBeNull();
    expect(boardFromCrawlUrl("https://vandelay.wd5.myworkdayjobs.com/wday/cxs/vandelay/External/jobs")).toBeNull();
    expect(boardFromCrawlUrl("https://careers.example.test/acme")).toBeNull();
    expect(boardFromCrawlUrl("not a url")).toBeNull();
  });

  it("keys Workday boards by tenant", () => {
    expect(harvestKey("workday", "vandelay/wd5/External")).toBe(harvestKey("workday", "Vandelay/wd1/University"));
    expect(harvestKey("greenhouse", "Globex")).toBe("greenhouse:globex");
    expect(parseCdxLines('{"url": "https://a.test"}\n{broken\n\n{"other": 1}')).toEqual(["https://a.test"]);
  });
});

describe("CDX client", () => {
  it("lists valid indexes newest first", async () => {
    const { fetchImpl } = stubFetch({ "collinfo.json": { status: 200, body: COLLINFO } });
    expect((await listCrawlIndexes({ fetchImpl, ...fast })).map((index) => index.id)).toEqual(["CC-MAIN-2026-43", "CC-MAIN-2026-39"]);
  });

  it("retries 502 and 504 with growing delays, and treats 404 as no captures", async () => {
    const delays: number[] = [];
    const { fetchImpl } = stubFetch({
      "showNumPages=true": [
        { status: 504, body: "Gateway Time-out" },
        { status: 502, body: "Bad Gateway" },
        { status: 200, body: '{"pages": 3, "pageSize": 5, "blocks": 12}' },
      ],
    });
    const retries: string[] = [];
    const pages = await cdxPageCount("CC-MAIN-2026-43", { url: "jobs.lever.co/*" }, {
      fetchImpl,
      baseDelayMs: 100,
      sleep: async (ms) => {
        delays.push(ms);
      },
      onRetry: (detail) => retries.push(detail),
    });
    expect(pages).toBe(3);
    expect(delays).toEqual([100, 200]);
    expect(retries[0]).toContain("HTTP 504");
    expect(await cdxPageCount("CC-MAIN-2026-43", { url: "jobs.lever.co/*" }, { fetchImpl: stubFetch({}).fetchImpl, ...fast })).toBe(0);
  });

  it("gives up after the configured attempts", async () => {
    const { fetchImpl, requests } = stubFetch({ "showNumPages=true": { status: 503, body: "busy" } });
    await expect(cdxPageCount("CC-MAIN-2026-43", { url: "jobs.lever.co/*" }, { fetchImpl, ...fast, attempts: 3 })).rejects.toMatchObject({ code: "cc_unavailable" });
    expect(requests).toHaveLength(3);
    await expect(cdxPageCount("../etc", { url: "x" }, { fetchImpl, ...fast })).rejects.toMatchObject({ code: "invalid_index" });
  });
});

describe("harvestBoards", () => {
  const companies = [
    CompanySchema.parse({ name: "Acme Robotics", ats: "greenhouse", board: "acmerobotics" }),
    CompanySchema.parse({ name: "Vandelay", ats: "workday", board: "vandelay/wd1/Careers" }),
  ];

  function routes() {
    return {
      "collinfo.json": { status: 200, body: COLLINFO },
      [`url=${encodeURIComponent("job-boards.greenhouse.io/*")}&output=json&fl=url&showNumPages=true`]: { status: 200, body: '{"pages": 2}' },
      [`url=${encodeURIComponent("job-boards.greenhouse.io/*")}&output=json&fl=url&page=0`]: {
        status: 200,
        body: lines(
          "https://job-boards.greenhouse.io/acmerobotics/jobs/1",
          "https://job-boards.greenhouse.io/globex/jobs/2",
          "https://job-boards.greenhouse.io/globex/jobs/3",
          "https://job-boards.greenhouse.io/initech",
        ),
      },
      [`url=${encodeURIComponent("job-boards.greenhouse.io/*")}&output=json&fl=url&page=1`]: [
        { status: 500, body: "oops" },
      ],
      [`url=${encodeURIComponent("boards.greenhouse.io/*")}&output=json&fl=url&showNumPages=true`]: { status: 200, body: '{"pages": 1}' },
      [`url=${encodeURIComponent("boards.greenhouse.io/*")}&output=json&fl=url&page=0`]: {
        status: 200,
        body: lines("https://boards.greenhouse.io/embed/job_app?for=hooli&token=9", "http://boards.greenhouse.io/Globex"),
      },
      "url=myworkdayjobs.com&matchType=domain&output=json&fl=url&showNumPages=true": { status: 200, body: '{"pages": 1}' },
      "url=myworkdayjobs.com&matchType=domain&output=json&fl=url&page=0": {
        status: 200,
        body: lines(
          "https://kramerica.wd3.myworkdayjobs.com/University/job/1",
          "https://kramerica.wd3.myworkdayjobs.com/en-US/External/job/2",
          "https://kramerica.wd3.myworkdayjobs.com/External/job/3",
          "https://vandelay.wd1.myworkdayjobs.com/Careers/job/4",
        ),
      },
    };
  }

  it("stores boards that are neither tracked nor harvested before, page by page", async () => {
    insertHarvestedBoards(db, [{ ats: "greenhouse", board: "initech", region: "global", hits: 1, sourceIndex: "CC-MAIN-2026-39" }]);
    const { fetchImpl } = stubFetch(routes());
    const progress: HarvestProgress[] = [];
    const summary = await harvestBoards({ db, companies, ats: ["greenhouse", "workday"], fetchImpl, ...fast, attempts: 2 }, (event) => progress.push(event));

    expect(summary.indexes).toEqual(["CC-MAIN-2026-43"]);
    expect(summary.added).toBe(3);
    expect(summary.byAts).toEqual({ greenhouse: { seen: 4, added: 2 }, workday: { seen: 3, added: 1 } });
    expect(summary.errors).toEqual([expect.stringContaining("page 1")]);
    expect(summary.aborted).toBe(false);

    const stored = allHarvestedBoards(db).map((board) => `${board.ats}:${board.board}:${board.hits}:${board.status}`).sort();
    expect(stored).toEqual([
      "greenhouse:globex:2:new",
      "greenhouse:hooli:1:new",
      "greenhouse:initech:1:new",
      // Two citations of the External site beat one of University.
      "workday:kramerica/wd3/External:2:new",
    ]);
    expect(progress.map((event) => event.stage)).toContain("page");
    expect(progress.at(-1)).toMatchObject({ stage: "done" });
    expect(listHarvestRuns(db)[0]).toMatchObject({ kind: "harvest", status: "done" });

    // A second harvest finds nothing new.
    const again = await harvestBoards({ db, companies, ats: ["greenhouse", "workday"], fetchImpl: stubFetch(routes()).fetchImpl, ...fast, attempts: 1 });
    expect(again.added).toBe(0);
  });

  it("stops when cancelled and keeps what it already stored", async () => {
    const controller = new AbortController();
    const { fetchImpl } = stubFetch(routes());
    const summary = await harvestBoards(
      { db, companies, ats: ["greenhouse"], indexIds: ["CC-MAIN-2026-43"], fetchImpl, ...fast, attempts: 1 },
      (event) => {
        if (event.stage === "page") controller.abort();
      },
      controller.signal,
    );
    expect(summary.aborted).toBe(true);
    expect(summary.pagesRead).toBe(1);
    expect(allHarvestedBoards(db).map((board) => board.board).sort()).toEqual(["globex", "initech"]);
    expect(listHarvestRuns(db)[0]).toMatchObject({ status: "aborted" });
  });

  it("records a failed run when the index list cannot be read", async () => {
    const { fetchImpl } = stubFetch({ "collinfo.json": { status: 502, body: "bad gateway" } });
    const summary = await harvestBoards({ db, companies, fetchImpl, ...fast, attempts: 2 });
    expect(summary.errors[0]).toContain("cc_unavailable");
    expect(listHarvestRuns(db)[0]).toMatchObject({ status: "failed" });
  });
});
