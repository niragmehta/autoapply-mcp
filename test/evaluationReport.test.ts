import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { recordLiveness } from "../src/db/repositories/liveness.js";
import { getEvaluationReport, listEvaluationReports, saveEvaluationReport, slugify, unverifiedFigures } from "../src/evaluation/report.js";
import { buildEvaluationScaffold } from "../src/evaluation/scaffold.js";
import { makeJob } from "./factories.js";
import { makeWorkspace, SAMPLE_JD, storeJobs, type TestWorkspace } from "./hygieneFixtures.js";

let workspace: TestWorkspace;
const job = makeJob({ id: "job_eval", companyName: "Acmé Robotics, Inc.", title: "Senior Security Engineer", descriptionText: SAMPLE_JD });

beforeEach(() => {
  workspace = makeWorkspace();
  storeJobs(workspace, [job]);
  recordLiveness(workspace.db, { jobId: job.id, status: "open", via: "api", detail: "Greenhouse still publishes the posting", checkedAt: new Date().toISOString() });
});
afterEach(() => workspace.cleanup());

describe("buildEvaluationScaffold", () => {
  it("assembles every deterministic block with evidence", () => {
    const scaffold = buildEvaluationScaffold(workspace, job.id);
    expect(scaffold.job).toMatchObject({ id: job.id, company: "Acmé Robotics, Inc.", descriptionChars: SAMPLE_JD.length });
    expect(scaffold.liveness?.status).toBe("open");
    expect(scaffold.requirements.length).toBeGreaterThanOrEqual(7);
    expect(scaffold.requirements.every((item) => ["direct", "adjacent", "none"].includes(item.evidence.tier))).toBe(true);
    expect(scaffold.skillGap.gap.map((entry) => entry.term)).toContain("Kubernetes");
    expect(scaffold.keywords.coveragePercent).toBeGreaterThan(0);
    expect(scaffold.archetype.trackId).toBe("ai-security");
    expect(scaffold.experience.requiredYears).toBe(5);
    expect(scaffold.interviewFocus.length).toBeGreaterThan(0);
    expect(scaffold.interviewFocus[0]?.importance).toBe("required");
    expect(scaffold.stories).toEqual([]);
    expect(scaffold.scorecard.globalScore).toBeGreaterThanOrEqual(1);
    expect(scaffold.machineSummary).toMatchObject({ jobId: job.id, liveness: "open", blacklisted: false });
    expect(scaffold.blacklist).toBeNull();
  });

  it("re-evaluates against the current campaign, so a new blacklist entry shows at once", () => {
    const listed = {
      ...workspace,
      campaign: { ...workspace.campaign, hygiene: { ...workspace.campaign.hygiene, blacklist: [{ scope: "company" as const, value: "Acme Robotics", reason: "not again", since: "2026-10-01" }] } },
    };
    const scaffold = buildEvaluationScaffold(listed, job.id);
    expect(scaffold.blacklist?.entry.reason).toBe("not again");
    expect(scaffold.evaluation.gate.rule).toBe("blacklisted");
    expect(scaffold.scorecard).toMatchObject({ globalScore: 1, verdict: "do-not-apply" });
  });

  it("fails clearly for an unknown job", () => {
    expect(() => buildEvaluationScaffold(workspace, "job_missing")).toThrow(/job_missing/);
  });
});

describe("unverifiedFigures", () => {
  it("flags numbers found in neither the scaffold nor the profile", () => {
    const corpus = "salary 300000, 5+ years, 40% faster, 2021-02, score 4.2";
    expect(unverifiedFigures("Target $300k, 5 years, 40% faster, scored 4.2/5 in 2021.", corpus)).toEqual([]);
    expect(unverifiedFigures("Cut costs by 35% across 12 teams", corpus)).toEqual(["35%", "12"]);
  });
});

