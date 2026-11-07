#!/usr/bin/env node
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolvePaths, type WorkspacePaths } from "../config/paths.js";
import { allClientConfigs, clientConfig, MCP_CLIENTS, renderClientConfig, resolveClient, type ServerLaunch } from "../onboarding/clientConfig.js";
import { toErrorMessage } from "../util/errors.js";

/**
 * Scaffolds a personal configuration directory from the shipped examples.
 *
 * Setting this up by hand means knowing that three files are required, where
 * they live, which example seeds which one, and that the company list comes from
 * a preset rather than an example - four facts that are only written down in the
 * README. Copying them wrongly produces a server that starts and then fails on
 * first use, so the work is done here instead. It finishes by printing the MCP
 * client configuration for this checkout, so nothing has to be typed by hand.
 *
 * Existing files are never overwritten. A partially configured home is the
 * normal case for someone adding a second campaign, and silently replacing a
 * profile that took an hour to write would be unforgivable.
 *
 * This is a CLI, so writing to stdout is correct here.
 */

export type InitFs = {
  existsSync: (path: string) => boolean;
  mkdirSync: (path: string, options: { recursive: true }) => unknown;
  copyFileSync: (source: string, target: string) => void;
  writeFileSync: (path: string, data: string, options: { encoding: "utf8"; mode?: number; flag?: string }) => void;
};

export type InitOptions = {
  paths: WorkspacePaths;
  repoRoot: string;
  argv: readonly string[];
  fs?: InitFs;
  out?: (line: string) => void;
  err?: (line: string) => void;
  /** Absolute path to the Node.js executable the clients should launch. */
  node?: string;
  platform?: NodeJS.Platform;
};

const NODE_FS: InitFs = { existsSync, mkdirSync, copyFileSync, writeFileSync };

export const SECRETS_TEMPLATE = [
  "# autoapply-mcp local secrets. Keep this file private: never commit, share or paste it,",
  "# and on a shared machine make it readable by your account only.",
  "# One KEY=value per line; a variable already set in the environment wins.",
  "# The CLIs and the dashboard read this file. The MCP server gets its variables from",
  "# your client's env block instead (see docs/CLIENTS.md).",
  "",
  "# Password the submission engine uses for ATS candidate accounts (Workday and similar).",
  "# AUTOAPPLY_ATS_PASSWORD=",
  "",
  "# A dedicated mailbox for one-time codes, verification links and LinkedIn job alerts.",
  "# Use an app password, never the password of your main account.",
  "# AUTOAPPLY_OTP_IMAP_USER=",
  "# AUTOAPPLY_OTP_IMAP_PASSWORD=",
  "# AUTOAPPLY_OTP_IMAP_HOST=imap.gmail.com",
  "",
  "# Foorilla job search API key (optional; needs a PRO+ account).",
  "# AUTOAPPLY_FOORILLA_API_KEY=",
  "",
  "# Fixed access token for the local dashboard (optional; a random one is generated otherwise).",
  "# AUTOAPPLY_DASHBOARD_TOKEN=",
  "",
].join("\n");

type Seed = { target: string; source: string; label: string; optional?: boolean };
type Outcome = "created" | "kept" | "failed" | "skipped";

function copySeed(fs: InitFs, seed: Seed): { outcome: Outcome; detail: string } {
  if (!fs.existsSync(seed.source)) {
    if (seed.optional) return { outcome: "skipped", detail: "" };
    return { outcome: "failed", detail: `template missing at ${seed.source}; run "npm run build" from a complete checkout` };
  }
  if (fs.existsSync(seed.target)) return { outcome: "kept", detail: "already present, left untouched" };
  fs.mkdirSync(dirname(seed.target), { recursive: true });
  fs.copyFileSync(seed.source, seed.target);
  return { outcome: "created", detail: `created from ${seed.label}` };
}

function flagValue(argv: readonly string[], flag: string): string | null | undefined {
  const index = argv.findIndex((arg) => arg === flag || arg.startsWith(`${flag}=`));
  if (index < 0) return undefined;
  const arg = argv[index]!;
  if (arg.includes("=")) return arg.slice(arg.indexOf("=") + 1);
  const next = argv[index + 1];
  return next && !next.startsWith("--") ? next : null;
}

function launchFor(options: InitOptions): ServerLaunch {
  return {
    name: "autoapply",
    node: options.node ?? process.execPath,
    serverPath: join(options.repoRoot, "dist", "index.js"),
    home: options.paths.home,
  };
}

