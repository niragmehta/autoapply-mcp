import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanySchema } from "../src/domain/campaign.js";
import { AppError } from "../src/util/errors.js";
import { logger } from "../src/util/logger.js";
import { adpAdapter, parseAdpBoard } from "../src/sources/adp.js";
import { ADP_BOARD, ADP_MISSING, adpDetail, adpList, adpRequisition } from "./fixtures/adp.js";

const capturedAt = "2026-11-07T00:00:00.000Z";

function company(overrides: Record<string, unknown> = {}) {
  return CompanySchema.parse({ name: "Palmetto State Armory", ats: "adp", board: ADP_BOARD, ...overrides });
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

function stub(list: (skip: number, url: URL) => Response, detail: (itemId: string) => Response = (itemId) => json(adpDetail({ itemID: itemId }))): URL[] {
  const calls: URL[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string) => {
    const url = new URL(input);
    calls.push(url);
    if (url.pathname.endsWith("/job-requisitions")) return list(Number(url.searchParams.get("$skip")), url);
    return detail(decodeURIComponent(url.pathname.split("/").pop() ?? ""));
  }));
  return calls;
}

function requisitions(from: number, count: number) {
  return Array.from({ length: count }, (_unused, index) => adpRequisition({ itemID: `${from + index}_1`, requisitionTitle: `Role ${from + index}` }));
}

