import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanySchema } from "../src/domain/campaign.js";
import { AppError } from "../src/util/errors.js";
import { logger } from "../src/util/logger.js";
import { ENTERPRISE_ADAPTERS, ENTERPRISE_CATALOG } from "../src/sources/batches/enterprise.js";
import { oracleCloudAdapter, oracleListingUrl, parseOracleBoard } from "../src/sources/oracleCloud.js";
import {
  oracleDetail, oracleEmptyDetail, oracleListPage, oracleRow, oracleRowWithSecondary,
} from "./fixtures/oracleCloud.js";

const capturedAt = "2026-11-07T00:00:00.000Z";
const BOARD = "jpmc.fa.oraclecloud.com/CX_1002";

function company(overrides: Record<string, unknown> = {}) {
  return CompanySchema.parse({ name: "JPMorgan Chase", ats: "oraclecloud", board: BOARD, ...overrides });
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

type Call = { url: URL; init?: RequestInit };

/** Routes listing and detail requests the way the real API splits them. */
function stub(listing: (offset: number, url: URL) => Response, detail: (id: string) => Response): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    calls.push({ url, init });
    if (url.pathname.endsWith("/recruitingCEJobRequisitions")) return listing(Number(url.searchParams.get("offset")), url);
    const id = /Id="([^"]+)"/.exec(decodeURIComponent(url.searchParams.get("finder") ?? ""))?.[1] ?? "";
    return detail(id);
  }));
  return calls;
}

function detailFor(id: string, overrides: Record<string, unknown> = {}) {
  return json(oracleDetail({ Id: id, ...overrides }));
}

