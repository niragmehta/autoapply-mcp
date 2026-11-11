#!/usr/bin/env node
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { resolvePaths, type WorkspacePaths } from "../config/paths.js";
import { exportHome, importHome } from "../home/bundle.js";
import { toErrorMessage } from "../util/errors.js";

/**
 * Moves an AUTOAPPLY_HOME to another machine, such as a cloud sandbox, as one
 * encrypted file. The passphrase comes only from AUTOAPPLY_BUNDLE_PASSPHRASE,
 * never from an argument, so it stays out of shell history and process lists.
 * See docs/CLOUD.md.
 *
 * This is a CLI, so writing to stdout is correct here.
 */

const USAGE = [
  "usage:",
  "  AUTOAPPLY_BUNDLE_PASSPHRASE=... node dist/cli/homeBundle.js export --out <file> [--no-documents] [--force]",
  "  AUTOAPPLY_BUNDLE_PASSPHRASE=... node dist/cli/homeBundle.js import --in <file> [--force]",
].join("\n");

export type HomeBundleOptions = {
  argv: readonly string[];
  paths: WorkspacePaths;
  env: Readonly<Record<string, string | undefined>>;
  log: (line: string) => void;
  error: (line: string) => void;
};

function valueOf(argv: readonly string[], name: string): string | undefined {
  const index = argv.indexOf(name);
  const value = index >= 0 ? argv[index + 1] : undefined;
  return value && !value.startsWith("--") ? value : undefined;
}

const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

function runExport(options: HomeBundleOptions, passphrase: string, out: string): number {
  if (existsSync(out) && !options.argv.includes("--force")) {
    options.error(`error: ${out} already exists; pass --force to replace it`);
    return 1;
  }
  const { bytes, summary } = exportHome(options.paths, { passphrase, documents: !options.argv.includes("--no-documents") });
  writeFileSync(out, bytes, { mode: 0o600 });
  options.log(`exported ${summary.files} files (${megabytes(summary.bytes)} before compression) from ${options.paths.home}`);
  options.log(`bundle: ${out} (${megabytes(bytes.length)}, encrypted)`);
  options.log(`applications: ${Object.entries(summary.applications).map(([status, count]) => `${status} ${count}`).join(", ") || "none"}`);
  options.log(`postings kept for that history: ${summary.jobsKept}; left for the next discovery: ${summary.jobsLeftOut}`);
  return 0;
}

function runImport(options: HomeBundleOptions, passphrase: string, input: string): number {
  const result = importHome(readFileSync(input), options.paths, { passphrase, force: options.argv.includes("--force") });
  options.log(`imported ${result.files} files into ${options.paths.home} (bundle made ${result.bundleCreatedAt})`);
  if (result.backup) options.log(`replaced files were backed up to ${result.backup}`);
  options.log(`paths moved to this home: ${result.pathsRewritten}; approvals to give again on this machine: ${result.approvalsVoided}`);
  options.log("next: set this machine's secrets (see docs/CLOUD.md), then run node dist/cli/doctor.js");
  return 0;
}

export function runHomeBundle(options: HomeBundleOptions): number {
  const [command] = options.argv;
  const file = valueOf(options.argv, command === "export" ? "--out" : "--in");
  if ((command !== "export" && command !== "import") || !file) {
    options.error(USAGE);
    return 2;
  }
  const passphrase = options.env.AUTOAPPLY_BUNDLE_PASSPHRASE;
  if (!passphrase) {
    options.error("error: set AUTOAPPLY_BUNDLE_PASSPHRASE to the bundle's passphrase (20 characters or more)");
    return 1;
  }
  try {
    return command === "export" ? runExport(options, passphrase, resolve(file)) : runImport(options, passphrase, resolve(file));
  } catch (error) {
    options.error(`error: ${toErrorMessage(error)}`);
    return 1;
  }
}

function isMain(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href;
}

if (isMain()) {
  process.exitCode = runHomeBundle({
    argv: process.argv.slice(2),
    paths: resolvePaths(),
    env: process.env,
    log: (line) => console.log(line),
    error: (line) => console.error(line),
  });
}