beforeEach(() => {
  process.env.AUTOAPPLY_MIN_INTERVAL_MS = "0";
  delete process.env.AUTOAPPLY_ADP_MAX_POSTINGS;
  delete process.env.AUTOAPPLY_ADP_MAX_DETAILS;
  vi.spyOn(logger, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.AUTOAPPLY_ADP_MAX_POSTINGS;
  delete process.env.AUTOAPPLY_ADP_MAX_DETAILS;
});

describe("adp board", () => {
  it("reads the cid and an optional ccId", () => {
    expect(parseAdpBoard(ADP_BOARD.toUpperCase())).toEqual({ cid: ADP_BOARD, ccId: null });
    expect(parseAdpBoard(`${ADP_BOARD}/19000101_000001`)).toEqual({ cid: ADP_BOARD, ccId: "19000101_000001" });
  });

  it.each(["palmetto", `${ADP_BOARD}/abc`, `${ADP_BOARD}/1/2`])("rejects %s", (board) => {
    expect(() => parseAdpBoard(board)).toThrow(AppError);
    expect(() => parseAdpBoard(board)).toThrow(/1774d0ee-6390-4d36-9333-1f675e3b3058/);
  });

  it("names the board a pasted careers URL points at", () => {
    expect(() => parseAdpBoard(`https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html?cid=${ADP_BOARD}&ccId=19000101_000001&lang=en_US`))
      .toThrow(new RegExp(`use the board "${ADP_BOARD}/19000101_000001"`));
  });

  it("builds the careers page and the staffing API url", () => {
    expect(adpAdapter.boardUrl(company())).toBe(`https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html?cid=${ADP_BOARD}&lang=en_US`);
    const list = new URL(adpAdapter.listUrl(company({ board: `${ADP_BOARD}/19000101_000001` })));
    expect(Object.fromEntries(list.searchParams)).toEqual({ cid: ADP_BOARD, ccId: "19000101_000001", lang: "en_US", locale: "en_US", $skip: "1", $top: "20" });
    expect(adpAdapter.probeUrls("palmetto")).toEqual([]);
  });
});

describe("adp listing", () => {
  it("merges requisitions with their details and reads the published pay grade", async () => {
    stub(() => json(adpList([adpRequisition()])));

    const [job] = await adpAdapter.listJobs(company(), capturedAt);

    expect(job).toMatchObject({
      ats: "adp",
      externalId: "9200956893617_18",
      title: "Polisher",
      url: `https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html?cid=${ADP_BOARD}&jobId=580568&lang=en_US`,
      locationsRaw: ["Summerville, SC"],
      locationClass: "us-other",
      country: "US",
      postedAt: "2026-11-06T15:58:00.000Z",
      employmentType: "full time",
      compensation: { min: 18, max: 22, currency: "USD", period: "hour", source: "ats-structured" },
    });
    expect(job!.applyUrl).toBe(job!.url);
    expect(job!.descriptionText).toContain("polish and deburring");
  });

  it("pages with a one-based skip until the total", async () => {
    process.env.AUTOAPPLY_ADP_MAX_DETAILS = "0";
    const calls = stub((skip) => json(adpList(skip === 1 ? requisitions(0, 20) : requisitions(20, 5), 25)));

    const jobs = await adpAdapter.listJobs(company(), capturedAt);

    expect(jobs).toHaveLength(25);
    expect(calls.map((url) => url.searchParams.get("$skip"))).toEqual(["1", "21"]);
  });

  it("caps postings and details, keeps failed details and drops withdrawn requisitions", async () => {
    process.env.AUTOAPPLY_ADP_MAX_POSTINGS = "3";
    process.env.AUTOAPPLY_ADP_MAX_DETAILS = "2";
    const calls = stub(
      () => json(adpList([...requisitions(0, 4), { itemID: "bad", requisitionTitle: "Broken" }], 40)),
      (itemId) => (itemId === "0_1" ? json(ADP_MISSING) : json({ message: "blocked" }, 403)),
    );

    const jobs = await adpAdapter.listJobs(company(), capturedAt);

    expect(jobs.map((job) => job.externalId)).toEqual(["1_1", "2_1"]);
    expect(calls.filter((url) => !url.pathname.endsWith("/job-requisitions"))).toHaveLength(2);
  });

  it("verifies with a five-row page", async () => {
    const calls = stub(() => json(adpList([adpRequisition()], 32)));
    expect(await adpAdapter.verifyBoard!(company())).toMatchObject({ ok: true, postings: 32, sampleTitles: ["Polisher"] });
    expect(calls[0]!.searchParams.get("$top")).toBe("5");
  });
});

describe("adp postings", () => {
  it.each([
    [`https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html?cid=${ADP_BOARD}&ccId=19000101_000001&jobId=580568&lang=en_US`, { board: `${ADP_BOARD}/19000101_000001`, externalId: "580568" }],
    [`https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html?cid=${ADP_BOARD}&jobId=580568&jwId=9200956893617_18`, { board: ADP_BOARD, externalId: "9200956893617_18" }],
  ])("recognizes %s", (raw, ref) => {
    expect(adpAdapter.parsePostingUrl!(new URL(raw))).toEqual(ref);
  });

  it("ignores a careers page without a job", () => {
    expect(adpAdapter.parsePostingUrl!(new URL(`https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html?cid=${ADP_BOARD}`))).toBeNull();
  });

  it("fetches by item id, or by the public job number through the listing", async () => {
    const calls = stub(() => json(adpList([adpRequisition()])));
    expect(await adpAdapter.fetchPosting!(company(), "9200956893617_18", capturedAt)).toMatchObject({ title: "Polisher" });
    expect(calls).toHaveLength(1);

    stub(() => json(adpList([adpRequisition()])));
    expect(await adpAdapter.fetchPosting!(company(), "580568", capturedAt)).toMatchObject({ externalId: "9200956893617_18" });
    expect(await adpAdapter.fetchPosting!(company(), "999999", capturedAt)).toBeNull();

    stub(() => json(adpList([])), () => json(ADP_MISSING));
    expect(await adpAdapter.fetchPosting!(company(), "1_1", capturedAt)).toBeNull();
    await expect(adpAdapter.fetchPosting!(company(), "a b", capturedAt)).rejects.toThrow(/not an ADP job id/);
  });

  it("reads open, closed and unknown from the requisition detail", async () => {
    stub(() => json(adpList([adpRequisition()])));
    const [job] = await adpAdapter.listJobs(company(), capturedAt);
    vi.unstubAllGlobals();

    stub(() => json(adpList([])));
    expect(await adpAdapter.checkPosting!(job!)).toMatchObject({ status: "open", via: "api" });

    stub(() => json(adpList([])), () => json(ADP_MISSING));
    expect(await adpAdapter.checkPosting!(job!)).toMatchObject({ status: "closed" });

    stub(() => json(adpList([])), () => json({ message: "blocked" }, 403));
    expect(await adpAdapter.checkPosting!(job!)).toMatchObject({ status: "unknown" });

    stub(() => json(adpList([])), () => json(adpDetail({ itemID: "1_1" })));
    expect(await adpAdapter.checkPosting!(job!)).toMatchObject({ status: "unknown" });

    expect(await adpAdapter.checkPosting!({ ...job!, externalId: "580568" })).toMatchObject({ status: "unknown" });
    expect(await adpAdapter.checkPosting!({ ...job!, board: "x" })).toMatchObject({ status: "unknown" });
  });
});
