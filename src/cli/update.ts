#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, relative, resolve, isAbsolute } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { resolvePaths } from "../config/paths.js";
import { toErrorMessage } from "../util/errors.js";

/**
 * Updates a git checkout of autoapply-mcp in place.
 *
 * The candidate's data lives in AUTOAPPLY_HOME, outside the repository, so an
 * update only ever has to move code: fast-forward the checkout, reinstall
 * dependencies, rebuild, and run doctor against the existing configuration.
 * Local edits to the source are the one thing an update could destroy, so it
 * refuses to start while any exist under src/ and names them instead.
 *
 * This is a CLI, so writing to stdout is correct here.
 */

export type CommandResult = { status: number | null; stdout?: string; error?: Error };
export type CommandRunner = (command: string, args: readonly string[], options: { cwd: string; capture?: boolean }) => CommandResult;

/** npm is a .cmd shim on Windows, which Node only spawns through a shell. */
export const spawnRunner: CommandRunner = (command, args, { cwd, capture }) => {
  const shell = process.platform === "win32" && (command === "npm" || command === "npx");
  const result = spawnSync(command, [...args], {
    cwd,
    shell,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
  });
  return { status: result.status, stdout: typeof result.stdout === "string" ? result.stdout : undefined, error: result.error };
};

export type UpdateOptions = {
  repoRoot: string;
  /** AUTOAPPLY_HOME, checked only to warn when it sits inside the checkout. */
  home?: string;
  runner?: CommandRunner;
  exists?: (path: string) => boolean;
  out?: (line: string) => void;
  err?: (line: string) => void;
  /** The Node.js executable that runs doctor. */
  node?: string;
};

type Step = { command: string; args: string[]; label: string; display?: string };

function isInside(child: string, parent: string): boolean {
  const path = relative(parent, child);
  return path === "" || (!path.startsWith("..") && !isAbsolute(path));
}

export function runUpdate(options: UpdateOptions): number {
  const runner = options.runner ?? spawnRunner;
  const exists = options.exists ?? existsSync;
  const out = options.out ?? console.log;
  const err = options.err ?? console.error;
  const cwd = options.repoRoot;

  if (!exists(join(cwd, ".git"))) {
    err(`${cwd} is not a git checkout. If you installed from npm, update with: npm install -g autoapply-mcp@latest`);
    return 1;
  }
  if (options.home && isInside(resolve(options.home), resolve(cwd))) {
    err("WARN  AUTOAPPLY_HOME is inside the checkout. git never rewrites untracked files, but keep your data outside the repository.");
  }

  const status = runner("git", ["status", "--porcelain", "--untracked-files=all", "--", "src"], { cwd, capture: true });
  if (status.error || status.status !== 0) {
    err(`could not read the git status: ${status.error ? status.error.message : `git exited with ${status.status}`}`);
    return 1;
  }
  const changes = (status.stdout ?? "").split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (changes.length > 0) {
    err("Refusing to update: these files under src/ have uncommitted changes:");
    for (const change of changes) err(`  ${change}`);
    err("Commit or move them first, then run npm run update again.");
    return 1;
  }

  const node = options.node ?? process.execPath;
  const steps: Step[] = [
    { command: "git", args: ["pull", "--ff-only"], label: "fetch the latest code" },
    exists(join(cwd, "package-lock.json"))
      ? { command: "npm", args: ["ci"], label: "install the locked dependencies" }
      : { command: "npm", args: ["install"], label: "install dependencies" },
    { command: "npm", args: ["run", "build"], label: "build" },
    { command: node, args: [join("dist", "cli", "doctor.js")], label: "check the configuration", display: "node" },
  ];

  for (const [index, step] of steps.entries()) {
    out(`\n[${index + 1}/${steps.length}] ${step.label}: ${step.display ?? step.command} ${step.args.join(" ")}`);
    const result = runner(step.command, step.args, { cwd });
    if (result.error) {
      err(`could not run ${step.command}: ${result.error.message}`);
      return 1;
    }
    if (result.status !== 0) {
      const isDoctor = index === steps.length - 1;
      err(
        isDoctor
          ? "The update is installed, but doctor reported problems with your configuration (see above)."
          : `Step failed with exit code ${result.status ?? "unknown"}; stopping. Your data in AUTOAPPLY_HOME was not touched.`,
      );
      return result.status ?? 1;
    }
  }
  out("\nautoapply-mcp is up to date. Your data in AUTOAPPLY_HOME was not touched. Restart your MCP client to load the new build.");
  return 0;
}

function isMain(): boolean {
  const entry = process.argv[1];
  return entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href;
}

if (isMain()) {
  try {
    // dist/cli/update.js -> repository root
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
    process.exitCode = runUpdate({ repoRoot, home: resolvePaths().home });
  } catch (error) {
    console.error(toErrorMessage(error));
    process.exitCode = 1;
  }
}
