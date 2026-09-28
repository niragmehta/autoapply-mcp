import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanySchema } from "../src/domain/campaign.js";
import { ashbyAdapter } from "../src/sources/ashby.js";
import { ashbyStructuredPay } from "../src/sources/ashbyCompensation.js";
import { openDatabase } from "../src/db/database.js";
import { listQueue, saveEvaluation, upsertJobs } from "../src/db/repositories/jobs.js";
import { evaluateGates } from "../src/ranking/gates.js";
import { logger } from "../src/util/logger.js";
import { makeCampaign, makeJob, makeProfile } from "./factories.js";

const company = CompanySchema.parse({ name: "Acme", ats: "ashby", board: "acme" });
const cadSalary = { compensationType: "Salary", interval: "1 YEAR", currencyCode: "CAD", minValue: 260000, maxValue: 310000 };
const usdSalary = { ...cadSalary, currencyCode: "USD", minValue: 215000, maxValue: 260000 };
const canada = { title: "Canada", tierSummary: "CA$260K - CA$310K", components: [cadSalary] };
const california = {
  title: "USA - California, New York and Washington",
  tierSummary: "$215K - $260K",
  components: [usdSalary],
};

beforeEach(() => {
  process.env.AUTOAPPLY_MIN_INTERVAL_MS = "0";
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function posting(locations: string[], tiers: unknown, summary: unknown = cadSalary) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    jobs: [{
      id: "security",
      title: "Senior Security Engineer",
      location: locations[0],
      secondaryLocations: locations.slice(1).map((location) => ({ location })),
      descriptionPlain: "Build application security tooling.",
      jobUrl: "https://jobs.ashbyhq.com/acme/security",
      compensation: {
        compensationTierSummary: "Default salary",
        summaryComponents: [summary],
        compensationTiers: tiers,
      },
    }],
  }), { headers: { "content-type": "application/json" } })));
  return (await ashbyAdapter.listJobs(company, "2026-09-13T00:00:00Z"))[0]!;
}

