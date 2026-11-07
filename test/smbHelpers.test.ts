import { afterEach, describe, expect, it, vi } from "vitest";
import { adapterFor } from "../src/sources/registry.js";
import { SMB_ADAPTERS, SMB_CATALOG } from "../src/sources/batches/smb.js";
import { companyFromJob, postingId, segmentBoard, tenantBoard } from "../src/sources/smb/board.js";
import { checkFromError, listingCheck, safeCheck } from "../src/sources/smb/checks.js";
import { absoluteDate, earliestDate } from "../src/sources/smb/dates.js";
import { withDetails } from "../src/sources/smb/details.js";
import { countryCode, publishedCountry } from "../src/sources/smb/geo.js";
import { isExpired, readJobPostingLd } from "../src/sources/smb/jsonLd.js";
import { payPeriod, structuredPay, textPay } from "../src/sources/smb/pay.js";
import { isWildcardQuery, matchesQuery } from "../src/sources/smb/query.js";
import { AppError } from "../src/util/errors.js";
import { JobSchema } from "../src/domain/job.js";

afterEach(() => vi.unstubAllEnvs());

describe("SMB batch registration", () => {
  it("registers all twelve adapters under their own kinds with matching catalog entries", () => {
    const kinds = ["bamboohr", "jazzhr", "breezy", "rippling", "gem", "pinpoint", "dover", "teamtailor", "personio", "hibob", "zohorecruit", "clearcompany"];
    expect(Object.keys(SMB_ADAPTERS).sort()).toEqual([...kinds].sort());
    for (const kind of kinds) {
      expect(adapterFor(kind as never).kind).toBe(kind);
    }
    expect(SMB_CATALOG.map((entry) => entry.id).sort()).toEqual([...kinds].sort());
    for (const entry of SMB_CATALOG) {
      expect(entry).toMatchObject({ kind: "ats", integration: "discovery-only", access: "public", readiness: "ready", submission: "manual-only" });
      expect(entry.limitations.join(" ")).toMatch(/Board is/);
      expect(entry.limitations.join(" ")).toMatch(/browser support.*domains and company permission/);
    }
  });
});

describe("SMB board helpers", () => {
  const format = { ats: "Example ATS", shape: "the tenant", example: "acme" };

  it("validates tenant labels and path segments with an example", () => {
    expect(tenantBoard(" Acme-Co ", format)).toBe("acme-co");
    expect(segmentBoard("Acme_Co", format)).toBe("Acme_Co");
    for (const bad of ["https://acme.example.com", "acme.example", "-acme", "acme/jobs", ""]) {
      expect(() => tenantBoard(bad, format)).toThrow(expect.objectContaining({ code: "invalid_board", details: expect.objectContaining({ example: "acme" }) }));
    }
    expect(() => segmentBoard("a/b", format)).toThrow(/e\.g\. "acme"/);
    expect(() => postingId("../1", "Example")).toThrow(expect.objectContaining({ code: "invalid_posting_id" }));
  });

  it("rebuilds a company from a stored job", () => {
    const job = JobSchema.parse({
      id: "j", fingerprint: "f", ats: "gem", companyName: "Example Co", companyTier: "A", board: "acme", externalId: "1",
      title: "Engineer", locationClass: "unknown", url: "", applyUrl: "", capturedAt: "2026-11-06T00:00:00Z",
    });
    expect(companyFromJob(job)).toEqual({
      name: "Example Co", ats: "gem", board: "acme", tier: "A", tags: [], active: true, region: "global", query: "",
    });
  });
});

