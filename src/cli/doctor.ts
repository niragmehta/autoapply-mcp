#!/usr/bin/env node
import { loadCampaign, loadCompanies, loadProfile } from "../config/load.js";
import { resolvePaths } from "../config/paths.js";
import { adapterFor } from "../sources/registry.js";
import { probeJson } from "../sources/http.js";
import { validateResumeFile } from "../submission/resume.js";
import { toErrorMessage } from "../util/errors.js";

/**
 * Preflight check for a campaign: validates configuration, confirms resume
 * files exist, and verifies every configured board still resolves.
 *
 * This is a CLI, so writing to stdout is correct here.
 */

type Check = { name: string; ok: boolean; detail: string };

function print(check: Check): void {
  console.log(`${check.ok ? "PASS" : "FAIL"}  ${check.name}${check.detail ? ` - ${check.detail}` : ""}`);
}

async function main(): Promise<void> {
  const paths = resolvePaths();
  console.log(`autoapply-mcp doctor\nhome: ${paths.home}\n`);

  const checks: Check[] = [];
  let profile;
  let campaign;
  let companies;

  try {
    profile = loadProfile(paths.profile);
    checks.push({ name: "profile.json", ok: true, detail: `${profile.identity.fullName}, ${profile.resumes.length} resume variant(s)` });
  } catch (error) {
    checks.push({ name: "profile.json", ok: false, detail: toErrorMessage(error) });
  }

  try {
    campaign = loadCampaign(paths.campaign);
    checks.push({
      name: "campaign.json",
      ok: true,
      detail: `${campaign.name}, ${campaign.tracks.length} track(s), submission mode "${campaign.submission.mode}"`,
    });
  } catch (error) {
    checks.push({ name: "campaign.json", ok: false, detail: toErrorMessage(error) });
  }

  try {
    companies = loadCompanies(paths.companies);
    checks.push({ name: "companies.json", ok: true, detail: `${companies.length} board(s) configured` });
  } catch (error) {
    checks.push({ name: "companies.json", ok: false, detail: toErrorMessage(error) });
  }

  for (const resume of profile?.resumes ?? []) {
    const check = validateResumeFile(resume.path);
    const detail = check.ok
      ? `${check.format}, ${Math.round(check.sizeBytes / 1024)} KB${check.warnings.length > 0 ? ` - ${check.warnings.join("; ")}` : ""}`
      : check.reason;
    checks.push({ name: `resume "${resume.id}"`, ok: check.ok, detail });
  }

  if (profile && campaign) {
    const resumeIds = new Set(profile.resumes.map((resume) => resume.id));
    for (const track of campaign.tracks) {
      const ok = resumeIds.has(track.resumeId);
      checks.push({
        name: `track "${track.id}" resume binding`,
        ok,
        detail: ok ? track.resumeId : `campaign references unknown resumeId "${track.resumeId}"`,
      });
    }
  }

  checks.forEach(print);

  if (companies && companies.length > 0 && process.argv.includes("--probe")) {
    console.log("\nProbing configured boards...\n");
    let failures = 0;
    for (const company of companies.filter((entry) => entry.active)) {
      const url = adapterFor(company.ats).listUrl(company);
      const probe = await probeJson(url);
      if (!probe.ok) failures += 1;
      print({ name: `${company.name} (${company.ats}/${company.board})`, ok: probe.ok, detail: probe.ok ? "" : probe.status });
    }
    console.log(`\n${companies.length - failures}/${companies.length} board(s) reachable.`);
  } else if (companies) {
    console.log("\nRun with --probe to verify every board resolves.");
  }

  const failed = checks.filter((check) => !check.ok).length;
  console.log(`\n${checks.length - failed}/${checks.length} check(s) passed.`);
  process.exitCode = failed > 0 ? 1 : 0;
}

main().catch((error) => {
  console.error(toErrorMessage(error));
  process.exitCode = 1;
});
