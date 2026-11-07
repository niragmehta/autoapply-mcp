#!/usr/bin/env node
/**
 * Fails when a tracked file looks like personal campaign data.
 *
 * Profiles, resumes, the application database and browser artifacts hold PII
 * and application history. They live in AUTOAPPLY_HOME, never in the
 * repository; only the fictional examples and presets are tracked.
 */
import { execFileSync } from "node:child_process";

const ALLOWED = [/^examples\/[a-z]+\.example\.json$/, /^presets\/[a-z0-9-]+\.json$/, /^test\/fixtures\//];

const FORBIDDEN = [
  { pattern: /(^|\/)(profile|campaign|companies|resume)\.json$/i, reason: "campaign config file" },
  { pattern: /\.(sqlite|sqlite-journal|sqlite-wal|db)$/i, reason: "database" },
  { pattern: /\.(pdf|docx?)$/i, reason: "resume or document" },
  { pattern: /(^|\/)\.env(\.(?!example$)[^/]+)?$/i, reason: "secrets file" },
  { pattern: /^(config|data|artifacts|resumes|documents|reports|exports|backups)\//i, reason: "data directory" },
];

const tracked = execFileSync("git", ["ls-files", "-z"], { encoding: "utf8" }).split("\0").filter(Boolean);
const offenders = tracked.flatMap((path) => {
  if (ALLOWED.some((pattern) => pattern.test(path))) return [];
  const hit = FORBIDDEN.find((rule) => rule.pattern.test(path));
  return hit ? [`${path} (${hit.reason})`] : [];
});

if (offenders.length > 0) {
  process.stderr.write(`Tracked files that look like personal data:\n${offenders.map((line) => `  ${line}`).join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(`No personal data among ${tracked.length} tracked files.\n`);
