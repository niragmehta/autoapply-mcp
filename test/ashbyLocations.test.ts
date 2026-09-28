import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanySchema } from "../src/domain/campaign.js";
import { ashbyAdapter } from "../src/sources/ashby.js";

const company = CompanySchema.parse({ name: "Acme", ats: "ashby", board: "acme" });
const capturedAt = "2026-09-13T21:00:00Z";

async function readJob(overrides: Record<string, unknown> = {}) {
  vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({
    jobs: [{
      id: "one", title: "Staff Platform Engineer", location: "Remote", isRemote: true,
      workplaceType: "Remote", isListed: true, publishedAt: "2026-09-02T12:00:00Z",
      jobUrl: "https://jobs.ashbyhq.com/acme/one", descriptionPlain: "Build reliable cloud platforms.",
      address: { postalAddress: { addressCountry: "United States" } },
      ...overrides,
    }],
  }))));
  return (await ashbyAdapter.listJobs(company, capturedAt))[0]!;
}

beforeEach(() => vi.stubEnv("AUTOAPPLY_MIN_INTERVAL_MS", "0"));
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

describe("Ashby generic remote locations", () => {
  it.each(["United States", "US", "USA", "U.S.", "United States of America"])(
    "uses the explicit job postal country %s without manufacturing a city or a fresh date", async (country) => {
      const job = await readJob({ address: { postalAddress: { addressCountry: country } } });
      expect(job).toMatchObject({ locationClass: "remote-us", country: "US", workplaceType: "remote", postedAt: "2026-09-02T12:00:00Z" });
      expect(job.locationsRaw).toEqual(["Remote - United States"]);
    },
  );

  it.each(["Canada", "CA", "CAN"])("interprets postal-country %s as Canada, not California", async (country) => {
    expect(await readJob({ address: { postalAddress: { addressCountry: country } } }))
      .toMatchObject({ locationClass: "remote-canada", country: "CA" });
  });

  it("also handles an empty display label for an explicitly remote US job", async () => {
    expect(await readJob({ location: "" })).toMatchObject({ locationClass: "remote-us" });
  });

  it.each(["London, United Kingdom", "Remote - Canada", "Remote - Worldwide", "Anywhere"])(
    "does not overwrite explicit display geography %s with a conflicting US postal country", async (location) => {
      const job = await readJob({ location });
      expect(job.locationsRaw).toEqual([location]);
      expect(job.country).not.toBe("US");
    },
  );

  it.each([undefined, null, {}, { postalAddress: { addressCountry: 123 } }, { postalAddress: { addressCountry: "USD" } }])(
    "does not invent US eligibility from absent, malformed or non-country metadata", async (address) => {
      expect(await readJob({ address })).toMatchObject({ locationClass: "remote-global", country: "unknown" });
    },
  );

  it("does not treat an explicit non-US/Canada country as US eligibility", async () => {
    expect(await readJob({ address: { postalAddress: { addressCountry: "Germany" } } }))
      .toMatchObject({ locationClass: "remote-global", country: "unknown" });
  });

  it("does not turn a non-remote job into remote employment based on its country", async () => {
    expect((await readJob({ location: "Remote", isRemote: false, workplaceType: "Onsite" })).locationsRaw).toEqual(["Remote"]);
  });

  it("uses each secondary location's own country rather than copying the primary country", async () => {
    const job = await readJob({
      location: "London, United Kingdom", address: { postalAddress: { addressCountry: "United Kingdom" } },
      secondaryLocations: [{ location: "Remote", address: { postalAddress: { addressCountry: "US" } } }],
    });
    expect(job.locationsRaw).toEqual(["London, United Kingdom", "Remote - United States"]);
    expect(job).toMatchObject({ locationClass: "remote-us", country: "US" });
  });

  it("retains location deduplication and leaves unidentified secondary locations unidentified", async () => {
    const job = await readJob({ secondaryLocations: [
      { location: "Remote" },
      { location: "Remote", address: { postalAddress: { addressCountry: "US" } } },
    ] });
    expect(job.locationsRaw).toEqual(["Remote - United States", "Remote"]);
  });
});
