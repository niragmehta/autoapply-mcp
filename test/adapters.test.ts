import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { greenhouseAdapter , hostedApplyUrl } from "../src/sources/greenhouse.js";
import { leverAdapter } from "../src/sources/lever.js";
import { ashbyAdapter } from "../src/sources/ashby.js";
import { fetchJson } from "../src/sources/http.js";
import { CompanySchema } from "../src/domain/campaign.js";

const capturedAt = new Date().toISOString();

function company(overrides: Record<string, unknown> = {}) {
  return CompanySchema.parse({ name: "Acme", ats: "greenhouse", board: "acme", ...overrides });
}

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  process.env.AUTOAPPLY_MIN_INTERVAL_MS = "0";
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("greenhouse adapter", () => {
  it("normalizes postings including structured pay", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          jobs: [
            {
              id: 4001,
              title: "Senior Security Engineer",
              updated_at: "2026-07-01T10:00:00Z",
              first_published: "2026-06-28T10:00:00Z",
              absolute_url: "https://job-boards.greenhouse.io/acme/jobs/4001",
              content: "&lt;p&gt;Build guardrails for agents.&lt;/p&gt;",
              location: { name: "San Francisco, CA" },
              offices: [{ name: "HQ", location: "San Francisco, CA, United States" }],
              pay_input_ranges: [{ min_cents: 22000000, max_cents: 28000000, currency_type: "USD", title: "SF Range" }],
            },
          ],
        }),
      ),
    );

    const jobs = await greenhouseAdapter.listJobs(company(), capturedAt);
    expect(jobs).toHaveLength(1);
    const job = jobs[0]!;
    expect(job.title).toBe("Senior Security Engineer");
    expect(job.locationClass).toBe("bay-area");
    expect(job.country).toBe("US");
    expect(job.descriptionText).toContain("Build guardrails for agents.");
    expect(job.descriptionText).not.toContain("<p>");
    expect(job.compensation?.min).toBe(220000);
    expect(job.compensation?.max).toBe(280000);
    expect(job.compensation?.source).toBe("ats-structured");
    expect(job.postedAt).toBe("2026-06-28T10:00:00Z");
  });

  it("handles an empty board", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ jobs: [] })));
    expect(await greenhouseAdapter.listJobs(company(), capturedAt)).toHaveLength(0);
  });
});

describe("lever adapter", () => {
  it("normalizes postings, locations and salary ranges", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse([
          {
            id: "abc-123",
            text: "Staff Software Engineer, Security",
            hostedUrl: "https://jobs.lever.co/acme/abc-123",
            applyUrl: "https://jobs.lever.co/acme/abc-123/apply",
            createdAt: 1751328000000,
            descriptionPlain: "Work on distributed systems security.",
            additionalPlain: "We value depth.",
            workplaceType: "hybrid",
            categories: { location: "Toronto, ON", allLocations: ["Toronto, ON", "Remote - Canada"], commitment: "Full-time" },
            salaryRange: { min: 210000, max: 260000, currency: "CAD", interval: "per-year-salary" },
          },
        ]),
      ),
    );

    const jobs = await leverAdapter.listJobs(company({ ats: "lever" }), capturedAt);
    const job = jobs[0]!;
    expect(job.title).toBe("Staff Software Engineer, Security");
    expect(job.locationClass).toBe("canada");
    expect(job.workplaceType).toBe("hybrid");
    expect(job.employmentType).toBe("full-time");
    expect(job.compensation?.currency).toBe("CAD");
    expect(job.descriptionText).toContain("We value depth.");
    expect(job.applyUrl).toContain("/apply");
  });

  it("tolerates a non-array response", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({})));
    expect(await leverAdapter.listJobs(company({ ats: "lever" }), capturedAt)).toHaveLength(0);
  });
});

describe("ashby adapter", () => {
  it("normalizes postings and compensation components", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          apiVersion: "1",
          jobs: [
            {
              id: "job-1",
              title: "Security Engineer, AI Safety",
              location: "San Francisco",
              secondaryLocations: [{ location: "Remote - US" }],
              isListed: true,
              isRemote: false,
              workplaceType: "Onsite",
              descriptionPlain: "Own guardrails for model deployments.",
              publishedAt: "2026-07-10T00:00:00Z",
              employmentType: "FullTime",
              jobUrl: "https://jobs.ashbyhq.com/acme/job-1",
              applyUrl: "https://jobs.ashbyhq.com/acme/job-1/application",
              compensation: {
                compensationTierSummary: "$240K - $300K",
                summaryComponents: [
                  { compensationType: "Salary", interval: "1 YEAR", currencyCode: "USD", minValue: 240000, maxValue: 300000 },
                  { compensationType: "EquityPercentage", interval: "NONE", minValue: 0.1, maxValue: 0.3 },
                ],
              },
            },
            { title: "Hidden role", isListed: false, jobUrl: "https://jobs.ashbyhq.com/acme/hidden" },
          ],
        }),
      ),
    );

    const jobs = await ashbyAdapter.listJobs(company({ ats: "ashby" }), capturedAt);
    expect(jobs).toHaveLength(1);
    const job = jobs[0]!;
    expect(job.locationClass).toBe("bay-area");
    expect(job.workplaceType).toBe("onsite");
    expect(job.compensation?.max).toBe(300000);
    expect(job.compensation?.currency).toBe("USD");
    expect(job.employmentType).toBe("fulltime");
  });
});

describe("fetchJson", () => {
  it("refuses non-HTTPS urls", async () => {
    await expect(fetchJson("http://example.com/jobs")).rejects.toThrow(/insecure_url|non-HTTPS/);
  });

  it("surfaces a 404 as not_found without retrying", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}, 404));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchJson("https://example.com/jobs")).rejects.toThrow(/board not found/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("retries retryable server errors", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, 503))
      .mockResolvedValueOnce(jsonResponse({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(fetchJson<{ ok: boolean }>("https://example.com/jobs", { retries: 1 })).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("hostedApplyUrl", () => {
  it("keeps a Greenhouse-hosted posting url unchanged", () => {
    const url = "https://job-boards.greenhouse.io/sigmacomputing/jobs/7774460003";
    expect(hostedApplyUrl("sigmacomputing", "7774460003", url)).toBe(url);
  });

  it("rewrites a company careers-site url to the hosted application form", () => {
    expect(hostedApplyUrl("roblox", "8092905", "https://careers.roblox.com/jobs/8092905?gh_jid=8092905")).toBe(
      "https://job-boards.greenhouse.io/embed/job_app?for=roblox&token=8092905",
    );
    expect(hostedApplyUrl("pinterest", "7305880", "https://www.pinterestcareers.com/jobs/?gh_jid=7305880")).toBe(
      "https://job-boards.greenhouse.io/embed/job_app?for=pinterest&token=7305880",
    );
  });

  it("falls back to the original url when the posting id is unknown", () => {
    expect(hostedApplyUrl("block", "", "http://block.xyz/careers/jobs/5281196008")).toBe(
      "http://block.xyz/careers/jobs/5281196008",
    );
  });

  it("rewrites rather than trusting an unparseable url", () => {
    expect(hostedApplyUrl("asana", "8084470", "not-a-url")).toBe(
      "https://job-boards.greenhouse.io/embed/job_app?for=asana&token=8084470",
    );
  });
});