beforeEach(() => {
  process.env.AUTOAPPLY_MIN_INTERVAL_MS = "0";
  delete process.env.AUTOAPPLY_ORACLECLOUD_MAX_POSTINGS;
  delete process.env.AUTOAPPLY_ORACLECLOUD_MAX_DETAILS;
  vi.spyOn(logger, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.AUTOAPPLY_ORACLECLOUD_MAX_POSTINGS;
  delete process.env.AUTOAPPLY_ORACLECLOUD_MAX_DETAILS;
});

describe("enterprise batch", () => {
  const kinds = ["icims", "taleo", "successfactors", "oraclecloud", "phenom", "eightfold", "avature", "csod", "ultipro", "adp", "paylocity", "jobvite"] as const;

  it("registers one adapter per enterprise ATS under its own kind", () => {
    expect(Object.keys(ENTERPRISE_ADAPTERS).sort()).toEqual([...kinds].sort());
    for (const kind of kinds) expect(ENTERPRISE_ADAPTERS[kind]!.kind).toBe(kind);
    expect(ENTERPRISE_ADAPTERS.oraclecloud).toBe(oracleCloudAdapter);
  });

  it("describes each one as public, discovery-only and manually submitted, naming its board format", () => {
    expect(ENTERPRISE_CATALOG.map((source) => source.id).sort()).toEqual([...kinds].sort());
    for (const source of ENTERPRISE_CATALOG) {
      expect(source).toMatchObject({ kind: "ats", integration: "discovery-only", access: "public", readiness: "ready", submission: "manual-only" });
      expect(source.url).toMatch(/^https:\/\//);
      expect(source.docs).toMatch(/^https:\/\//);
      expect(source.limitations.join(" ")).toMatch(/Board is/);
      expect(source.limitations.join(" ")).toMatch(/manual packets/);
    }
  });
});

describe("oracle cloud board", () => {
  it("splits the host and site number", () => {
    expect(parseOracleBoard(BOARD)).toEqual({ host: "jpmc.fa.oraclecloud.com", site: "CX_1002" });
    expect(parseOracleBoard("Acme.FA.us2.OracleCloud.com/CX_1").host).toBe("acme.fa.us2.oraclecloud.com");
    expect(parseOracleBoard("tenant.fa.ocs.oraclecloud26.com/CX_45001").site).toBe("CX_45001");
  });

  it.each(["jpmc.fa.oraclecloud.com", "jpmc/CX_1", "evil.example.com/CX_1", "jpmc.fa.oraclecloud.com/CX 1/x"])(
    "rejects %s with an example of the expected shape", (board) => {
      expect(() => parseOracleBoard(board)).toThrow(AppError);
      expect(() => parseOracleBoard(board)).toThrow(/jpmc\.fa\.oraclecloud\.com\/CX_1002/);
    },
  );

  it("names the board a pasted careers URL points at", () => {
    expect(() => parseOracleBoard("https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1002/jobs"))
      .toThrow(/use the board "jpmc\.fa\.oraclecloud\.com\/CX_1002"/);
  });

  it("builds the public board page and the listing endpoint", () => {
    expect(oracleCloudAdapter.boardUrl(company())).toBe(
      "https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1002/jobs",
    );
    const url = new URL(oracleCloudAdapter.listUrl(company()));
    expect(url.pathname).toBe("/hcmRestApi/resources/latest/recruitingCEJobRequisitions");
    expect(url.searchParams.get("finder")).toContain("siteNumber=CX_1002");
    expect(oracleCloudAdapter.probeUrls("jpmc")).toEqual([]);
  });

  it("quotes the campaign query as the finder keyword and strips finder separators", () => {
    const url = oracleListingUrl(parseOracleBoard(BOARD), 'software "engineer", java;', 0);
    expect(url).toContain(`keyword=${encodeURIComponent('"software engineer java"')}`);
  });
});

describe("oracle cloud listing", () => {
  it("merges each listing row with its detail and parses pay from the flex fields", async () => {
    stub(() => json(oracleListPage([oracleRow(), oracleRowWithSecondary()])), (id) => detailFor(id));

    const jobs = await oracleCloudAdapter.listJobs(company(), capturedAt);

    expect(jobs).toHaveLength(2);
    const [first, second] = jobs;
    expect(first).toMatchObject({
      ats: "oraclecloud",
      board: BOARD,
      externalId: "210690282",
      title: "2027 Markets Summer Analyst Program - Research",
      url: "https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1002/job/210690282",
      postedAt: "2026-11-06T19:48:29.000Z",
      employmentType: "full time",
      country: "US",
      locationClass: "us-other",
    });
    expect(first!.applyUrl).toBe(first!.url);
    expect(first!.descriptionText).toContain("Strong analytical skills");
    expect(first!.descriptionText).toContain("Base Pay/Salary: New York,NY $100,000.00-$110,000.00");
    expect(first!.compensation).toMatchObject({ min: 100_000, max: 110_000 });
    expect(second!.locationsRaw).toEqual(["Columbus, OH, United States", "Nashville, TN, United States", "New York, NY, United States"]);
  });

  it("keeps a posting with listing fields when its detail cannot be read", async () => {
    stub(() => json(oracleListPage([oracleRow(), oracleRowWithSecondary()])),
      (id) => (id === "210690282" ? json({ error: "blocked" }, 403) : detailFor(id)));
    process.env.AUTOAPPLY_ORACLECLOUD_MAX_DETAILS = "5";

    const jobs = await oracleCloudAdapter.listJobs(company(), capturedAt);

    expect(jobs.map((job) => job.externalId)).toEqual(["210690282", "210713605"]);
    expect(jobs[0]!.descriptionText).toContain("In ever-changing global markets");
    expect(jobs[0]!.postedAt).toBe("2026-11-06T00:00:00.000Z");
  });

  it("drops a posting the site stopped publishing between listing and detail", async () => {
    stub(() => json(oracleListPage([oracleRow(), oracleRowWithSecondary()])),
      (id) => (id === "210690282" ? json(oracleEmptyDetail) : detailFor(id)));

    const jobs = await oracleCloudAdapter.listJobs(company(), capturedAt);

    expect(jobs.map((job) => job.externalId)).toEqual(["210713605"]);
  });

  it("skips a malformed row without losing the rest of the page", async () => {
    stub(() => json(oracleListPage([{ Id: "999", Title: "" }, oracleRowWithSecondary()])), (id) => detailFor(id));

    const jobs = await oracleCloudAdapter.listJobs(company(), capturedAt);

    expect(jobs.map((job) => job.externalId)).toEqual(["210713605"]);
  });

  it("fetches descriptions only up to the detail cap", async () => {
    process.env.AUTOAPPLY_ORACLECLOUD_MAX_DETAILS = "1";
    const calls = stub(() => json(oracleListPage([oracleRow(), oracleRowWithSecondary()])), (id) => detailFor(id));

    const jobs = await oracleCloudAdapter.listJobs(company(), capturedAt);

    const details = calls.filter((call) => call.url.pathname.endsWith("/recruitingCEJobRequisitionDetails"));
    expect(details).toHaveLength(1);
    expect(jobs[1]!.descriptionText).toBe(oracleRowWithSecondary().ShortDescriptionStr);
    expect(jobs[1]!.postedAt).toBe("2026-11-05T00:00:00.000Z");
  });

  it("pages by offset until the published total, even past a short page", async () => {
    // Oracle serves fewer rows than requested mid-list; only the total ends it.
    process.env.AUTOAPPLY_ORACLECLOUD_MAX_DETAILS = "0";
    const first = Array.from({ length: 199 }, (_unused, index) => oracleRow({ Id: String(1000 + index) }));
    const calls = stub((offset) => json(oracleListPage(offset === 0 ? first : [oracleRow({ Id: "5000" })], 250)), (id) => detailFor(id));

    const jobs = await oracleCloudAdapter.listJobs(company(), capturedAt);

    expect(jobs).toHaveLength(200);
    expect(calls.map((call) => call.url.searchParams.get("offset"))).toEqual(["0", "200"]);
  });

  it("stops at the per-board posting cap", async () => {
    process.env.AUTOAPPLY_ORACLECLOUD_MAX_POSTINGS = "3";
    process.env.AUTOAPPLY_ORACLECLOUD_MAX_DETAILS = "0";
    const page = Array.from({ length: 200 }, (_unused, index) => oracleRow({ Id: String(index + 1) }));
    const calls = stub(() => json(oracleListPage(page, 7000)), (id) => detailFor(id));

    const jobs = await oracleCloudAdapter.listJobs(company(), capturedAt);

    expect(jobs).toHaveLength(3);
    expect(calls).toHaveLength(1);
  });

  it("sends the campaign query to the listing finder", async () => {
    const calls = stub(() => json(oracleListPage([])), (id) => detailFor(id));

    await oracleCloudAdapter.listJobs(company({ query: "software engineer" }), capturedAt);

    expect(decodeURIComponent(calls[0]!.url.search)).toContain('keyword="software engineer"');
  });

  it("verifies a board with one small listing request", async () => {
    const calls = stub(() => json(oracleListPage([oracleRow()], 7142)), (id) => detailFor(id));

    const verification = await oracleCloudAdapter.verifyBoard!(company());

    expect(verification).toMatchObject({ ok: true, postings: 7142, sampleTitles: [oracleRow().Title] });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url.searchParams.get("limit")).toBe("5");
  });
});

describe("oracle cloud postings", () => {
  it.each([
    ["https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1002/job/210690282", "210690282"],
    ["https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1002/requisitions/preview/210690282/?utm_source=x", "210690282"],
  ])("recognizes %s", (raw, id) => {
    expect(oracleCloudAdapter.parsePostingUrl!(new URL(raw))).toEqual({ board: BOARD, externalId: id });
  });

  it.each([
    "https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1002/jobs",
    "https://example.com/hcmUI/CandidateExperience/en/sites/CX_1002/job/1",
  ])("ignores %s", (raw) => {
    expect(oracleCloudAdapter.parsePostingUrl!(new URL(raw))).toBeNull();
  });

  it("fetches one posting from its detail alone", async () => {
    stub(() => json(oracleListPage([])), (id) => detailFor(id));

    const job = await oracleCloudAdapter.fetchPosting!(company(), "210690282", capturedAt);

    expect(job).toMatchObject({ externalId: "210690282", country: "US", postedAt: "2026-11-06T19:48:29.000Z" });
  });

  it("returns null for a posting the site no longer has", async () => {
    stub(() => json(oracleListPage([])), () => json(oracleEmptyDetail));

    expect(await oracleCloudAdapter.fetchPosting!(company(), "1", capturedAt)).toBeNull();
  });

  async function storedJob() {
    stub(() => json(oracleListPage([oracleRow()])), (id) => detailFor(id));
    const [job] = await oracleCloudAdapter.listJobs(company(), capturedAt);
    vi.unstubAllGlobals();
    return job!;
  }

  it("reports a published requisition as open", async () => {
    const job = await storedJob();
    stub(() => json(oracleListPage([])), (id) => detailFor(id));
    expect(await oracleCloudAdapter.checkPosting!(job)).toMatchObject({ status: "open", via: "api" });
  });

  it("reports an unpublished requisition or an ended window as closed", async () => {
    const job = await storedJob();
    stub(() => json(oracleListPage([])), () => json(oracleEmptyDetail));
    expect(await oracleCloudAdapter.checkPosting!(job)).toMatchObject({ status: "closed" });

    stub(() => json(oracleListPage([])), (id) => detailFor(id, { ExternalPostedEndDate: "2020-01-01T00:00:00+00:00" }));
    expect(await oracleCloudAdapter.checkPosting!(job)).toMatchObject({ status: "closed" });
  });

  it("reports unknown, never closed, when the API cannot be read", async () => {
    const job = await storedJob();
    stub(() => json(oracleListPage([])), () => json({ error: "nope" }, 404));
    expect(await oracleCloudAdapter.checkPosting!(job)).toMatchObject({ status: "unknown" });

    stub(() => json(oracleListPage([])), () => json({ error: "blocked" }, 403));
    expect(await oracleCloudAdapter.checkPosting!(job)).toMatchObject({ status: "unknown" });

    expect(await oracleCloudAdapter.checkPosting!({ ...job, board: "not a board" })).toMatchObject({ status: "unknown" });
    expect(await oracleCloudAdapter.checkPosting!({ ...job, externalId: 'x"y' })).toMatchObject({ status: "unknown" });
    await expect(oracleCloudAdapter.fetchPosting!(company(), 'x"y', capturedAt)).rejects.toThrow(/not an Oracle requisition id/);
  });

  it("reports unknown when the network fails after retries", async () => {
    const job = await storedJob();
    vi.useFakeTimers();
    try {
      vi.stubGlobal("fetch", vi.fn(async () => { throw new TypeError("network down"); }));
      const pending = oracleCloudAdapter.checkPosting!(job);
      await vi.runAllTimersAsync();
      expect(await pending).toMatchObject({ status: "unknown", detail: expect.stringMatching(/network/) });
    } finally {
      vi.useRealTimers();
    }
  });
});
