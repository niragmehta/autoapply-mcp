import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApplicationSchema, EvaluationSchema, JobSchema } from "../src/domain/job.js";
import { CampaignSchema, CompanySchema, SubmissionPolicySchema } from "../src/domain/campaign.js";
import { ProfileSchema } from "../src/domain/profile.js";
import { adapterFor, allAdapters, discoverJobs, resolveBoards } from "../src/sources/registry.js";
import { isSameAllowedSite } from "../src/submission/allowlist.js";
import { AppError, isAppError, toErrorMessage } from "../src/util/errors.js";
import { daysBetween, newId, parseDateSafe, shortHash } from "../src/util/hash.js";
import { makeCampaign, makeJob, makeProfile } from "./factories.js";

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

beforeEach(() => {
  process.env.AUTOAPPLY_MIN_INTERVAL_MS = "0";
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("domain schemas", () => {
  it("validates a normalized job", () => {
    expect(() => JobSchema.parse(makeJob())).not.toThrow();
  });

  it("applies documented defaults", () => {
    const campaign = makeCampaign();
    expect(campaign.scoring.weights.roleAlignment).toBe(25);
    expect(campaign.submission.mode).toBe("manual");
    expect(campaign.submission.blockedQuestionCategories).toContain("work-authorization");
    expect(CompanySchema.parse({ name: "A", ats: "lever", board: "a" }).tier).toBe("B");
  });

  it("rejects malformed configuration", () => {
    expect(ProfileSchema.safeParse({ version: 1 }).success).toBe(false);
    expect(CampaignSchema.safeParse({ version: 1, name: "x" }).success).toBe(false);
    expect(CompanySchema.safeParse({ name: "A", ats: "taleo", board: "a" }).success).toBe(false);
  });

  it("requires at least one resume variant", () => {
    const profile = makeProfile();
    expect(ProfileSchema.safeParse({ ...profile, resumes: [] }).success).toBe(false);
  });

  it("validates evaluation and application records", () => {
    const evaluation = EvaluationSchema.parse({
      jobId: "job_1",
      decision: "accept",
      gate: { passed: true, rule: null, reason: "ok" },
      trackId: "t",
      score: 90,
      tier: "A",
      evaluatedAt: new Date().toISOString(),
    });
    expect(evaluation.components).toEqual([]);

    const application = ApplicationSchema.parse({
      id: "app_1",
      jobId: "job_1",
      status: "drafted",
      resumeId: "r",
      resumePath: "p",
      packetHash: "h",
      createdAt: new Date().toISOString(),
    });
    expect(application.answers).toEqual([]);
    expect(application.submittedAt).toBeNull();
  });
});

describe("source registry", () => {
  it("resolves an adapter per ATS", () => {
    expect(adapterFor("greenhouse").kind).toBe("greenhouse");
    expect(adapterFor("lever").kind).toBe("lever");
    expect(adapterFor("ashby").kind).toBe("ashby");
    expect(adapterFor("workday").kind).toBe("workday");
    expect(allAdapters()).toHaveLength(4);
  });

  it("throws for an unknown ATS", () => {
    expect(() => adapterFor("taleo" as never)).toThrow(/no adapter registered/);
  });

  it("builds board and list urls", () => {
    const company = CompanySchema.parse({ name: "Acme", ats: "lever", board: "acme", region: "eu" });
    expect(adapterFor("lever").listUrl(company)).toContain("api.eu.lever.co");
    expect(adapterFor("lever").boardUrl(company)).toContain("jobs.eu.lever.co");
  });

  it("keeps going when one board fails and reports the issue", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const href = typeof url === "string" ? url : url.toString();
        if (href.includes("broken")) return jsonResponse({}, 404);
        return jsonResponse({ jobs: [] });
      }),
    );

    const result = await discoverJobs([
      CompanySchema.parse({ name: "Good", ats: "greenhouse", board: "good" }),
      CompanySchema.parse({ name: "Broken", ats: "greenhouse", board: "broken" }),
      CompanySchema.parse({ name: "Inactive", ats: "greenhouse", board: "inactive", active: false }),
    ]);

    expect(result.boardsQueried).toBe(2);
    expect(result.issues).toHaveLength(1);
    expect(result.issues[0]?.code).toBe("not_found");
    expect(result.issues[0]?.company).toBe("Broken");
  });

  it("reports verified board slugs when probing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL) => {
        const href = typeof url === "string" ? url : url.toString();
        const hit = href.includes("boards-api.greenhouse.io") && href.includes("acmecorp");
        return hit ? jsonResponse({ jobs: [] }) : jsonResponse({}, 404);
      }),
    );

    const matches = await resolveBoards("Acme Corp");
    expect(matches.length).toBeGreaterThan(0);
    expect(matches.every((match) => match.ok)).toBe(true);
    expect(matches[0]?.ats).toBe("greenhouse");
    expect(matches[0]?.board).toBe("acmecorp");
  });
});

describe("allowlist helpers", () => {
  it("requires both ends of a navigation to be allowlisted", () => {
    const policy = makeCampaign().submission;
    expect(isSameAllowedSite("https://jobs.lever.co/a", "https://jobs.lever.co/a/apply", policy)).toBe(true);
    expect(isSameAllowedSite("https://jobs.lever.co/a", "https://evil.example.com", policy)).toBe(false);
  });
});

describe("utilities", () => {
  it("formats structured errors", () => {
    const error = new AppError("test_code", "something failed", { detail: 1 });
    expect(isAppError(error)).toBe(true);
    expect(toErrorMessage(error)).toBe("[test_code] something failed");
    expect(toErrorMessage(new Error("plain"))).toBe("plain");
    expect(toErrorMessage("raw string")).toBe("raw string");
  });

  it("hashes deterministically and generates prefixed ids", () => {
    expect(shortHash("abc")).toBe(shortHash("abc"));
    expect(shortHash("abc", 8)).toHaveLength(8);
    expect(newId("app")).toMatch(/^app_[a-f0-9]{20}$/);
  });

  it("parses dates safely and measures spans", () => {
    expect(parseDateSafe(null)).toBeNull();
    expect(parseDateSafe("not-a-date")).toBeNull();
    expect(parseDateSafe("2026-01-01T00:00:00Z")).toBeInstanceOf(Date);
    expect(daysBetween(new Date("2026-01-01"), new Date("2026-01-11"))).toBe(10);
  });
});

describe("submission.maxBatchSize", () => {
  it("defaults to 3 so a batch stays reviewable", () => {
    expect(SubmissionPolicySchema.parse({}).maxBatchSize).toBe(3);
    expect(makeCampaign().submission.maxBatchSize).toBe(3);
  });

  it("acts as a hard ceiling over a larger requested limit", () => {
    const { maxBatchSize } = SubmissionPolicySchema.parse({});
    expect(Math.min(120, maxBatchSize)).toBe(3);
    expect(Math.min(2, maxBatchSize)).toBe(2);
  });

  it("is configurable upward when a campaign asks for it", () => {
    expect(SubmissionPolicySchema.parse({ maxBatchSize: 10 }).maxBatchSize).toBe(10);
  });

  it("rejects a non-positive cap", () => {
    expect(() => SubmissionPolicySchema.parse({ maxBatchSize: 0 })).toThrow();
  });
});