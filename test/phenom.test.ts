import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanySchema } from "../src/domain/campaign.js";
import { AppError } from "../src/util/errors.js";
import { logger } from "../src/util/logger.js";
import { parsePhenomBoard, phenomAdapter } from "../src/sources/phenom.js";
import { PHENOM_BOARD, PHENOM_NO_DETAIL, phenomDetail, phenomJob, phenomSearch, phenomUsJob } from "./fixtures/phenom.js";

const capturedAt = "2026-11-07T00:00:00.000Z";

function company(overrides: Record<string, unknown> = {}) {
  return CompanySchema.parse({ name: "Mastercard", ats: "phenom", board: PHENOM_BOARD, ...overrides });
}

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

type Body = Record<string, unknown>;

function stub(search: (body: Body) => Response, detail: (jobId: string) => Response = () => json(phenomDetail())): Body[] {
  const bodies: Body[] = [];
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    expect(new URL(input).pathname).toBe("/widgets");
    const body = JSON.parse(String(init?.body)) as Body;
    bodies.push(body);
    return body.ddoKey === "refineSearch" ? search(body) : detail(String(body.jobId));
  }));
  return bodies;
}

beforeEach(() => {
  process.env.AUTOAPPLY_MIN_INTERVAL_MS = "0";
  delete process.env.AUTOAPPLY_PHENOM_MAX_POSTINGS;
  delete process.env.AUTOAPPLY_PHENOM_MAX_DETAILS;
  vi.spyOn(logger, "warn").mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  delete process.env.AUTOAPPLY_PHENOM_MAX_POSTINGS;
  delete process.env.AUTOAPPLY_PHENOM_MAX_DETAILS;
});

describe("phenom board", () => {
  it("splits host, country and language", () => {
    expect(parsePhenomBoard(PHENOM_BOARD)).toEqual({ host: "careers.mastercard.com", country: "us", language: "en" });
    expect(parsePhenomBoard("careers.example.com/global/en")).toMatchObject({ country: "global" });
  });

  it.each(["careers.mastercard.com", "careers.mastercard.com/usa/en", "careers.mastercard.com/us/english", "us/en/x"])(
    "rejects %s", (board) => {
      expect(() => parsePhenomBoard(board)).toThrow(AppError);
      expect(() => parsePhenomBoard(board)).toThrow(/careers\.mastercard\.com\/us\/en/);
    },
  );

  it("names the board a pasted search URL points at", () => {
    expect(() => parsePhenomBoard("https://careers.mastercard.com/us/en/search-results?keywords=java"))
      .toThrow(/use the board "careers\.mastercard\.com\/us\/en"/);
  });

  it("builds the widget endpoint and the public search page", () => {
    expect(phenomAdapter.listUrl(company())).toBe("https://careers.mastercard.com/widgets");
    expect(phenomAdapter.boardUrl(company())).toBe("https://careers.mastercard.com/us/en/search-results");
    expect(phenomAdapter.probeUrls("mastercard")).toEqual([]);
  });
});

describe("phenom listing", () => {
  it("merges search hits with job details and sends the site locale", async () => {
    const bodies = stub(() => json(phenomSearch([phenomUsJob()])));

    const [job] = await phenomAdapter.listJobs(company(), capturedAt);

    expect(job).toMatchObject({
      ats: "phenom",
      externalId: "R-294101",
      title: "Senior Software Engineer",
      url: "https://careers.mastercard.com/us/en/job/R-294101/Senior-Software-Engineer",
      locationsRaw: ["O'Fallon, Missouri, United States of America"],
      country: "US",
      postedAt: "2026-11-03T00:00:00.000Z",
      employmentType: "full time",
    });
    expect(job!.applyUrl).toBe(job!.url);
    expect(job!.descriptionText).toContain("200+ countries");
    expect(job!.compensation).toMatchObject({ min: 134_000, max: 214_000 });
    expect(bodies[0]).toMatchObject({ lang: "en_us", country: "us", ddoKey: "refineSearch", from: 0, size: 100 });
    expect(bodies[1]).toMatchObject({ lang: "en_us", ddoKey: "jobDetail", jobId: "R-294101" });
  });

  it("does not pin a multi-location posting to its primary country", async () => {
    process.env.AUTOAPPLY_PHENOM_MAX_DETAILS = "0";
    stub(() => json(phenomSearch([phenomJob({ multi_location: ["Vancouver, Canada", "Pune, India"] })])));

    const [job] = await phenomAdapter.listJobs(company(), capturedAt);

    expect(job!.locationsRaw).toEqual(["Vancouver, Canada", "Pune, India"]);
    expect(job!.descriptionText).toContain("strategic Director, Data Science");
    expect(job!.locationClass).toBe("canada");
  });

  it("keeps a hit whose detail fails and drops one the site no longer has", async () => {
    stub(
      () => json(phenomSearch([phenomUsJob(), phenomJob({ jobId: "R-1" }), phenomJob({ jobId: "R-2" })])),
      (jobId) => (jobId === "R-1" ? json(PHENOM_NO_DETAIL) : jobId === "R-2" ? json({ error: "blocked" }, 403) : json(phenomDetail())),
    );

    const jobs = await phenomAdapter.listJobs(company(), capturedAt);

    expect(jobs.map((job) => job.externalId)).toEqual(["R-294101", "R-2"]);
    expect(jobs[1]!.descriptionText).toContain("strategic Director");
  });

  it("skips a malformed hit", async () => {
    stub(() => json(phenomSearch([{ jobId: "X1" }, phenomUsJob()])));
    expect((await phenomAdapter.listJobs(company(), capturedAt)).map((job) => job.externalId)).toEqual(["R-294101"]);
  });

  it("caps detail calls", async () => {
    process.env.AUTOAPPLY_PHENOM_MAX_DETAILS = "1";
    const bodies = stub(() => json(phenomSearch([phenomUsJob(), phenomJob()])));

    await phenomAdapter.listJobs(company(), capturedAt);

    expect(bodies.filter((body) => body.ddoKey === "jobDetail")).toHaveLength(1);
  });

  it("pages by offset until the total and sends the query as keywords", async () => {
    process.env.AUTOAPPLY_PHENOM_MAX_DETAILS = "0";
    const full = Array.from({ length: 100 }, (_unused, index) => phenomUsJob({ jobId: `R-${index}` }));
    const bodies = stub((body) => json(phenomSearch(body.from === 0 ? full : [phenomUsJob({ jobId: "R-last" })], 101)));

    const jobs = await phenomAdapter.listJobs(company({ query: "software engineer" }), capturedAt);

    expect(jobs).toHaveLength(101);
    expect(bodies.map((body) => body.from)).toEqual([0, 100]);
    expect(bodies[0]!.keywords).toBe("software engineer");
  });

  it("stops at the posting cap", async () => {
    process.env.AUTOAPPLY_PHENOM_MAX_POSTINGS = "2";
    process.env.AUTOAPPLY_PHENOM_MAX_DETAILS = "0";
    const bodies = stub(() => json(phenomSearch([phenomUsJob({ jobId: "A" }), phenomUsJob({ jobId: "B" }), phenomUsJob({ jobId: "C" })], 900)));

    expect(await phenomAdapter.listJobs(company(), capturedAt)).toHaveLength(2);
    expect(bodies).toHaveLength(1);
  });

  it("verifies with a five-hit search", async () => {
    const bodies = stub(() => json(phenomSearch([phenomUsJob()], 954)));
    expect(await phenomAdapter.verifyBoard!(company())).toMatchObject({ ok: true, postings: 954 });
    expect(bodies[0]).toMatchObject({ size: 5 });
  });
});

