import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { getWorkspace, resetWorkspaceCache } from "../src/config/load.js";
import { getEvaluation, upsertJobs } from "../src/db/repositories/jobs.js";
import { matchBlacklist, normalizeDomain, normalizeEmployerName } from "../src/hygiene/blacklist.js";
import { addToBlacklist } from "../src/hygiene/blacklistStore.js";
import { evaluateJob } from "../src/pipeline.js";
import { evaluateGates } from "../src/ranking/gates.js";
import { makeCampaign, makeJob, makeProfile } from "./factories.js";
import { makeWorkspace, type TestWorkspace } from "./hygieneFixtures.js";

const entry = (scope: "company" | "domain", value: string, reason = "") => ({ scope, value, reason, since: "2026-10-01" });

describe("blacklist matching", () => {
  it("matches employer names case-, punctuation- and legal-suffix-insensitively", () => {
    expect(normalizeEmployerName("Acme, Inc.")).toBe(normalizeEmployerName("ACME"));
    expect(normalizeEmployerName("Société Générale")).toBe("societegenerale");
    expect(normalizeEmployerName("AT&T")).toBe(normalizeEmployerName("AT & T"));
    const job = makeJob({ companyName: "Acme, Inc." });
    expect(matchBlacklist(job, [entry("company", "acme")])?.matched).toBe("Acme, Inc.");
    expect(matchBlacklist(makeJob({ companyName: "Acme Labs" }), [entry("company", "Acme")])).toBeNull();
  });

  it("matches a domain's host and subdomains, never a lookalike", () => {
    expect(normalizeDomain("https://Jobs.Example.com/path")).toBe("jobs.example.com");
    expect(normalizeDomain("*.example.com.")).toBe("example.com");
    const onSubdomain = makeJob({ url: "https://careers.example.com/jobs/1", applyUrl: "https://careers.example.com/jobs/1" });
    expect(matchBlacklist(onSubdomain, [entry("domain", "example.com")])?.matched).toBe("careers.example.com");
    const lookalike = makeJob({ url: "https://notexample.com/jobs/1", applyUrl: "https://notexample.com/jobs/1" });
    expect(matchBlacklist(lookalike, [entry("domain", "example.com")])).toBeNull();
    const broken = makeJob({ url: "not a url", applyUrl: "" });
    expect(matchBlacklist(broken, [entry("domain", "example.com")])).toBeNull();
  });
});

describe("hygiene gates", () => {
  const profile = makeProfile();

  it("rejects a blacklisted employer with the candidate's reason", () => {
    const campaign = makeCampaign({ hygiene: { blacklist: [entry("company", "Test Corp", "bad interview experience")] } });
    const gate = evaluateGates(makeJob(), { campaign, profile });
    expect(gate).toMatchObject({ passed: false, rule: "blacklisted" });
    expect(gate.reason).toContain("bad interview experience");
  });

  it("leaves every existing gate alone when the list is empty and years are not enforced", () => {
    const campaign = makeCampaign({ hygiene: { experience: { candidateYears: 1 } } });
    const job = makeJob({ descriptionText: `${makeJob().descriptionText} Requirements: 12+ years of experience.` });
    expect(evaluateGates(job, { campaign, profile }).passed).toBe(true);
  });

  it("rejects an over-tolerance years bar only when enforced", () => {
    const campaign = makeCampaign({ hygiene: { experience: { candidateYears: 4, enforce: true } } });
    const job = makeJob({ descriptionText: `${makeJob().descriptionText}\nRequirements:\n- 10+ years of software engineering experience.` });
    const gate = evaluateGates(job, { campaign, profile });
    expect(gate).toMatchObject({ passed: false, rule: "experience-years" });
    expect(gate.evidence).toContain("10+ years");
    const close = makeJob({ descriptionText: `${makeJob().descriptionText}\nRequirements:\n- 5+ years of experience.` });
    expect(evaluateGates(close, { campaign, profile }).passed).toBe(true);
  });

  it("carries the stated bar as an evaluation flag", () => {
    const campaign = makeCampaign({ hygiene: { experience: { candidateYears: 4 } } });
    const job = makeJob({ descriptionText: `${makeJob().descriptionText}\nRequirements:\n- 8+ years of experience.` });
    const evaluation = evaluateJob(job, campaign, profile);
    expect(evaluation.flags).toEqual(expect.arrayContaining(["years-required:8", "years-over-tolerance"]));
    const rejected = evaluateJob(makeJob({ title: "Security Intern", descriptionText: job.descriptionText }), campaign, profile);
    expect(rejected.flags).toContain("years-required:8");
  });
});

describe("addToBlacklist", () => {
  let workspace: TestWorkspace;

  afterEach(() => {
    resetWorkspaceCache();
    delete process.env.AUTOAPPLY_HOME;
    workspace?.cleanup();
  });

  it("writes campaign.json with a backup, reloads, and re-evaluates matching stored postings", () => {
    workspace = makeWorkspace({ writeConfig: true });
    process.env.AUTOAPPLY_HOME = workspace.paths.home;
    resetWorkspaceCache();
    const live = getWorkspace();
    const job = makeJob({ id: "job_blk", companyName: "Test Corp" });
    upsertJobs(live.db, [job]);

    const result = addToBlacklist(live, { company: "Test Corp", domain: "https://careers.testcorp.example/jobs", reason: "not interested" });
    expect(result.added.map((added) => [added.scope, added.value])).toEqual([
      ["company", "Test Corp"],
      ["domain", "careers.testcorp.example"],
    ]);
    expect(result.backupPath && existsSync(result.backupPath)).toBe(true);
    const saved = JSON.parse(readFileSync(workspace.paths.campaign, "utf8"));
    expect(saved.hygiene.blacklist).toHaveLength(2);
    expect(result.workspace.campaign.hygiene.blacklist).toHaveLength(2);
    expect(result.reevaluated).toBe(1);
    expect(getEvaluation(result.workspace.db, job.id)?.gate.rule).toBe("blacklisted");

    const again = addToBlacklist(result.workspace, { company: "test corp, inc.", reason: "dup" });
    expect(again.added).toEqual([]);
    expect(again.alreadyListed).toHaveLength(1);
    expect(again.backupPath).toBeNull();
  });

  it("refuses an empty request and a malformed domain", () => {
    workspace = makeWorkspace({ writeConfig: true });
    expect(() => addToBlacklist(workspace, { reason: "x" })).toThrow(/company name, a domain/);
    expect(() => addToBlacklist(workspace, { domain: "not a domain", reason: "x" })).toThrow(/not a domain/);
  });

  it("does not write a campaign that would fail validation", () => {
    workspace = makeWorkspace({ writeConfig: true });
    writeFileSync(workspace.paths.campaign, JSON.stringify({ version: 1, name: "broken" }));
    expect(() => addToBlacklist(workspace, { company: "Acme", reason: "x" })).toThrow(/would not validate/);
    expect(JSON.parse(readFileSync(workspace.paths.campaign, "utf8")).hygiene).toBeUndefined();
  });
});