describe("SMB field helpers", () => {
  it("normalizes published dates to absolute UTC instants", () => {
    expect(absoluteDate("2026-08-06T00:00:00")).toBe("2026-08-06T00:00:00.000Z");
    expect(absoluteDate("2026-08-24T09:38:14.937000-07:00")).toBe("2026-08-24T16:38:14.937Z");
    expect(absoluteDate("2026-08-31")).toBe("2026-08-31T00:00:00.000Z");
    expect(absoluteDate("Thu, 01 Oct 2026 10:01:45 +0200")).toBe("2026-10-01T08:01:45.000Z");
    expect(absoluteDate(1793972275)).toBe("2026-11-06T13:37:55.000Z");
    expect(absoluteDate(1793972275000)).toBe("2026-11-06T13:37:55.000Z");
    for (const bad of ["yesterday", "", "30+ Days Ago", null, undefined, 0, "2026-13-45"]) expect(absoluteDate(bad)).toBeNull();
    expect(earliestDate("2026-07-17T00:00:00.000Z", null, "2026-11-05T20:16:02.931Z")).toBe("2026-07-17T00:00:00.000Z");
    expect(earliestDate(null, undefined)).toBeNull();
  });

  it("keeps published pay units and never assumes one", () => {
    expect(payPeriod("YEARLY")).toBe("year");
    expect(payPeriod("Per Year")).toBe("year");
    expect(payPeriod("per_hour")).toBe("hour");
    expect(payPeriod("monthly")).toBe("month");
    expect(payPeriod("biweekly")).toBe("unknown");
    expect(textPay("$80,000 – $102,000 / year")).toMatchObject({ min: 80000, max: 102000, currency: "USD", period: "year", source: "ats-structured" });
    expect(textPay("$50-$75 /hour")).toMatchObject({ min: 50, max: 75, period: "hour" });
    expect(textPay("$80,000 – $102,000")).toMatchObject({ period: "unknown" });
    expect(textPay("$40-$50 hourly or $90k-$100k annually")?.period).toBe("unknown");
    expect(textPay("Competitive")).toBeNull();
    expect(textPay(null)).toBeNull();
    expect(structuredPay(0, null, "USD", "year", "raw")).toBeNull();
    expect(structuredPay(100, 90, "USD", "year", "raw")).toBeNull();
    expect(structuredPay(100, 200, "dollars", "year", "raw")).toBeNull();
    expect(structuredPay("120000.00", "140000.00", "cad", "year", "raw")).toMatchObject({ min: 120000, max: 140000, currency: "CAD" });
  });

  it("publishes a country only when every value agrees on the US or Canada", () => {
    expect(countryCode("United States of America")).toBe("US");
    expect(countryCode("ca")).toBe("CA");
    expect(countryCode("es")).toBe("ES");
    expect(countryCode("Spain")).toBeNull();
    expect(publishedCountry(["US", "United States", null])).toBe("US");
    expect(publishedCountry(["Canada"])).toBe("CA");
    expect(publishedCountry(["US", "Canada"])).toBeUndefined();
    expect(publishedCountry(["Spain"])).toBeUndefined();
  });

  it("matches every query term at a word start", () => {
    expect(matchesQuery("security engineer", "Senior Security Engineering Lead")).toBe(true);
    expect(matchesQuery("net", "Kubernetes Platform")).toBe(false);
    expect(matchesQuery("C++, platform", "C++ Platform Developer")).toBe(true);
    expect(matchesQuery("data", "Analytics", null, "Data Platform")).toBe(true);
    expect(matchesQuery("*", "anything")).toBe(true);
    expect(isWildcardQuery(" * ")).toBe(true);
    expect(isWildcardQuery("rust")).toBe(false);
  });
});

describe("SMB liveness helpers", () => {
  it("closes only on gone responses and keeps everything else unknown", async () => {
    expect(checkFromError(new AppError("not_found", "x")).status).toBe("closed");
    expect(checkFromError(new AppError("http_error", "x", { status: 410 })).status).toBe("closed");
    expect(checkFromError(new AppError("http_error", "x", { status: 403 })).status).toBe("unknown");
    expect(checkFromError(new AppError("network_error", "x")).status).toBe("unknown");
    expect(checkFromError(new AppError("retryable_http", "x", { status: 503 })).status).toBe("unknown");
    expect(checkFromError(new TypeError("fetch failed"), "page")).toMatchObject({ status: "unknown", via: "page" });
    expect(await safeCheck(async () => { throw new AppError("network_error", "offline"); })).toMatchObject({ status: "unknown" });
    expect(listingCheck(false, "Example").status).toBe("closed");
  });

  it("reads details within the limit and keeps failed or excess items", async () => {
    vi.stubEnv("AUTOAPPLY_SMB_DETAIL_LIMIT", "2");
    const read = vi.fn(async (item: number) => {
      if (item === 2) throw new Error("boom");
      return item * 10;
    });
    const results = await withDetails([1, 2, 3], read, { ats: "example", board: "acme" });
    expect(results).toEqual([{ item: 1, detail: 10 }, { item: 2, detail: null }, { item: 3, detail: null }]);
    expect(read).toHaveBeenCalledTimes(2);
  });
});

describe("schema.org JobPosting metadata", () => {
  it("reads graph containers, array types and entity-encoded script types", () => {
    const html = `<script type="application/ld&#x2B;json">{"@graph":[{"@type":"Organization"},{"@type":["JobPosting"],
      "title":"Engineer","datePosted":"2026-10-07","validThrough":"2026-01-01","employmentType":["FULL_TIME","CONTRACTOR"],
      "jobLocation":[{"address":{"addressLocality":"Austin","addressRegion":"TX","addressCountry":{"name":"US"}}}],
      "jobLocationType":"TELECOMMUTE","applicantLocationRequirements":[{"name":"US"}],
      "baseSalary":{"currency":"USD","value":{"value":95,"unitText":"HOUR"}},"identifier":{"value":"7"}}]}</script>
      <script type="application/ld+json">{broken</script>`;
    const posting = readJobPostingLd(html);
    expect(posting).toMatchObject({
      title: "Engineer", datePosted: "2026-10-07T00:00:00.000Z", employmentType: "FULL_TIME, CONTRACTOR",
      places: [{ city: "Austin", region: "TX", country: "US" }], remote: true, applicantCountries: ["US"], identifier: "7",
      pay: { min: 95, max: 95, currency: "USD", period: "hour" },
    });
    expect(isExpired(posting!, new Date("2026-11-06T00:00:00Z"))).toBe(true);
    expect(readJobPostingLd("<html>no metadata</html>")).toBeNull();
  });
});
