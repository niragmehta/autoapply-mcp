import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanySchema, type Company } from "../src/domain/campaign.js";
import { openDatabase, type Db } from "../src/db/database.js";
import { allHarvestedBoards, insertHarvestedBoards, listHarvestRuns } from "../src/db/repositories/harvest.js";
import { listLeads } from "../src/db/repositories/leads.js";
import { displayName, scanBoard, scanHarvestedBoards, type ScanDeps } from "../src/sourcing/boardScan.js";
import { scanWorkdayBoard, titleMayFit, workdayQueries } from "../src/sourcing/workdayScan.js";
import { AppError } from "../src/util/errors.js";
import { makeCampaign, makeJob, makeProfile } from "./factories.js";

/** Boards and postings are fictional; fetching is stubbed. */

const NOW = new Date("2026-11-06T12:00:00Z");
const fresh = NOW.toISOString();

function fitting(company: Company, id: string) {
  return makeJob({ id: `job_${id}`, companyName: company.name, board: company.board, ats: company.ats, externalId: id, postedAt: fresh, capturedAt: fresh });
}

function intern(company: Company, id: string) {
  return makeJob({ id: `job_${id}`, companyName: company.name, board: company.board, ats: company.ats, title: "Security Engineering Intern", postedAt: fresh });
}

function deps(boards: Record<string, (company: Company) => ReturnType<ScanDeps["fetchBoard"]>>): ScanDeps & { fetched: string[] } {
  const fetched: string[] = [];
  return {
    fetched,
    fetchBoard: async (company) => {
      fetched.push(`${company.ats}:${company.board}`);
      const handler = boards[`${company.ats}:${company.board}`];
      if (!handler) throw new AppError("not_found", `board not found (404): ${company.board}`);
      return handler(company);
    },
    boardName: async (company) => (company.board === "globex" ? "Globex Analytics" : null),
  };
}

let db: Db;
beforeEach(() => {
  db = openDatabase(":memory:");
  process.env.AUTOAPPLY_MIN_INTERVAL_MS = "0";
});
afterEach(() => {
  db.close();
  vi.unstubAllGlobals();
});

describe("scanBoard", () => {
  it("evaluates postings in memory and reports the fitting ones", async () => {
    const stub = deps({ "greenhouse:globex": async (company) => ({ jobs: [fitting(company, "1"), intern(company, "2")], postings: 2 }) });
    const result = await scanBoard({ ats: "greenhouse", board: "globex", region: "global" }, { campaign: makeCampaign(), profile: makeProfile(), now: NOW, maxMatches: 5 }, stub);
    expect(result).toMatchObject({ status: "matching", company: "Globex Analytics", postings: 2, matching: 1 });
    expect(result.topMatches[0]).toMatchObject({ title: "Senior Security Engineer", track: "ai-security" });
    expect(db.prepare("SELECT COUNT(*) AS n FROM jobs").get()).toEqual({ n: 0 });
  });

  it("distinguishes dead, empty and failing boards", async () => {
    const context = { campaign: makeCampaign(), profile: makeProfile(), now: NOW, maxMatches: 5 };
    const stub = deps({
      "lever:quietco": async () => ({ jobs: [], postings: 0 }),
      "ashby:flaky": async () => {
        throw new AppError("retryable_http", "HTTP 503 from api.ashbyhq.com");
      },
    });
    expect((await scanBoard({ ats: "lever", board: "quietco", region: "global" }, context, stub)).status).toBe("empty");
    expect((await scanBoard({ ats: "greenhouse", board: "gone", region: "global" }, context, stub)).status).toBe("dead");
    const flaky = await scanBoard({ ats: "ashby", board: "flaky", region: "global" }, context, stub);
    expect(flaky).toMatchObject({ status: "error", detail: "[retryable_http] HTTP 503 from api.ashbyhq.com" });
    expect(displayName("workday", "kramerica/wd3/External")).toBe("Kramerica");
    expect(displayName("lever", "pied_piper-io")).toBe("Pied Piper Io");
  });
});

