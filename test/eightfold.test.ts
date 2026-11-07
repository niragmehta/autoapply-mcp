import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanySchema } from "../src/domain/campaign.js";
import { AppError } from "../src/util/errors.js";
import { logger } from "../src/util/logger.js";
import { eightfoldAdapter, parseEightfoldBoard } from "../src/sources/eightfold.js";
import {
  CAREERS_PAGE, NOT_PCSX, PCSX_DISABLED, PCSX_NOT_FOUND, pcsxDetail, pcsxPosition, pcsxSearch, v2Position, v2Search,
} from "./fixtures/eightfold.js";

const capturedAt = "2026-11-07T00:00:00.000Z";

function company(overrides: Record<string, unknown> = {}) {
  return CompanySchema.parse({ name: "Qualcomm", ats: "eightfold", board: "qualcomm/qualcomm.com", ...overrides });
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

type Routes = {
  pcsx?: (url: URL) => Response;
  pcsxDetail?: (id: string) => Response;
  v2?: (url: URL) => Response;
  v2Detail?: (id: string) => Response;
  careers?: () => Response;
};

function stub(routes: Routes): URL[] {
  const calls: URL[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const url = new URL(input);
    calls.push(url);
    if (url.pathname === "/api/pcsx/search") return (routes.pcsx ?? (() => json(NOT_PCSX, 403)))(url);
    if (url.pathname === "/api/pcsx/position_details") {
      return (routes.pcsxDetail ?? (() => json(pcsxDetail())))(url.searchParams.get("position_id") ?? "");
    }
    if (url.pathname === "/api/apply/v2/jobs") return (routes.v2 ?? (() => json(NOT_PCSX, 403)))(url);
    if (url.pathname.startsWith("/api/apply/v2/jobs/")) return (routes.v2Detail ?? (() => json(v2Position())))(url.pathname.split("/").pop() ?? "");
    if (url.pathname === "/careers") return (routes.careers ?? (() => new Response(CAREERS_PAGE)))();
    return json({}, 404);
  }));
  return calls;
}

