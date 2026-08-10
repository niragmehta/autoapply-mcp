#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePaths } from "../config/paths.js";
import { toErrorMessage } from "../util/errors.js";

/**
 * Scaffolds a personal configuration directory from the shipped examples.
 *
 * Setting this up by hand means knowing that three files are required, where
 * they live, which example seeds which one, and that the company list comes from
 * a preset rather than an example - four facts that are only written down in the
 * README. Copying them wrongly produces a server that starts and then fails on
 * first use, so the work is done here instead.
 *
 * Existing files are never overwritten. A partially configured home is the
 * normal case for someone adding a second campaign, and silently replacing a
 * profile that took an hour to write would be unforgivable.
 *
 * This is a CLI, so writing to stdout is correct here.
 */

const here = dirname(fileURLToPath(import.meta.url));
// dist/cli/init.js -> repository root
const repoRoot = resolve(here, "..", "..");

type Seed = { target: string; source: string; label: string };

function copySeed(seed: Seed): { ok: boolean; detail: string } {
  if (!existsSync(seed.source)) {
    return { ok: false, detail: `template missing at ${seed.source}; run "npm run build" from a complete checkout` };
  }
  if (existsSync(seed.target)) {
    return { ok: true, detail: "already present, left untouched" };
  }
  mkdirSync(dirname(seed.target), { recursive: true });
  copyFileSync(seed.source, seed.target);
  return { ok: true, detail: `created from ${seed.label}` };
}

function main(): void {
  const paths = resolvePaths();
  const force = process.argv.includes("--force");
  if (force) {
    console.error("init does not overwrite existing files; remove them by hand if that is really what you want.");
    process.exitCode = 1;
    return;
  }

  console.log(`autoapply-mcp init\nhome: ${paths.home}\n`);

  const seeds: Seed[] = [
    {
      target: paths.profile,
      source: join(repoRoot, "examples", "profile.example.json"),
      label: "examples/profile.example.json",
    },
    {
      target: paths.campaign,
      source: join(repoRoot, "examples", "campaign.example.json"),
      label: "examples/campaign.example.json",
    },
    {
      target: paths.companies,
      source: join(repoRoot, "presets", "ai-security-us-canada.json"),
      label: "presets/ai-security-us-canada.json",
    },
  ];

  let failed = 0;
  for (const seed of seeds) {
    const result = copySeed(seed);
    if (!result.ok) failed += 1;
    console.log(`${result.ok ? "OK  " : "FAIL"}  ${seed.target} - ${result.detail}`);
  }

  mkdirSync(join(paths.home, "resumes"), { recursive: true });
  mkdirSync(paths.artifacts, { recursive: true });
  mkdirSync(dirname(paths.database), { recursive: true });
  console.log(`OK    ${join(paths.home, "resumes")} - ready for your resume PDFs`);

  if (failed > 0) {
    process.exitCode = 1;
    return;
  }

  console.log(
    [
      "",
      "Next, in order:",
      "  1. Edit profile.json - identity, workAuthorization, compensation, skills, facts.",
      "     Every drafted answer must trace back to something in this file.",
      "  2. Put your resume PDFs in resumes/ and point profile.resumes[].path at them.",
      "  3. Edit campaign.json - tracks, locations, compensation floor, submission policy.",
      "     Each track's resumeId must name a variant declared in profile.resumes.",
      "  4. Trim companies.json to the employers you actually want to apply to.",
      "  5. Verify: node dist/cli/doctor.js --probe",
      "",
      "doctor validates all three files, confirms your resumes exist and are real",
      "PDFs, checks every track resolves to a resume, warns about settings written",
      "in the wrong place, and probes each configured board.",
      "",
      "Submission stays in \"manual\" mode until you change campaign.submission.mode,",
      "and no employer is contacted until a company appears in submission.allowedCompanies.",
    ].join("\n"),
  );
}

try {
  main();
} catch (error) {
  console.error(toErrorMessage(error));
  process.exitCode = 1;
}
