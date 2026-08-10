import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { z } from "zod";
import { findStrayKeys, locateInSchema } from "../src/config/strayKeys.js";
import { CampaignSchema, CompanyListSchema } from "../src/domain/campaign.js";
import { ProfileSchema } from "../src/domain/profile.js";

function readExample(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
}

describe("findStrayKeys", () => {
  const schema = z.object({
    name: z.string(),
    submission: z.object({ mode: z.string(), maxBatchSize: z.number().default(3) }).default({ mode: "manual" }),
    tracks: z.array(z.object({ id: z.string() })).default([]),
  });

  it("reports nothing when every key is defined", () => {
    expect(findStrayKeys(schema, { name: "a", submission: { mode: "manual" } })).toEqual([]);
  });

  it("catches a setting written one level too high", () => {
    // The real case: campaign.json carried maxBatchSize at the top level, zod
    // stripped it without a word, and the campaign ran on the schema default.
    expect(findStrayKeys(schema, { name: "a", maxBatchSize: 10 })).toEqual(["maxBatchSize"]);
  });

  it("reports nested and array members by dotted path", () => {
    const strays = findStrayKeys(schema, {
      name: "a",
      submission: { mode: "manual", dailyLimit: 5 },
      tracks: [{ id: "x" }, { id: "y", weight: 2 }],
    });

    expect(strays).toEqual(["submission.dailyLimit", "tracks[1].weight"]);
  });

  it("does not walk into values the schema leaves free-form", () => {
    const loose = z.object({ meta: z.record(z.string(), z.unknown()).default({}) });
    expect(findStrayKeys(loose, { meta: { anything: 1, else: 2 } })).toEqual([]);
  });

  it("survives a non-object document", () => {
    expect(findStrayKeys(schema, "not an object")).toEqual([]);
    expect(findStrayKeys(schema, null)).toEqual([]);
  });
});

describe("locateInSchema", () => {
  it("names where a misplaced key actually belongs", () => {
    expect(locateInSchema(CampaignSchema, "maxBatchSize")).toBe("submission.maxBatchSize");
  });

  it("returns nothing for a key the schema does not define anywhere", () => {
    expect(locateInSchema(CampaignSchema, "notARealSetting")).toBeUndefined();
  });
});

describe("shipped example configuration", () => {
  // These files are what `npm run init` copies into a new home, so a drift
  // between them and the schema hands every new user a broken starting point.
  it("profile.example.json validates against the profile schema", () => {
    const result = ProfileSchema.safeParse(readExample("examples/profile.example.json"));
    expect(result.success ? [] : result.error.issues.map((issue) => issue.path.join("."))).toEqual([]);
  });

  it("campaign.example.json validates against the campaign schema", () => {
    const result = CampaignSchema.safeParse(readExample("examples/campaign.example.json"));
    expect(result.success ? [] : result.error.issues.map((issue) => issue.path.join("."))).toEqual([]);
  });

  it("the company preset validates against the company list schema", () => {
    const result = CompanyListSchema.safeParse(readExample("presets/ai-security-us-canada.json"));
    expect(result.success ? [] : result.error.issues.map((issue) => issue.path.join("."))).toEqual([]);
  });

  it("names every preset company exactly once, in a form a human would write", () => {
    // Company name is an identity, not a label: `upsertCompany` matches on it
    // case-insensitively and the per-company submission cap is keyed by it. Two
    // spellings of one employer therefore become two boards with two ceilings.
    // The preset shipped `Oscilar.com` and `LAGO -` until this test existed.
    const companies = CompanyListSchema.parse(readExample("presets/ai-security-us-canada.json")).companies;
    const names = companies.map((company) => company.name);

    const duplicated = names.filter(
      (name, index) => names.findIndex((other) => other.toLowerCase() === name.toLowerCase()) !== index,
    );
    expect(duplicated).toEqual([]);
    // A trailing separator or a bare domain is a name that was pasted rather
    // than written: `Oscilar.com` and `LAGO -` both shipped that way.
    expect(names.filter((name) => name !== name.trim())).toEqual([]);
    expect(names.filter((name) => /[-.,/]$/.test(name))).toEqual([]);
    expect(names.filter((name) => /\.(com|io|ai|co|dev|net|org)$/i.test(name))).toEqual([]);
  });

  it("points every preset board at an ATS the source layer can fetch", () => {
    const companies = CompanyListSchema.parse(readExample("presets/ai-security-us-canada.json")).companies;

    for (const company of companies) {
      expect(company.board.startsWith("http")).toBe(false);
      // Workday boards are a `tenant/datacenter/site` triple; every other ATS
      // takes a bare slug, so a slash there means someone pasted a URL fragment.
      const expectedSlashes = company.ats === "workday" ? 2 : 0;
      expect({ name: company.name, slashes: company.board.split("/").length - 1 }).toEqual({
        name: company.name,
        slashes: expectedSlashes,
      });
    }
  });

  it("carries no keys the schema would silently discard", () => {
    expect(findStrayKeys(ProfileSchema, readExample("examples/profile.example.json"))).toEqual([]);
    expect(findStrayKeys(CampaignSchema, readExample("examples/campaign.example.json"))).toEqual([]);
  });

  it("binds every example track to a resume the example profile declares", () => {
    const profile = ProfileSchema.parse(readExample("examples/profile.example.json"));
    const campaign = CampaignSchema.parse(readExample("examples/campaign.example.json"));
    const resumeIds = new Set(profile.resumes.map((resume) => resume.id));

    for (const track of campaign.tracks) expect(resumeIds.has(track.resumeId)).toBe(true);
  });

  it("ships with submission disarmed so a fresh install cannot contact an employer", () => {
    const campaign = CampaignSchema.parse(readExample("examples/campaign.example.json"));
    expect(campaign.submission.mode).toBe("manual");
    expect(campaign.submission.allowedCompanies).toEqual([]);
  });
});
