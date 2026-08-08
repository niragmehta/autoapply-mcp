import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { parseBoard, postedOnToIso, workdayAdapter } from "../src/sources/workday.js";
import { CompanySchema } from "../src/domain/campaign.js";
import { AppError } from "../src/util/errors.js";

const capturedAt = "2026-08-08T00:00:00.000Z";

function company(overrides: Record<string, unknown> = {}) {
  return CompanySchema.parse({
    name: "Nvidia",
    ats: "workday",
    board: "nvidia/wd5/NVIDIAExternalCareerSite",
    ...overrides,
  });
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

/** Detail payload shaped after a real NVIDIA CXS response. */
function detail(overrides: Record<string, unknown> = {}) {
  return {
    jobPostingInfo: {
      id: "00bc3ed07241101f439a59b6d64d0000",
      title: "Intellectual Property Security Engineer",
      jobDescription: "<p>The base salary range is 224,000 USD - 356,500 USD for Level 5.</p>",
      location: "US, CA, Santa Clara",
      additionalLocations: ["US, TX, Austin"],
      postedOn: "Posted 11 Days Ago",
      timeType: "Full time",
      jobReqId: "JR2021915",
      externalUrl: "https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite/job/x_JR2021915",
      canApply: true,
      posted: true,
      ...overrides,
    },
  };
}

/**
 * Routes list requests and detail requests the way the real API splits them,
 * so tests exercise the two-phase fetch rather than a single stubbed call.
 */
function stubBoard(pages: unknown[][], detailFor: (path: string) => Response) {
  const calls: { url: string; init?: RequestInit }[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.endsWith("/jobs") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as { offset: number };
        const page = pages[body.offset / 20] ?? [];
        return jsonResponse({ total: pages.flat().length, jobPostings: page });
      }
      return detailFor(url);
    }),
  );
  return calls;
}

function posting(path: string) {
  return { title: "Security Engineer", externalPath: path, locationsText: "5 Locations" };
}

beforeEach(() => {
  process.env.AUTOAPPLY_MIN_INTERVAL_MS = "0";
  delete process.env.AUTOAPPLY_WORKDAY_MAX_POSTINGS;
});

afterEach(() => {
  vi.unstubAllGlobals();
  delete process.env.AUTOAPPLY_WORKDAY_MAX_POSTINGS;
});

describe("workday board parsing", () => {
  it("splits the tenant, datacenter and site triple", () => {
    expect(parseBoard("nvidia/wd5/NVIDIAExternalCareerSite")).toEqual({
      tenant: "nvidia",
      datacenter: "wd5",
      site: "NVIDIAExternalCareerSite",
    });
  });

  it("rejects a bare slug rather than guessing the missing parts", () => {
    expect(() => parseBoard("nvidia")).toThrow(AppError);
  });

  it("rejects a datacenter that is not a wdN host", () => {
    // A wrong datacenter resolves to a real-looking host that returns nothing,
    // so this has to fail loudly instead of reporting an empty board.
    expect(() => parseBoard("nvidia/us-east/Careers")).toThrow(/wd5/);
  });

  it("builds the api and human board urls from the triple", () => {
    expect(workdayAdapter.listUrl(company())).toBe(
      "https://nvidia.wd5.myworkdayjobs.com/wday/cxs/nvidia/NVIDIAExternalCareerSite/jobs",
    );
    expect(workdayAdapter.boardUrl(company())).toBe(
      "https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite",
    );
  });

  it("does not probe, because the datacenter and site cannot be guessed", () => {
    expect(workdayAdapter.probeUrls()).toEqual([]);
  });
});

describe("workday posting age", () => {
  const now = new Date("2026-08-08T12:00:00.000Z");

  it("reads a relative day count", () => {
    expect(postedOnToIso("Posted 11 Days Ago", now)).toBe("2026-07-28T00:00:00.000Z");
  });

  it("handles today and yesterday", () => {
    expect(postedOnToIso("Posted Today", now)).toBe("2026-08-08T00:00:00.000Z");
    expect(postedOnToIso("Posted Yesterday", now)).toBe("2026-08-07T00:00:00.000Z");
  });

  it("treats a 30+ day bucket as its lower bound", () => {
    expect(postedOnToIso("Posted 30+ Days Ago", now)).toBe("2026-07-09T00:00:00.000Z");
  });

  it("returns null instead of inventing a date it cannot read", () => {
    expect(postedOnToIso("", now)).toBeNull();
    expect(postedOnToIso("Posted a while back", now)).toBeNull();
  });
});

