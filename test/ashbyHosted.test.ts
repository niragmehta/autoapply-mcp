import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanySchema } from "../src/domain/campaign.js";
import { ashbyAdapter } from "../src/sources/ashby.js";
import { evaluateGates } from "../src/ranking/gates.js";
import { makeCampaign, makeProfile } from "./factories.js";
import { hostedBoard, hostedDetail, hostedHtml, hostedMetadata, hostedPosting } from "./fixtures/ashbyHosted.js";

const company = CompanySchema.parse({ name: "Acme", ats: "ashby", board: "acme" });
const capturedAt = "2026-09-13T18:00:00Z";

function mockBoard(board = hostedHtml(hostedBoard()), detail = hostedDetail(), apiStatus = 404) {
  const fetch = vi.fn(async (raw: string | URL) => {
    const url = new URL(raw);
    if (url.hostname === "api.ashbyhq.com") return new Response("{}", { status: apiStatus });
    return new Response(url.pathname === "/acme" ? board : detail);
  });
  vi.stubGlobal("fetch", fetch);
  return fetch;
}

beforeEach(() => vi.stubEnv("AUTOAPPLY_MIN_INTERVAL_MS", "0"));
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("Ashby public hosted-page fallback", () => {
  it("normalizes a real public posting when the listing API returns 404", async () => {
    const fetch = mockBoard();
    const [job] = await ashbyAdapter.listJobs(company, capturedAt);
    expect(job).toMatchObject({
      externalId: "role-1", companyName: "Acme", ats: "ashby",
      locationClass: "bay-area", country: "US", workplaceType: "remote",
      locationsRaw: ["San Francisco, CA", "New York, NY"], postedAt: "2026-08-18",
      descriptionText: "Build AI security guardrails and policy systems in Python with threat modeling.",
      applyUrl: "https://jobs.ashbyhq.com/acme/role-1/application",
      compensation: { min: 240000, max: 300000, currency: "USD", period: "year", source: "ats-structured" },
    });
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(fetch.mock.calls.every(([url]) => ["api.ashbyhq.com", "jobs.ashbyhq.com"].includes(new URL(url).hostname))).toBe(true);
  });

  it("retains the API path when it succeeds", async () => {
    const fetch = mockBoard("", "", 200);
    expect(await ashbyAdapter.listJobs(company, capturedAt)).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([401, 403])("does not bypass an API access denial (%s)", async (status) => {
    const fetch = mockBoard("", "", status);
    await expect(ashbyAdapter.listJobs(company, capturedAt)).rejects.toThrow(`HTTP ${status}`);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["generic page", "<html>No jobs</html>"],
    ["invalid JSON", '<script>window.__appData = {not: "json"};\n</script>'],
    ["different employer", hostedHtml(hostedBoard({ organization: { hostedJobsPageSlug: "other" } }))],
    ["missing board", hostedHtml({ organization: { hostedJobsPageSlug: "acme" } })],
    ["unsafe posting ID", hostedHtml(hostedBoard({ jobBoard: { jobPostings: [{ id: "../other", title: "Role" }] } }))],
    ["oversized board", hostedHtml(hostedBoard({ jobBoard: { jobPostings: Array.from({ length: 501 }, (_, i) => ({ id: `id-${i}`, title: "Role" })) } }))],
  ])("rejects %s rather than reporting a verified board", async (_name, html) => {
    mockBoard(html);
    await expect(ashbyAdapter.listJobs(company, capturedAt)).rejects.toThrow(/Ashby/);
  });

  it("returns an actually empty public board without fetching details", async () => {
    const fetch = mockBoard(hostedHtml(hostedBoard({ jobBoard: { jobPostings: [] } })));
    expect(await ashbyAdapter.listJobs(company, capturedAt)).toEqual([]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["unlisted", { isListed: false }],
    ["confidential", { isConfidential: true }],
  ])("does not ingest %s detail pages", async (_name, overrides) => {
    mockBoard(undefined, hostedDetail(hostedPosting(overrides)));
    expect(await ashbyAdapter.listJobs(company, capturedAt)).toEqual([]);
  });

  it.each([
    ["mismatched detail ID", hostedDetail(hostedPosting({ id: "role-2" }))],
    ["mismatched metadata ID", hostedDetail(undefined, hostedMetadata({ identifier: { value: "role-2" } }))],
    ["missing metadata", hostedHtml({ organization: { hostedJobsPageSlug: "acme" }, posting: hostedPosting() })],
    ["invalid date", hostedDetail(undefined, hostedMetadata({ datePosted: "yesterday" }))],
    ["invalid currency", hostedDetail(undefined, hostedMetadata({ baseSalary: { currency: "$", value: { minValue: 240000, maxValue: 300000, unitText: "YEAR" } } }))],
  ])("fails explicitly for %s", async (_name, detail) => {
    mockBoard(undefined, detail);
    await expect(ashbyAdapter.listJobs(company, capturedAt)).rejects.toThrow(/Ashby/);
  });

  it("holds published pay with missing currency/units rather than treating it as unpublished", async () => {
    mockBoard(undefined, hostedDetail(undefined, hostedMetadata({ baseSalary: undefined })));
    const [job] = await ashbyAdapter.listJobs(company, capturedAt);
    expect(job?.compensation).toMatchObject({
      min: null, max: null, currency: "XXX", period: "unknown", raw: "$240K - $300K",
    });
    expect(evaluateGates({ ...job!, postedAt: new Date().toISOString() }, {
      campaign: makeCampaign(), profile: makeProfile(),
    }).rule).toBe("compensation-period-unknown");
  });

  it("retains missing dates and unpublished compensation without manufacturing freshness", async () => {
    mockBoard(undefined, hostedDetail(
      hostedPosting({ compensationTierSummary: null }),
      hostedMetadata({ datePosted: undefined, baseSalary: undefined }),
    ));
    expect((await ashbyAdapter.listJobs(company, capturedAt))[0]).toMatchObject({ postedAt: null, compensation: null });
  });

  it.each([["MONTH", "month"], ["HOUR", "hour"], ["FORTNIGHT", "unknown"]])(
    "preserves the published %s pay unit as %s", async (unitText, period) => {
      mockBoard(undefined, hostedDetail(undefined, hostedMetadata({
        baseSalary: { currency: "CAD", value: { minValue: 100, maxValue: 200, unitText } },
      })));
      expect((await ashbyAdapter.listJobs(company, capturedAt))[0]?.compensation).toMatchObject({ period, currency: "CAD", max: 200 });
    },
  );

  it("deduplicates repeated public listing IDs before fetching each detail", async () => {
    const listing = { id: "role-1", title: "Senior Security Engineer" };
    const fetch = mockBoard(hostedHtml(hostedBoard({ jobBoard: { jobPostings: [listing, listing] } })));
    expect(await ashbyAdapter.listJobs(company, capturedAt)).toHaveLength(1);
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