describe("saveEvaluationReport", () => {
  const narrative = (overrides: Record<string, unknown> = {}) => {
    const scaffold = buildEvaluationScaffold(workspace, job.id);
    const score = scaffold.scorecard.globalScore;
    return { summary: "A solid security role with gaps in Kubernetes and cloud.", verdict: scaffold.scorecard.verdict, score, ...overrides };
  };

  it("stores the report, writes numbered Markdown and lists it", () => {
    const saved = saveEvaluationReport(workspace, job.id, {
      ...narrative(),
      cvMatchNotes: "Python and threat modeling are direct matches (fact guardrails).",
      compResearch: { notes: "Published range only.", sources: [{ title: "Posting", url: "https://job-boards.greenhouse.io/testcorp/jobs/123" }] },
    });
    expect(saved.number).toBe(1);
    expect(saved.markdownPath).toMatch(new RegExp(`001-acme-robotics-inc-\\d{4}-\\d{2}-\\d{2}\\.md$`));
    expect(saved.unverifiedFigures).toEqual([]);
    const markdown = readFileSync(saved.markdownPath, "utf8");
    expect(markdown).toContain("# Evaluation 001: Acmé Robotics, Inc. - Senior Security Engineer");
    expect(markdown).toContain("## B) Match with CV");
    expect(markdown).toContain("## G) Posting legitimacy");
    expect(markdown).toContain("## Job description (archived, untrusted)");
    expect(markdown).toContain("Python and threat modeling are direct matches");

    const second = saveEvaluationReport(workspace, job.id, narrative());
    expect(second.number).toBe(2);
    expect(getEvaluationReport(workspace, { jobId: job.id })?.id).toBe(second.reportId);
    expect(getEvaluationReport(workspace, { reportId: saved.reportId })?.number).toBe(1);
    expect(listEvaluationReports(workspace).map((report) => report.number)).toEqual([2, 1]);
    expect(listEvaluationReports(workspace)[0]).toMatchObject({ company: "Acmé Robotics, Inc.", title: "Senior Security Engineer" });
  });

  it("continues numbering after files already in the reports folder", () => {
    const first = saveEvaluationReport(workspace, job.id, narrative());
    writeFileSync(join(workspace.paths.reports, "041-other-2026-01-01.md"), "# old");
    expect(saveEvaluationReport(workspace, job.id, narrative()).number).toBe(42);
    expect(existsSync(first.markdownPath)).toBe(true);
  });

  it("flags invented figures in the stored report", () => {
    const saved = saveEvaluationReport(workspace, job.id, narrative({ summary: "Strong fit: the candidate cut incident response time by 63% across 17 teams." }));
    expect(saved.unverifiedFigures).toEqual(["63%", "17"]);
    expect(readFileSync(saved.markdownPath, "utf8")).toContain("Unverified figures");
    expect(getEvaluationReport(workspace, { reportId: saved.reportId })?.unverifiedFigures).toEqual(["63%", "17"]);
  });

  it("never lets a timestamp or date vouch for a figure", () => {
    const corpus = '{"generatedAt":"2026-11-07T03:17:22.000Z","postedAt":"2026-10-28","checkedAt":"2026-11-07 09:45"}';
    expect(unverifiedFigures("Led 17 teams and grew revenue 28% in 45 days.", corpus)).toEqual(["17", "28%", "45"]);
    expect(unverifiedFigures("Interviewed on 2026-11-07 at 09:45.", corpus)).toEqual([]);
  });

  it("requires the verdict to match the score's band and a reason for a large deviation", () => {
    const base = narrative();
    const wrongVerdict = base.verdict === "do-not-apply" ? "apply" : "do-not-apply";
    expect(() => saveEvaluationReport(workspace, job.id, { ...base, verdict: wrongVerdict })).toThrow(/falls in/);
    const far = base.score >= 3 ? 1.2 : 4.8;
    expect(() => saveEvaluationReport(workspace, job.id, { ...base, score: far, verdict: far >= 4.5 ? "strong-apply" : "do-not-apply" })).toThrow(/scoreDeviation/);
    const explained = saveEvaluationReport(workspace, job.id, {
      ...base,
      score: far,
      verdict: far >= 4.5 ? "strong-apply" : "do-not-apply",
      scoreDeviation: "Research found the team was disbanded last month.",
    });
    expect(explained.score).toBe(far);
  });

  it("rejects an invalid narrative", () => {
    expect(() => saveEvaluationReport(workspace, job.id, { summary: "too short", verdict: "apply" })).toThrow(/invalid_narrative|summary/);
    expect(() => saveEvaluationReport(workspace, "job_missing", narrative())).toThrow(/job_missing/);
  });
});

describe("slugify", () => {
  it("produces ASCII file-safe slugs", () => {
    expect(slugify("Acmé Robotics, Inc.")).toBe("acme-robotics-inc");
    expect(slugify("株式会社")).toBe("company");
  });
});