describe("Ashby location-specific compensation", () => {
  it("uses the California tier for a Bay Area posting even when Canada's summary comes first", async () => {
    const job = await posting(["Toronto", "San Francisco", "New York"], [
      canada, california,
      { title: "USA - All Other States", components: [{ ...usdSalary, maxValue: 220000 }] },
    ]);
    expect(job.locationClass).toBe("bay-area");
    expect(job.compensation).toMatchObject({ min: 215000, max: 260000, currency: "USD", period: "year" });
    expect(job.compensation?.raw).toContain("USA - California, New York and Washington");
  });

  it("does not attach the California pay band to a Canada-only posting", async () => {
    const job = await posting(["Toronto"], [california, canada], usdSalary);
    expect(job.compensation).toMatchObject({ currency: "CAD", max: 310000 });
  });

  it("matches an explicit New York location without selecting another listed office's tier", async () => {
    const job = await posting(["New York"], [canada, california]);
    expect(job.compensation).toMatchObject({ currency: "USD", max: 260000 });
  });

  it("matches an explicitly countrywide tier for a remote US role", async () => {
    const job = await posting(["Remote - US"], [canada, { title: "United States", components: [usdSalary] }]);
    expect(job.compensation).toMatchObject({ currency: "USD", max: 260000 });
  });

  it("prefers a unique regional tier over a countrywide tier", async () => {
    const job = await posting(["San Francisco"], [
      { title: "United States", components: [{ ...usdSalary, maxValue: 220000 }] }, california,
    ]);
    expect(job.compensation?.max).toBe(260000);
  });

  it.each([
    "USA - All Other States", "USA except California", "Outside San Francisco",
    "Non-California", "USA excludes California", "All states but California",
  ])(
    "does not mistake the exclusion tier '%s' for Bay Area pay", async (title) => {
      const job = await posting(["San Francisco"], [{ title, components: [usdSalary] }]);
      expect(job.compensation).toMatchObject({ currency: "CAD", max: 310000 });
    },
  );

  it("does not guess which of two matching regional seniority tiers applies", async () => {
    const job = await posting(["San Francisco"], [
      { ...california, title: "California - Senior" },
      { ...california, title: "California - Staff", components: [{ ...usdSalary, maxValue: 400000 }] },
    ]);
    expect(job.compensation).toMatchObject({ currency: "CAD", max: 310000 });
  });

  it("does not confuse London Ontario with a UK salary tier", async () => {
    const job = await posting(["London, Ontario, Canada"], [
      canada, { title: "London, United Kingdom", components: [{ ...usdSalary, currencyCode: "GBP" }] },
    ]);
    expect(job.compensation?.currency).toBe("CAD");
  });

  it("does not infer Washington state pay for Washington DC", async () => {
    const job = await posting(["Washington, DC, USA"], [california]);
    expect(job.compensation).toMatchObject({ currency: "CAD", max: 310000 });
  });

  it("does not treat a country signal as proof of a California region match", async () => {
    const job = await posting(["Boston, USA"], [
      california, { title: "United States", components: [{ ...usdSalary, maxValue: 220000 }] },
    ]);
    expect(job.compensation).toMatchObject({ currency: "USD", max: 220000 });
  });

  it.each([undefined, [], { invalid: true }, [null], [{ title: "Staff", components: [usdSalary] }]])(
    "preserves the published summary when geographic tiers cannot be resolved: %j", async (tiers) => {
      const job = await posting(["San Francisco"], tiers);
      expect(job.compensation).toMatchObject({ currency: "CAD", max: 310000 });
    },
  );

  describe("untitled tiers, which Ashby sends as title: null on most postings", () => {
    const equity = { compensationType: "EquityCashValue", interval: "1 YEAR", currencyCode: "USD", minValue: null, maxValue: null };
    const untitled = (salary: unknown) => ({
      id: "tier", title: null, tierSummary: "$257K – $335K • Offers Equity", additionalInformation: null,
      components: [salary, equity],
    });

    it("reads a posting's only, untitled tier without reporting the tiers invalid", async () => {
      const warn = vi.spyOn(logger, "warn");
      const band = { ...usdSalary, minValue: 257000, maxValue: 335000 };
      const job = await posting(["San Francisco"], [untitled(band)], band);
      expect(job.compensation).toMatchObject({ min: 257000, max: 335000, currency: "USD", period: "year" });
      expect(warn.mock.calls.map(([message]) => message)).not.toEqual(
        expect.arrayContaining([expect.stringMatching(/invalid Ashby compensation tiers|geographic compensation unresolved/)]),
      );
    });

    it("still matches a titled regional tier when another tier is untitled", async () => {
      const job = await posting(["San Francisco"], [untitled(cadSalary), california]);
      expect(job.compensation).toMatchObject({ currency: "USD", max: 260000 });
    });

    it("accepts a tier whose summary is null", async () => {
      const job = await posting(["San Francisco"], [canada, { ...california, tierSummary: null }]);
      expect(job.compensation).toMatchObject({ currency: "USD", max: 260000 });
      expect(job.compensation?.raw).toContain("USA - California, New York and Washington");
    });
  });

  it("keeps an unsupported interval unknown instead of manufacturing annual pay", async () => {
    const job = await posting(["San Francisco"], [{
      ...california, components: [{ ...usdSalary, interval: "1 FORTNIGHT" }],
    }]);
    expect(job.compensation?.period).toBe("unknown");
  });

  it("retains the summary when the matched tier has equity but no salary", async () => {
    const job = await posting(["San Francisco"], [{
      ...california, components: [{ compensationType: "EquityPercentage", minValue: 0.1, maxValue: 0.2 }],
    }]);
    expect(job.compensation).toMatchObject({ currency: "CAD", max: 310000 });
  });

  it.each([null, { compensationType: "Bonus" }, { compensationType: "Salary" }])(
    "does not invent a range from an unusable salary component: %j", async (component) => {
      expect((await posting(["San Francisco"], undefined, component)).compensation).toBeNull();
    },
  );

  it("preserves monthly, min-only summary components", async () => {
    const job = await posting(["Toronto"], undefined, {
      compensationType: "Salary", interval: "1 MONTH", currencyCode: "", minValue: 20000,
    });
    expect(job.compensation).toMatchObject({ min: 20000, max: null, currency: "USD", period: "month" });
  });

  it("handles missing compensation without inventing pay", () => {
    expect(ashbyStructuredPay(undefined, [], {})).toBeNull();
    expect(ashbyStructuredPay({}, [], {})).toBeNull();
  });

  it("persists California pay so normal gates and the USD250k queue filter use the correct tier", async () => {
    const imported = await posting(["Toronto", "San Francisco"], [canada, california]);
    const job = makeJob({ compensation: imported.compensation, locationClass: imported.locationClass, country: imported.country });
    const gate = evaluateGates(job, { campaign: makeCampaign(), profile: makeProfile() });
    expect(gate.passed).toBe(true);
    const db = openDatabase(":memory:");
    try {
      upsertJobs(db, [job]);
      saveEvaluation(db, {
        jobId: job.id, decision: "accept", gate, trackId: "ai-security", score: 90, tier: "A",
        components: [], flags: [], evaluatedAt: new Date().toISOString(),
      });
      expect(listQueue(db, { minCompensation: 250000, tiers: ["A", "B"], locationClasses: ["bay-area"] }))
        .toHaveLength(1);
    } finally {
      db.close();
    }
  });
});