beforeEach(() => {
  process.env.AUTOAPPLY_MIN_INTERVAL_MS = "0";
  delete process.env.AUTOAPPLY_EIGHTFOLD_MAX_POSTINGS;
  delete process.env.AUTOAPPLY_EIGHTFOLD_MAX_DETAILS;
  vi.spyOn(logger, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.AUTOAPPLY_EIGHTFOLD_MAX_POSTINGS;
  delete process.env.AUTOAPPLY_EIGHTFOLD_MAX_DETAILS;
});

describe("eightfold board", () => {
  it("reads a tenant, an optional domain and branded hosts", () => {
    expect(parseEightfoldBoard("qualcomm/qualcomm.com")).toEqual({ host: "qualcomm.eightfold.ai", domain: "qualcomm.com" });
    expect(parseEightfoldBoard("Micron")).toEqual({ host: "micron.eightfold.ai", domain: null });
    expect(parseEightfoldBoard("careers.qualcomm.com/qualcomm.com")).toEqual({ host: "careers.qualcomm.com", domain: "qualcomm.com" });
  });

  it.each(["qualcomm/not a domain", "qualcomm/qualcomm.com/x", "-bad-"])("rejects %s", (board) => {
    expect(() => parseEightfoldBoard(board)).toThrow(AppError);
    expect(() => parseEightfoldBoard(board)).toThrow(/qualcomm\/qualcomm\.com/);
  });

  it("names the board a pasted careers URL points at", () => {
    expect(() => parseEightfoldBoard("https://qualcomm.eightfold.ai/careers?domain=qualcomm.com"))
      .toThrow(/use the board "qualcomm\/qualcomm\.com"/);
  });

  it("builds urls and probes both APIs for a slug", () => {
    expect(eightfoldAdapter.boardUrl(company())).toBe("https://qualcomm.eightfold.ai/careers?domain=qualcomm.com");
    expect(eightfoldAdapter.listUrl(company({ query: "camera" }))).toBe(
      "https://qualcomm.eightfold.ai/api/pcsx/search?domain=qualcomm.com&start=0&query=camera",
    );
    expect(eightfoldAdapter.probeUrls("acme")).toEqual([
      "https://acme.eightfold.ai/api/apply/v2/jobs?start=0&num=1",
      "https://acme.eightfold.ai/api/pcsx/search?domain=acme.com&start=0",
    ]);
    expect(eightfoldAdapter.listUrl(company({ board: "micron" }))).toBe("https://micron.eightfold.ai/api/pcsx/search?start=0");
    expect(eightfoldAdapter.probeUrls("a b")).toEqual([]);
  });
});

describe("eightfold listing", () => {
  it("reads PCSX search and position details", async () => {
    stub({ pcsx: () => json(pcsxSearch([pcsxPosition()])) });

    const [job] = await eightfoldAdapter.listJobs(company(), capturedAt);

    expect(job).toMatchObject({
      ats: "eightfold",
      externalId: "446718505618",
      title: "Camera Subsystem Integration Lead",
      url: "https://qualcomm.eightfold.ai/careers/job/446718505618",
      locationsRaw: ["San Diego, California, United States of America"],
      locationClass: "us-other",
      country: "US",
      workplaceType: "onsite",
      postedAt: "2026-11-06T00:00:00.000Z",
    });
    expect(job!.applyUrl).toBe(job!.url);
    expect(job!.descriptionText).toContain("Qualcomm Technologies");
    expect(job!.compensation).toMatchObject({ min: 156_800, max: 235_200 });
  });

  it("switches to the classic API when PCSX refuses the tenant", async () => {
    const calls = stub({ pcsx: () => json(PCSX_DISABLED, 403), v2: () => json(v2Search([v2Position()])), v2Detail: () => json(v2Position()) });

    const [job] = await eightfoldAdapter.listJobs(company({ board: "example/example.com" }), capturedAt);

    expect(job).toMatchObject({
      externalId: "790297654321",
      title: "Process Engineer",
      url: "https://careers.example.com/careers/job/790297654321",
      postedAt: "2026-11-05T00:00:00.000Z",
    });
    expect(job!.descriptionText).toContain("300mm fab");
    expect(calls.some((url) => url.pathname === "/api/apply/v2/jobs/790297654321")).toBe(true);
  });

  it("reads the domain off the careers page once when the board omits it", async () => {
    const calls = stub({ pcsx: () => json(pcsxSearch([])) });

    await eightfoldAdapter.listJobs(company({ board: "micron" }), capturedAt);
    await eightfoldAdapter.listJobs(company({ board: "micron" }), capturedAt);

    expect(calls.filter((url) => url.pathname === "/careers")).toHaveLength(1);
    expect(calls.filter((url) => url.pathname === "/api/pcsx/search").map((url) => url.searchParams.get("domain"))).toEqual(["micron.com", "micron.com"]);
  });

  it("fails clearly when no domain can be found", async () => {
    stub({ careers: () => new Response("<html></html>") });
    await expect(eightfoldAdapter.listJobs(company({ board: "nodomain" }), capturedAt)).rejects.toThrow(/tenant\/domain/);
  });

  it("pages ten at a time until a short page and sends the query", async () => {
    process.env.AUTOAPPLY_EIGHTFOLD_MAX_DETAILS = "0";
    const full = Array.from({ length: 10 }, (_unused, index) => pcsxPosition({ id: 1000 + index }));
    const calls = stub({ pcsx: (url) => json(pcsxSearch(url.searchParams.get("start") === "0" ? full : [pcsxPosition({ id: 2000 })], 500)) });

    const jobs = await eightfoldAdapter.listJobs(company({ query: "camera" }), capturedAt);

    expect(jobs).toHaveLength(11);
    expect(calls.map((url) => url.searchParams.get("start"))).toEqual(["0", "10"]);
    expect(calls[0]!.searchParams.get("query")).toBe("camera");
  });

  it("stops at the posting cap and caps detail requests", async () => {
    process.env.AUTOAPPLY_EIGHTFOLD_MAX_POSTINGS = "3";
    process.env.AUTOAPPLY_EIGHTFOLD_MAX_DETAILS = "1";
    const full = Array.from({ length: 10 }, (_unused, index) => pcsxPosition({ id: 1000 + index }));
    const calls = stub({ pcsx: () => json(pcsxSearch(full, 2000)) });

    const jobs = await eightfoldAdapter.listJobs(company(), capturedAt);

    expect(jobs).toHaveLength(3);
    expect(calls.filter((url) => url.pathname === "/api/pcsx/search")).toHaveLength(1);
    expect(calls.filter((url) => url.pathname === "/api/pcsx/position_details")).toHaveLength(1);
  });

  it("keeps the pages already read when a later page is rate-limited", async () => {
    process.env.AUTOAPPLY_EIGHTFOLD_MAX_DETAILS = "0";
    const full = Array.from({ length: 10 }, (_unused, index) => pcsxPosition({ id: 1000 + index }));
    // A host of its own: the fake clock would otherwise leave the shared
    // per-host throttle waiting on later tests.
    vi.useFakeTimers();
    try {
      stub({ pcsx: (url) => (url.searchParams.get("start") === "0" ? json(pcsxSearch(full, 500)) : json({ message: "slow down" }, 429)) });
      const pending = eightfoldAdapter.listJobs(company({ board: "throttled/throttled.com" }), capturedAt);
      await vi.runAllTimersAsync();
      expect(await pending).toHaveLength(10);
    } finally {
      vi.useRealTimers();
    }
  });

  it("keeps a position whose detail fails, drops one that is gone and skips malformed rows", async () => {
    stub({
      pcsx: () => json(pcsxSearch([pcsxPosition({ id: 1 }), pcsxPosition({ id: 2 }), { id: "x", name: "Bad" }, pcsxPosition({ id: 3 })])),
      pcsxDetail: (id) => (id === "1" ? json({ message: "blocked" }, 403) : id === "2" ? json(PCSX_NOT_FOUND, 404) : json(pcsxDetail({ id: 3 }))),
    });

    const jobs = await eightfoldAdapter.listJobs(company(), capturedAt);

    expect(jobs.map((job) => job.externalId)).toEqual(["1", "3"]);
    expect(jobs[0]!.descriptionText).toBe("");
  });

  it("verifies with one search page", async () => {
    const calls = stub({ pcsx: () => json(pcsxSearch([pcsxPosition()], 2074)) });
    expect(await eightfoldAdapter.verifyBoard!(company())).toMatchObject({ ok: true, postings: 2074, sampleTitles: ["Camera Subsystem Integration Lead"] });
    expect(calls).toHaveLength(1);
  });
});

describe("eightfold postings", () => {
  it.each([
    ["https://qualcomm.eightfold.ai/careers/job/446718505618", { board: "qualcomm", externalId: "446718505618" }],
    ["https://qualcomm.eightfold.ai/careers?pid=446718505618&domain=qualcomm.com", { board: "qualcomm/qualcomm.com", externalId: "446718505618" }],
    ["https://careers.qualcomm.com/careers/job/446718505618", { board: "careers.qualcomm.com", externalId: "446718505618" }],
  ])("recognizes %s", (raw, ref) => {
    expect(eightfoldAdapter.parsePostingUrl!(new URL(raw))).toEqual(ref);
  });

  it.each(["https://qualcomm.eightfold.ai/careers", "https://example.com/careers?pid=123456789", "https://example.com/careers/job/12"])(
    "ignores %s", (raw) => {
      expect(eightfoldAdapter.parsePostingUrl!(new URL(raw))).toBeNull();
    },
  );

  it("fetches one posting and returns null once it is gone", async () => {
    stub({});
    expect(await eightfoldAdapter.fetchPosting!(company(), "446718505618", capturedAt)).toMatchObject({ title: "Camera Subsystem Integration Lead" });

    stub({ pcsxDetail: () => json(PCSX_NOT_FOUND, 404) });
    expect(await eightfoldAdapter.fetchPosting!(company(), "1", capturedAt)).toBeNull();
  });

  async function storedJob() {
    stub({ pcsx: () => json(pcsxSearch([pcsxPosition()])) });
    const [job] = await eightfoldAdapter.listJobs(company(), capturedAt);
    vi.unstubAllGlobals();
    return job!;
  }

  it("reads open, closed and unknown from position details", async () => {
    const job = await storedJob();
    stub({});
    expect(await eightfoldAdapter.checkPosting!(job)).toMatchObject({ status: "open", via: "api" });

    stub({ pcsxDetail: () => json(PCSX_NOT_FOUND, 404) });
    expect(await eightfoldAdapter.checkPosting!(job)).toMatchObject({ status: "closed" });

    stub({ pcsxDetail: () => json(NOT_PCSX, 403), v2Detail: () => json({ message: "missing" }, 404) });
    expect(await eightfoldAdapter.checkPosting!(job)).toMatchObject({ status: "closed" });

    stub({ pcsxDetail: () => json(NOT_PCSX, 403), v2Detail: () => json({ message: "waf" }, 403) });
    expect(await eightfoldAdapter.checkPosting!(job)).toMatchObject({ status: "unknown" });

    expect(await eightfoldAdapter.checkPosting!({ ...job, board: "a/b/c" })).toMatchObject({ status: "unknown" });
    expect(await eightfoldAdapter.checkPosting!({ ...job, externalId: "abc" })).toMatchObject({ status: "unknown" });
    await expect(eightfoldAdapter.fetchPosting!(company(), "abc", capturedAt)).rejects.toThrow(/not an Eightfold position id/);
  });
});