function printOneConfig(options: InitOptions, requested: string | null): number {
  const out = options.out ?? console.log;
  const err = options.err ?? console.error;
  const client = requested ? resolveClient(requested) : null;
  if (!client) {
    err(`--print-config needs one of: ${MCP_CLIENTS.join(", ")}`);
    return 1;
  }
  const config = clientConfig(client, launchFor(options), options.platform);
  // The snippet alone goes to stdout so it can be redirected into a file; the
  // guidance goes to stderr.
  out(config.snippet);
  err(`\n${config.label}: ${config.where.join("; ")}`);
  for (const note of config.notes) err(`- ${note}`);
  err(`- Docs: ${config.docs}`);
  return 0;
}

export function runInit(options: InitOptions): number {
  const fs = options.fs ?? NODE_FS;
  const out = options.out ?? console.log;
  const err = options.err ?? console.error;
  const { paths, repoRoot, argv } = options;

  if (argv.includes("--force")) {
    err("init does not overwrite existing files; remove them by hand if that is really what you want.");
    return 1;
  }
  const requested = flagValue(argv, "--print-config");
  if (requested !== undefined) return printOneConfig(options, requested);

  out(`autoapply-mcp init\nhome: ${paths.home}\n`);
  const seeds: Seed[] = [
    { target: paths.profile, source: join(repoRoot, "examples", "profile.example.json"), label: "examples/profile.example.json" },
    { target: paths.campaign, source: join(repoRoot, "examples", "campaign.example.json"), label: "examples/campaign.example.json" },
    { target: paths.companies, source: join(repoRoot, "presets", "ai-security-us-canada.json"), label: "presets/ai-security-us-canada.json" },
    { target: paths.resumeSource, source: join(repoRoot, "examples", "resume.example.json"), label: "examples/resume.example.json", optional: true },
  ];

  let failed = 0;
  for (const seed of seeds) {
    const result = copySeed(fs, seed);
    if (result.outcome === "skipped") continue;
    if (result.outcome === "failed") failed += 1;
    out(`${result.outcome === "failed" ? "FAIL" : "OK  "}  ${seed.target} - ${result.detail}`);
  }

  const directories: Array<[string, string]> = [
    [join(paths.home, "resumes"), "ready for your resume PDFs"],
    [paths.fonts, "fonts the resume and cover letter templates embed"],
    [paths.documents, "tailored resumes and cover letters"],
    [paths.reports, "evaluation reports"],
    [paths.exports, "tracker exports"],
    [paths.artifacts, "submission screenshots and packets"],
    [dirname(paths.database), "the application database"],
  ];
  for (const [directory, purpose] of directories) {
    const existed = fs.existsSync(directory);
    fs.mkdirSync(directory, { recursive: true });
    out(`OK    ${directory} - ${existed ? "already present" : purpose}`);
  }

  if (fs.existsSync(paths.secrets)) {
    out(`OK    ${paths.secrets} - already present, left untouched`);
  } else {
    fs.mkdirSync(dirname(paths.secrets), { recursive: true });
    // "wx" refuses to replace a file that appeared since the check above.
    fs.writeFileSync(paths.secrets, SECRETS_TEMPLATE, { encoding: "utf8", mode: 0o600, flag: "wx" });
    out(`OK    ${paths.secrets} - secrets template created; keep this file private`);
  }

  if (failed > 0) return 1;

  const launch = launchFor(options);
  out(
    [
      "",
      "Next, in order:",
      "  1. Connect your MCP client with one of the blocks below.",
      '  2. In the client, run the "onboard" prompt (or ask the agent to call profile_status).',
      "     It walks you through roles, locations, pay, work authorization, your CV,",
      "     facts and recurring answers, and saves each confirmed answer for you.",
      "  3. Put your resume PDFs in resumes/; the agent records their paths.",
      "  4. Trim companies.json to the employers you actually want to apply to.",
      "  5. Verify: npm run doctor -- --probe",
      "",
      'Submission stays in "manual" mode until you change campaign.submission.mode,',
      "and no employer is contacted until a company appears in submission.allowedCompanies.",
      ...(fs.existsSync(launch.serverPath) ? [] : ["", `NOTE: ${launch.serverPath} does not exist yet; run "npm run build" first.`]),
      "",
      "MCP client configuration (print just one with: npm run init -- --print-config <client>)",
      "",
      allClientConfigs(launch, options.platform).map(renderClientConfig).join("\n\n"),
    ].join("\n"),
  );
  return 0;
}

const here = dirname(fileURLToPath(import.meta.url));

function isMain(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href;
}

if (isMain()) {
  try {
    // dist/cli/init.js -> repository root
    process.exitCode = runInit({ paths: resolvePaths(), repoRoot: resolve(here, "..", ".."), argv: process.argv.slice(2) });
  } catch (error) {
    console.error(toErrorMessage(error));
    process.exitCode = 1;
  }
}