describe("phenom postings", () => {
  it.each([
    ["https://careers.mastercard.com/us/en/job/R-280077/Director-Data-Science", { board: PHENOM_BOARD, externalId: "R-280077" }],
    ["https://careers.example.com/global/en/job/98098", { board: "careers.example.com/global/en", externalId: "98098" }],
  ])("recognizes %s", (raw, ref) => {
    expect(phenomAdapter.parsePostingUrl!(new URL(raw))).toEqual(ref);
  });

  it.each(["https://careers.mastercard.com/us/en/search-results", "https://example.com/en/job/x/y/1/2"])("ignores %s", (raw) => {
    expect(phenomAdapter.parsePostingUrl!(new URL(raw))).toBeNull();
  });

  it("fetches one posting from its detail and returns null once it is gone", async () => {
    stub(() => json(phenomSearch([])));
    expect(await phenomAdapter.fetchPosting!(company(), "R-294101", capturedAt)).toMatchObject({ externalId: "R-294101", country: "US" });

    stub(() => json(phenomSearch([])), () => json(PHENOM_NO_DETAIL));
    expect(await phenomAdapter.fetchPosting!(company(), "R-1", capturedAt)).toBeNull();
  });

  async function storedJob() {
    stub(() => json(phenomSearch([phenomUsJob()])));
    const [job] = await phenomAdapter.listJobs(company(), capturedAt);
    vi.unstubAllGlobals();
    return job!;
  }

  it("reads open, closed and unknown from the job detail", async () => {
    const job = await storedJob();
    stub(() => json(phenomSearch([])));
    expect(await phenomAdapter.checkPosting!(job)).toMatchObject({ status: "open", via: "api" });

    stub(() => json(phenomSearch([])), () => json(PHENOM_NO_DETAIL));
    expect(await phenomAdapter.checkPosting!(job)).toMatchObject({ status: "closed" });

    stub(() => json(phenomSearch([])), () => json(phenomDetail({ postingEndDate: "2020-01-01T00:00:00.000+0000" })));
    expect(await phenomAdapter.checkPosting!(job)).toMatchObject({ status: "closed" });

    stub(() => json(phenomSearch([])), () => json({ error: "waf" }, 403));
    expect(await phenomAdapter.checkPosting!(job)).toMatchObject({ status: "unknown" });

    expect(await phenomAdapter.checkPosting!({ ...job, board: "x" })).toMatchObject({ status: "unknown" });
    expect(await phenomAdapter.checkPosting!({ ...job, externalId: "../x" })).toMatchObject({ status: "unknown" });
    await expect(phenomAdapter.fetchPosting!(company(), "../x", capturedAt)).rejects.toThrow(/not a Phenom job id/);
  });

  it("reports unknown when the widget answers with something other than JSON", async () => {
    const job = await storedJob();
    vi.useFakeTimers();
    try {
      stub(() => json(phenomSearch([])), () => new Response("<html>challenge</html>", { status: 200 }));
      const pending = phenomAdapter.checkPosting!(job);
      await vi.runAllTimersAsync();
      expect(await pending).toMatchObject({ status: "unknown" });
    } finally {
      vi.useRealTimers();
    }
  });
});