describe("scanHarvestedBoards", () => {
  it("scans new boards, records results and turns fitting boards into leads", async () => {
    insertHarvestedBoards(db, [
      { ats: "greenhouse", board: "globex", region: "global", hits: 5, sourceIndex: "CC-MAIN-2026-43" },
      { ats: "lever", board: "quietco", region: "global", hits: 2, sourceIndex: "CC-MAIN-2026-43" },
      { ats: "ashby", board: "gone", region: "global", hits: 1, sourceIndex: "CC-MAIN-2026-43" },
      { ats: "greenhouse", board: "acmerobotics", region: "global", hits: 9, sourceIndex: "CC-MAIN-2026-43" },
    ]);
    const stub = deps({
      "greenhouse:globex": async (company) => ({ jobs: [fitting(company, "1"), fitting(company, "3"), intern(company, "2")], postings: 3 }),
      "lever:quietco": async () => ({ jobs: [], postings: 0 }),
    });
    const workspace = {
      db,
      companies: [CompanySchema.parse({ name: "Acme Robotics", ats: "greenhouse", board: "acmerobotics" })],
      campaign: makeCampaign(),
      profile: makeProfile(),
    };
    const progress: string[] = [];
    const summary = await scanHarvestedBoards(workspace, { now: NOW, deps: stub, concurrency: 2 }, (event) => progress.push(event.message));

    expect(summary.scanned).toBe(4);
    expect(summary.counts).toEqual({ matching: 1, empty: 1, dead: 1, tracked: 1 });
    expect(stub.fetched).not.toContain("greenhouse:acmerobotics");
    expect(summary.matching).toEqual([expect.objectContaining({ company: "Globex Analytics", matching: 2, postings: 3 })]);

    const boards = Object.fromEntries(allHarvestedBoards(db).map((board) => [board.board, board]));
    expect(boards.globex).toMatchObject({ status: "matching", matching: 2, postings: 3, company: "Globex Analytics", lastScanned: fresh });
    expect(boards.gone).toMatchObject({ status: "dead" });
    expect(boards.acmerobotics).toMatchObject({ status: "tracked" });

    const leads = listLeads(db, { source: "common-crawl" });
    expect(leads).toEqual([
      expect.objectContaining({ company: "Globex Analytics", sourceId: "greenhouse:globex", details: { ats: "greenhouse", board: "globex", region: "global", matching: 2, postings: 3 } }),
    ]);
    expect(listHarvestRuns(db)[0]).toMatchObject({ kind: "scan", status: "done" });
    expect(progress.at(-1)).toContain("1 with fitting roles");

    // Scanned boards are not scanned again unless a rescan is asked for.
    const again = await scanHarvestedBoards(workspace, { now: NOW, deps: stub });
    expect(again.scanned).toBe(0);
    const rescan = await scanHarvestedBoards(workspace, { now: new Date("2026-11-20T00:00:00Z"), rescanAfterDays: 7, deps: stub });
    expect(rescan.scanned).toBe(1);
  });

  it("stops at once when cancelled", async () => {
    insertHarvestedBoards(db, [{ ats: "greenhouse", board: "globex", region: "global", hits: 1, sourceIndex: "x" }]);
    const controller = new AbortController();
    controller.abort();
    const workspace = { db, companies: [], campaign: makeCampaign(), profile: makeProfile() };
    const summary = await scanHarvestedBoards(workspace, { now: NOW, deps: deps({}) }, () => undefined, controller.signal);
    expect(summary).toMatchObject({ scanned: 0, aborted: true });
    expect(listHarvestRuns(db)[0]).toMatchObject({ status: "aborted" });
  });
});

describe("Workday title-first scan", () => {
  const campaign = makeCampaign();
  const company = CompanySchema.parse({ name: "Kramerica", ats: "workday", board: "kramerica/wd3/External", tier: "C" });

  it("searches with the tracks' title phrases and prefilters titles", () => {
    expect(workdayQueries(campaign)).toEqual(["security engineer", "ai security", "software engineer"]);
    expect(titleMayFit("Senior Security Engineer", campaign)).toBe(true);
    expect(titleMayFit("Security Engineering Intern", campaign)).toBe(false);
    expect(titleMayFit("Senior Sales Engineer", campaign)).toBe(false);
    expect(titleMayFit("Senior Accountant", campaign)).toBe(false);
  });

  it("reads details only for titles that could fit", async () => {
    const requests: Array<{ url: string; body?: string }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init?: RequestInit) => {
        requests.push({ url, body: init?.body ? String(init.body) : undefined });
        if (url.endsWith("/jobs")) {
          return Response.json({
            total: 140,
            jobPostings: [
              { title: "Senior Security Engineer", externalPath: "/job/Remote-US/Senior-Security-Engineer_R1", postedOn: "Posted 3 Days Ago" },
              { title: "Security Engineering Intern", externalPath: "/job/Remote-US/Intern_R2", postedOn: "Posted Today" },
              { title: "Senior Security Engineer, Old", externalPath: "/job/Remote-US/Old_R3", postedOn: "Posted 30+ Days Ago" },
            ],
          });
        }
        return Response.json({
          jobPostingInfo: {
            id: "abc123",
            title: "Senior Security Engineer",
            jobDescription: "<p>Build ai security guardrails and threat modeling. Pay range $220,000 - $280,000.</p>",
            location: "San Francisco, CA",
            startDate: "2026-11-03",
            timeType: "Full time",
            externalUrl: "https://kramerica.wd3.myworkdaysite.com/External/job/Remote-US/Senior-Security-Engineer_R1",
            country: { descriptor: "United States of America" },
            canApply: true,
            posted: true,
          },
        });
      }),
    );
    const result = await scanWorkdayBoard(company, makeCampaign({ freshnessDays: 14 }), fresh);
    const searches = requests.filter((request) => request.url.endsWith("/jobs"));
    expect(searches).toHaveLength(3);
    expect(JSON.parse(searches[0]!.body!)).toEqual({ appliedFacets: {}, limit: 20, offset: 0, searchText: "security engineer" });
    const details = requests.filter((request) => !request.url.endsWith("/jobs"));
    expect(details.map((request) => request.url)).toEqual([
      "https://kramerica.wd3.myworkdayjobs.com/wday/cxs/kramerica/External/job/Remote-US/Senior-Security-Engineer_R1",
    ]);
    expect(result.postings).toBe(140);
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0]).toMatchObject({
      title: "Senior Security Engineer",
      country: "US",
      url: "https://kramerica.wd3.myworkdayjobs.com/External/job/Remote-US/Senior-Security-Engineer_R1",
      postedAt: "2026-11-03T00:00:00.000Z",
    });
  });
});