describe("workday adapter", () => {
  it("fetches detail per posting and parses pay out of the description", async () => {
    stubBoard([[posting("/job/US-CA-Santa-Clara/IP-Security-Engineer_JR2021915")]], () =>
      jsonResponse(detail()),
    );

    const jobs = await workdayAdapter.listJobs(company(), capturedAt);

    expect(jobs).toHaveLength(1);
    const job = jobs[0]!;
    expect(job.title).toBe("Intellectual Property Security Engineer");
    expect(job.externalId).toBe("00bc3ed07241101f439a59b6d64d0000");
    // The list payload only says "5 Locations"; real locations come from detail.
    expect(job.locationsRaw).toEqual(["US, CA, Santa Clara", "US, TX, Austin"]);
    expect(job.locationClass).toBe("bay-area");
    expect(job.descriptionText).toContain("224,000 USD");
    expect(job.descriptionText).not.toContain("<p>");
    expect(job.compensation?.max).toBe(356_500);
    expect(job.postedAt).toBe("2026-07-28T00:00:00.000Z");
    expect(job.applyUrl).toContain("NVIDIAExternalCareerSite");
  });

  it("sends the campaign query as the server-side search filter", async () => {
    const calls = stubBoard([[]], () => jsonResponse(detail()));

    await workdayAdapter.listJobs(company({ query: "security engineer" }), capturedAt);

    const body = JSON.parse(String(calls[0]!.init!.body));
    expect(calls[0]!.init!.method).toBe("POST");
    expect(body).toMatchObject({ limit: 20, offset: 0, searchText: "security engineer" });
  });

  it("pages until a short page ends the board", async () => {
    const full = Array.from({ length: 20 }, (_unused, index) => posting(`/job/a/role-${index}`));
    const calls = stubBoard([full, [posting("/job/a/role-20")]], () => jsonResponse(detail()));

    const jobs = await workdayAdapter.listJobs(company(), capturedAt);

    expect(jobs).toHaveLength(21);
    const offsets = calls
      .filter((call) => call.init?.method === "POST")
      .map((call) => JSON.parse(String(call.init!.body)).offset);
    expect(offsets).toEqual([0, 20]);
  });

  it("stops at the per-board cap so a huge tenant cannot run away", async () => {
    process.env.AUTOAPPLY_WORKDAY_MAX_POSTINGS = "5";
    const full = Array.from({ length: 20 }, (_unused, index) => posting(`/job/a/role-${index}`));
    stubBoard([full, full], () => jsonResponse(detail()));

    const jobs = await workdayAdapter.listJobs(company(), capturedAt);

    expect(jobs).toHaveLength(5);
  });

  it("skips postings that are unpublished or closed to applications", async () => {
    stubBoard([[posting("/job/a/one"), posting("/job/a/two")]], (url) =>
      jsonResponse(url.endsWith("/one") ? detail({ posted: false }) : detail({ canApply: false })),
    );

    expect(await workdayAdapter.listJobs(company(), capturedAt)).toEqual([]);
  });

  it("keeps the rest of the board when one posting dies mid-crawl", async () => {
    stubBoard([[posting("/job/a/dead"), posting("/job/a/live")]], (url) =>
      url.endsWith("/dead") ? jsonResponse({ error: "gone" }, 404) : jsonResponse(detail()),
    );

    const jobs = await workdayAdapter.listJobs(company(), capturedAt);

    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.title).toBe("Intellectual Property Security Engineer");
  });

  it("detects remote from a location entry when remoteType is blank", async () => {
    stubBoard([[posting("/job/a/one")]], () =>
      jsonResponse(detail({ location: "US, MI, Remote", additionalLocations: [], remoteType: "" })),
    );

    const jobs = await workdayAdapter.listJobs(company(), capturedAt);

    expect(jobs[0]!.workplaceType).toBe("remote");
  });
});
