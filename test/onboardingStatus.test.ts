import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { WorkspacePaths } from "../src/config/paths.js";
import { maskEmail, maskPhone, presence } from "../src/onboarding/mask.js";
import { findPlaceholders, placeholderMarker } from "../src/onboarding/placeholders.js";
import { profileStatus, readProfileStatus } from "../src/onboarding/profileStatus.js";
import type { ResumeCheck } from "../src/submission/resume.js";
import { makeCampaign, makeProfile } from "./factories.js";

/** Fictional data only. */

const validResume = (path: string): ResumeCheck => ({
  ok: true,
  path,
  exists: true,
  sizeBytes: 2048,
  format: "pdf",
  reason: "resume file is present and structurally valid",
  warnings: [],
});

const missingResume = (path: string): ResumeCheck => ({
  ok: false,
  path,
  exists: false,
  sizeBytes: 0,
  format: "pdf",
  reason: `resume file not found at ${path}`,
  warnings: [],
});

const dirs: string[] = [];
function tempPaths(): WorkspacePaths {
  const home = mkdtempSync(join(tmpdir(), "autoapply-onboarding-"));
  dirs.push(home);
  return {
    home,
    profile: join(home, "profile.json"),
    campaign: join(home, "campaign.json"),
    companies: join(home, "companies.json"),
    database: join(home, "data", "autoapply.sqlite"),
    artifacts: join(home, "artifacts"),
    resumeSource: join(home, "resume.json"),
    fonts: join(home, "resumes", "fonts"),
    documents: join(home, "documents"),
    reports: join(home, "reports"),
    exports: join(home, "exports"),
    secrets: join(home, ".env"),
  };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A profile with nothing left to fix. */
function cleanProfile(overrides: Record<string, unknown> = {}) {
  return makeProfile({
    identity: {
      fullName: "Jordan Rivers",
      headline: "Platform Engineer",
      email: "jordan@rivers.test",
      phone: "+1 604 555 2368",
      location: { city: "Vancouver", region: "BC", country: "Canada" },
      links: { linkedin: "https://linkedin.com/in/jordan-rivers" },
    },
    facts: [{ id: "scale", statement: "Scaled an API to 40k requests per second.", metrics: ["40k rps"], tags: ["performance"] }],
    education: [{ institution: "University of Example", credential: "B.Sc.", field: "Computer Science" }],
    ...overrides,
  });
}

function status(profile = cleanProfile(), campaign = makeCampaign(), env: Record<string, string | undefined> = {}, validate = validResume) {
  return profileStatus({ paths: tempPaths(), profile, campaign }, { env, validateResume: validate });
}

describe("masking", () => {
  it("masks email and phone and reports presence only", () => {
    expect(maskEmail("alex@example.com")).toBe("a***@example.com");
    expect(maskEmail("not-an-email")).toBe("***");
    expect(maskEmail("")).toBe("");
    expect(maskPhone("555-0100")).toBe("***-**00");
    expect(maskPhone("+1 (604) 555-2368")).toBe("+* (***) ***-**68");
    expect(presence("1990-01-01")).toBe("set");
    expect(presence("  ")).toBe("empty");
  });
});

describe("placeholder detection", () => {
  it("recognizes the example and fixture stand-ins without flagging ordinary text", () => {
    for (const value of ["Alex Candidate", "you@example.com", "555-0100", "YYYY-MM-DD", "TODO later", "REVIEW this", "Your Full Name", "C:/path/to/resume.pdf"]) {
      expect(placeholderMarker(value), value).not.toBeNull();
    }
    for (const value of ["Jordan Rivers", "Led code review for 12 engineers", "Your mission to secure AI systems, as described in your posting, matches my work."]) {
      expect(placeholderMarker(value), value).toBeNull();
    }
    expect(findPlaceholders({ a: ["ok", { b: "Alex Candidate" }] }, ["root"])).toEqual([{ path: "/root/a/1/b", marker: "Alex Candidate" }]);
  });
});

describe("profileStatus", () => {
  it("reports the fixture profile's placeholders as blockers without echoing contact details", () => {
    const report = status(makeProfile());
    expect(report.ready).toBe(false);
    expect(report.identity?.email).toBe("a***@example.com");
    expect(report.identity?.phone).toBe("***-**00");
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain("alex@example.com");
    expect(serialized).not.toContain("555-0100");
    expect(report.placeholders?.hits).toEqual(
      expect.arrayContaining([
        { path: "/identity/fullName", marker: "Alex Candidate" },
        { path: "/identity/email", marker: "example.com" },
        { path: "/identity/phone", marker: "555-01" },
      ]),
    );
    expect(report.nextSteps[0]).toMatchObject({ priority: 1, severity: "blocker", section: "identity" });
    const severities = report.nextSteps.map((step) => step.severity);
    expect(severities.indexOf("suggested")).toBeGreaterThan(severities.lastIndexOf("blocker"));
  });

  it("is ready when nothing blocks, and counts what the profile holds", () => {
    const report = status();
    expect(report.ready).toBe(true);
    expect(report.nextSteps.filter((step) => step.severity === "blocker")).toEqual([]);
    expect(report.counts).toMatchObject({ experience: 1, education: 1, skills: 4, facts: 1, factsWithMetrics: 1, resumes: 2 });
    expect(report.workAuthorization?.campaignCoverage).toEqual([
      { country: "US", status: "requires-sponsorship" },
      { country: "CA", status: "authorized" },
    ]);
    expect(report.readiness).toBeGreaterThan(50);
  });

  it("refuses to guess work authorization for a targeted country", () => {
    const profile = cleanProfile({
      workAuthorization: { citizenships: ["Canada"], authorizedIn: ["CA"], statement: "Canadian citizen.", alwaysReviewManually: true },
    });
    const report = status(profile);
    expect(report.ready).toBe(false);
    expect(report.workAuthorization?.complete).toBe(false);
    const step = report.nextSteps.find((entry) => entry.section === "workAuthorization");
    expect(step).toMatchObject({ severity: "blocker", tool: "update_profile" });
    expect(step?.message).toContain("US");
    expect(step?.message).toContain("never assume");
  });

  it("flags country names where ISO codes are required", () => {
    const profile = cleanProfile({
      workAuthorization: {
        citizenships: ["Canada"],
        authorizedIn: ["Canada"],
        requiresSponsorshipIn: ["US"],
        statement: "Canadian citizen.",
      },
    });
    const report = status(profile);
    expect(report.workAuthorization?.campaignCoverage).toContainEqual({ country: "CA", status: "authorized" });
    expect(report.nextSteps.some((step) => step.message.includes('"Canada" is not a two-letter ISO country code (use "CA")'))).toBe(true);
  });

  it("checks compensation sanity", () => {
    const inverted = status(cleanProfile({ compensation: { currency: "USD", targetTotal: 150000, minimumTotal: 200000 } }));
    expect(inverted.compensation?.sane).toBe(false);
    expect(inverted.nextSteps.some((step) => step.message.includes("higher than the target"))).toBe(true);
    const placeholder = status(cleanProfile({ compensation: { currency: "USD", targetTotal: 1, minimumTotal: 1 } }));
    expect(placeholder.nextSteps.some((step) => step.message.includes("looks like a placeholder"))).toBe(true);
  });

  it("reports unusable resume files by file name only", () => {
    const report = status(cleanProfile(), makeCampaign(), {}, missingResume);
    const resumeSteps = report.nextSteps.filter((step) => step.section === "resumes");
    expect(resumeSteps).toHaveLength(2);
    expect(resumeSteps[0]!.message).toContain("resume.pdf");
    expect(resumeSteps[0]!.message).not.toContain(tmpdir());
    expect(report.resumes?.every((resume) => !resume.ok)).toBe(true);
  });

  it("lists answers that need review", () => {
    const profile = cleanProfile({
      answers: [
        { key: "start", label: "Earliest start date", patterns: ["start date"], answer: "" },
        { key: "relocate", label: "Relocation", patterns: ["relocat"], answer: "Yes", note: "REVIEW before using" },
        { key: "declined", label: "Optional essay", patterns: ["essay"], answer: "", skip: true },
        { key: "source", label: "How did you hear about us?", patterns: ["hear"], answer: "Careers page", allowAutoFill: true },
      ],
    });
    const report = status(profile);
    expect(report.answers).toMatchObject({ total: 4, needingReview: 2, flagged: 1, empty: 1 });
    expect(report.answers?.sample).toEqual([
      { index: 0, key: "start", label: "Earliest start date", reason: "empty" },
      { index: 1, key: "relocate", label: "Relocation", reason: "flagged-review" },
    ]);
  });

  it("runs the campaign checks", () => {
    const campaign = makeCampaign({
      tracks: [{ id: "orphan", label: "Orphan", resumeId: "missing", titleIncludes: [] }],
      inbox: { enabled: true },
      submission: { mode: "auto" },
    });
    const report = status(cleanProfile(), campaign, {});
    expect(report.campaign?.tracks[0]).toMatchObject({ id: "orphan", resumeExists: false });
    expect(report.campaign?.autoSubmitPossible).toBe(false);
    expect(report.campaign?.inbox).toMatchObject({ enabled: true, imapConfigured: false });
    const messages = report.nextSteps.map((step) => `${step.severity}: ${step.message}`);
    expect(messages).toEqual(
      expect.arrayContaining([
        expect.stringMatching(/^blocker: Track "orphan" uses resumeId "missing"/),
        expect.stringMatching(/^important: Track "orphan" has no titleIncludes or keywords/),
        expect.stringMatching(/^important: submission.allowedCompanies is empty/),
        expect.stringMatching(/^important: inbox.enabled is on but AUTOAPPLY_OTP_IMAP_USER/),
      ]),
    );
    const configured = status(cleanProfile(), makeCampaign({ inbox: { enabled: true } }), {
      AUTOAPPLY_OTP_IMAP_USER: "relay@inbox.test",
      AUTOAPPLY_OTP_IMAP_PASSWORD: "app-password",
    });
    expect(configured.campaign?.inbox.imapConfigured).toBe(true);
    expect(JSON.stringify(configured)).not.toContain("app-password");
  });

  it("reports personal fields as present or absent only", () => {
    const profile = cleanProfile({
      personal: { dateOfBirth: { value: "1990-02-03" }, address: { street: "1 Example Way", city: "Vancouver" } },
    });
    const report = status(profile);
    expect(report.personal).toMatchObject({ dateOfBirth: "set", address: "partial" });
    expect(JSON.stringify(report)).not.toContain("1990-02-03");
    expect(JSON.stringify(report)).not.toContain("1 Example Way");
  });

  it("still answers when the configuration files are missing or invalid", () => {
    const paths = tempPaths();
    const missing = readProfileStatus(paths, { env: {} });
    expect(missing.ready).toBe(false);
    expect(missing.configErrors.map((error) => `${error.file}:${error.code}`)).toEqual(["profile:config_missing", "campaign:config_missing"]);
    expect(missing.nextSteps[0]).toMatchObject({ severity: "blocker", tool: "npm run init" });

    writeFileSync(paths.profile, JSON.stringify({ version: 1 }));
    writeFileSync(paths.campaign, "{ not json");
    const invalid = readProfileStatus(paths, { env: {} });
    expect(invalid.configErrors.map((error) => error.code)).toEqual(["config_invalid", "config_invalid_json"]);
    expect(invalid.nextSteps.map((step) => step.tool)).toEqual(["update_profile", "update_campaign"]);
  });
});
