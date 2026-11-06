import { existsSync, readFileSync } from "node:fs";

/**
 * Local secrets for long-running processes.
 *
 * The submission engine reads credentials from the environment (the ATS
 * account password, the verification mailbox). An MCP client passes them in its
 * server config; a dashboard or CLI started by hand would otherwise need every
 * variable exported in the shell that launched it. A KEY=value file in the
 * workspace home keeps them in one place that is never inside the repository.
 *
 * Values already present in the environment win, so an explicit export or a
 * client config can always override the file.
 */

const LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/;

/** Parses KEY=value lines. Blank lines and # comments are skipped; quotes are optional. */
export function parseSecrets(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.replace(/^\uFEFF/, "").split(/\r?\n/)) {
    if (/^\s*(#|$)/.test(raw)) continue;
    const match = LINE.exec(raw);
    if (!match) continue;
    const [, key, value = ""] = match;
    out[key!] = unquote(value);
  }
  return out;
}

function unquote(value: string): string {
  const quoted = /^(['"])(.*)\1$/.exec(value);
  return quoted ? quoted[2]! : value;
}

/**
 * Loads the secrets file into process.env without overriding variables that are
 * already set. Returns the names it applied (never the values).
 */
export function loadSecretsFile(path: string, env: NodeJS.ProcessEnv = process.env): string[] {
  if (!existsSync(path)) return [];
  const applied: string[] = [];
  for (const [key, value] of Object.entries(parseSecrets(readFileSync(path, "utf8")))) {
    if (env[key] !== undefined && env[key] !== "") continue;
    env[key] = value;
    applied.push(key);
  }
  return applied;
}
