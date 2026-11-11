import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { WorkspacePaths } from "../config/paths.js";
import { openDatabase, type Db } from "../db/database.js";
import { getApplication, saveApplication } from "../db/repositories/applications.js";
import { appendEvent } from "../db/repositories/events.js";
import { getJob } from "../db/repositories/jobs.js";
import { buildPacket } from "../services/applications.js";
import { computePacketHash } from "../submission/packet.js";
import { AppError } from "../util/errors.js";
import { assertPassphrase, decryptBundle, encryptBundle, packFiles, unpackFiles, type BundleFile } from "./archive.js";
import { databaseNeedles, detokenizePath, HOME_TOKEN, mapStrings, rewriteTextValue, tokenizePath } from "./pathTokens.js";
import { buildSlimDatabase, rewriteDatabaseText, type SlimDatabaseReport } from "./slimDatabase.js";

/**
 * Moving a whole AUTOAPPLY_HOME to another machine, such as a cloud sandbox.
 *
 * A bundle carries the configuration, the resume source, the resume variants
 * the profile names, the fonts, the generated documents and evaluation
 * reports, and a slim copy of the database with the full application history.
 * It never carries the secrets file, screenshots, browser profiles (their
 * cookies are logins), backups or exports: only what is listed here is read.
 * Paths under the home travel as a placeholder and land under the new home.
 * Approvals never travel: an approved application arrives awaiting approval,
 * so nothing is submitted from the new machine until it is approved there.
 */

const DATABASE_ENTRY = "data/autoapply.sqlite";

/** Entries with a fixed name, written wherever the importing environment keeps that file. */
const SLOTS: Readonly<Record<string, "profile" | "campaign" | "companies" | "resumeSource" | "database">> = {
  "profile.json": "profile",
  "campaign.json": "campaign",
  "companies.json": "companies",
  "resume.json": "resumeSource",
  [DATABASE_ENTRY]: "database",
};
const JSON_ENTRIES = new Set(["profile.json", "campaign.json", "companies.json", "resume.json"]);
const FONT_FILE = /\.(ttf|otf|woff2?)$/i;
const LIVE_STATUSES = "SELECT id FROM applications WHERE status NOT IN ('submitted', 'skipped', 'failed')";

export type ExportSummary = {
  files: number;
  bytes: number;
  jobsKept: number;
  jobsLeftOut: number;
  applications: Record<string, number>;
  pathsRewritten: number;
};

export type ImportSummary = {
  files: number;
  bundleCreatedAt: string;
  pathsRewritten: number;
  approvalsVoided: number;
  backup: string | null;
  exported: Record<string, unknown>;
};

const forward = (path: string) => path.split(/[\\/]/).join("/");

/** `path` relative to `home` with forward slashes, or null when it lies outside the home. */
function entryUnder(home: string, path: string): string | null {
  const rel = relative(home, path);
  return rel.length > 0 && !rel.startsWith("..") && !isAbsolute(rel) ? forward(rel) : null;
}

function readJson(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
}

function rewriteJson(path: string, rewrite: (text: string) => string | null): Buffer {
  const next = mapStrings(readJson(path), (text) => rewrite(text) ?? text);
  return Buffer.from(`${JSON.stringify(next, null, 2)}\n`, "utf8");
}

function filesIn(dir: string, keep: (name: string) => boolean = () => true): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && keep(entry.name))
    .map((entry) => join(entry.parentPath, entry.name));
}

/** The resume variants profile.json names, as files under the home. */
function resumeFiles(paths: WorkspacePaths): string[] {
  if (!existsSync(paths.profile)) return [];
  const profile = readJson(paths.profile) as { resumes?: Array<{ path?: unknown }> };
  return (profile.resumes ?? [])
    .map((resume) => (typeof resume.path === "string" ? resume.path : ""))
    .filter((path) => path.length > 0)
    .map((path) => (isAbsolute(path) ? path : resolve(paths.home, path)))
    .filter((path) => existsSync(path));
}

type DatabaseSummary = Omit<ExportSummary, "files" | "bytes">;

/** Rewrites the slim copy's paths to the placeholder and reports what it holds. */
function tokenizeDatabase(path: string, home: string, report: SlimDatabaseReport): DatabaseSummary {
  const db = new DatabaseSync(path);
  try {
    const tokenize = (value: string) => rewriteTextValue(value, (text) => tokenizePath(text, home));
    const pathsRewritten = rewriteDatabaseText(db, databaseNeedles(home), tokenize);
    const statuses = db.prepare("SELECT status, count(*) AS n FROM applications GROUP BY status ORDER BY status").all() as Array<{ status: string; n: number }>;
    db.exec("VACUUM;");
    return {
      jobsKept: report.jobsKept,
      jobsLeftOut: report.jobsLeftOut,
      applications: Object.fromEntries(statuses.map((row) => [row.status, Number(row.n)])),
      pathsRewritten,
    };
  } finally {
    db.close();
  }
}

function slimDatabase(paths: WorkspacePaths): { bytes: Buffer; summary: DatabaseSummary } {
  const scratch = mkdtempSync(join(tmpdir(), "autoapply-bundle-"));
  try {
    const target = join(scratch, "autoapply.sqlite");
    const summary = tokenizeDatabase(target, paths.home, buildSlimDatabase(paths.database, target));
    // Read only after the connection closed, so the bytes hold everything it wrote.
    return { bytes: readFileSync(target), summary };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

export function exportHome(paths: WorkspacePaths, options: { passphrase: string; documents?: boolean; now?: Date }): { bytes: Buffer; summary: ExportSummary } {
  assertPassphrase(options.passphrase);
  const tokenize = (text: string) => tokenizePath(text, paths.home);
  const files = new Map<string, Buffer>();

  for (const [entry, slot] of Object.entries(SLOTS)) {
    if (JSON_ENTRIES.has(entry) && existsSync(paths[slot])) files.set(entry, rewriteJson(paths[slot], tokenize));
  }
  const carried = [
    ...resumeFiles(paths),
    ...filesIn(paths.fonts, (name) => FONT_FILE.test(name)),
    ...(options.documents === false ? [] : filesIn(paths.documents)),
    ...filesIn(paths.reports),
  ];
  for (const path of carried) {
    const entry = entryUnder(paths.home, path);
    if (entry && !files.has(entry)) files.set(entry, readFileSync(path));
  }

  const empty: DatabaseSummary = { jobsKept: 0, jobsLeftOut: 0, applications: {}, pathsRewritten: 0 };
  const database = existsSync(paths.database) ? slimDatabase(paths) : null;
  if (database) {
    files.set(DATABASE_ENTRY, database.bytes);
    recordExport(paths.database, files.size, options.now);
  }

  const list: BundleFile[] = [...files].map(([path, bytes]) => ({ path, bytes }));
  const bytes = list.reduce((total, file) => total + file.bytes.length, 0);
  const summary: ExportSummary = { files: list.length, bytes, ...(database?.summary ?? empty) };
  const plain = packFiles({ format: "autoapply-home", version: 1, createdAt: (options.now ?? new Date()).toISOString(), summary }, list);
  return { bytes: encryptBundle(plain, options.passphrase), summary };
}

function recordExport(databasePath: string, files: number, now: Date | undefined): void {
  const db = openDatabase(databasePath);
  try {
    appendEvent(db, "home.exported", "workspace", { files, at: (now ?? new Date()).toISOString() });
  } finally {
    db.close();
  }
}

function targetFor(entry: string, paths: WorkspacePaths): string {
  const slot = SLOTS[entry];
  return slot ? paths[slot] : join(paths.home, ...entry.split("/"));
}

function backUp(paths: WorkspacePaths, occupied: readonly string[], now: Date): string {
  const dir = join(paths.home, "backups", `pre-import-${now.toISOString().replace(/[:.]/g, "-")}`);
  mkdirSync(dir, { recursive: true });
  for (const path of occupied) {
    copyFileSync(path, join(dir, basename(path)));
    for (const suffix of ["-wal", "-shm"]) if (existsSync(`${path}${suffix}`)) copyFileSync(`${path}${suffix}`, join(dir, `${basename(path)}${suffix}`));
  }
  return dir;
}

/**
 * Re-records each unsent application's packet hash against its new paths.
 * An approval was given on the other machine, for files that now live
 * elsewhere, so it does not carry over: the application waits for approval.
 */
function relocateApplications(db: Db): number {
  let voided = 0;
  for (const { id } of db.prepare(LIVE_STATUSES).all() as Array<{ id: string }>) {
    const application = getApplication(db, id);
    const job = application ? getJob(db, application.jobId) : null;
    if (!application || !job) continue;
    const approved = application.status === "approved";
    const moved = approved ? { ...application, status: "awaiting_approval" as const, approvedAt: null } : application;
    const next = { ...moved, packetHash: computePacketHash(buildPacket(moved, job)) };
    if (approved || next.packetHash !== application.packetHash) saveApplication(db, next);
    if (approved) {
      appendEvent(db, "application.approval_voided", id, {
        reason: "imported into a new AUTOAPPLY_HOME; approvals do not travel, so approve it again on this machine",
      });
      voided += 1;
    }
  }
  return voided;
}

export function importHome(bytes: Buffer, paths: WorkspacePaths, options: { passphrase: string; force?: boolean; now?: Date }): ImportSummary {
  const { header, files } = unpackFiles(decryptBundle(bytes, options.passphrase));
  const occupied = [paths.profile, paths.campaign, paths.companies, paths.resumeSource, paths.database].filter((path) => existsSync(path));
  if (occupied.length > 0 && !options.force) {
    throw new AppError(
      "home_not_empty",
      `${paths.home} already holds a workspace (${occupied.map((path) => basename(path)).join(", ")}). Import with --force to replace it; the replaced files are backed up first.`,
    );
  }
  const backup = occupied.length > 0 ? backUp(paths, occupied, options.now ?? new Date()) : null;
  const detokenize = (text: string) => detokenizePath(text, paths.home);

  for (const file of files) {
    const target = targetFor(file.path, paths);
    mkdirSync(dirname(target), { recursive: true });
    if (file.path === DATABASE_ENTRY) {
      // A leftover write-ahead log would be replayed onto the new database.
      for (const suffix of ["-wal", "-shm", "-journal"]) rmSync(`${target}${suffix}`, { force: true });
      writeFileSync(target, file.bytes);
    } else if (JSON_ENTRIES.has(file.path)) {
      const next = mapStrings(JSON.parse(file.bytes.toString("utf8")), (text) => detokenize(text) ?? text);
      writeFileSync(target, `${JSON.stringify(next, null, 2)}\n`);
    } else {
      writeFileSync(target, file.bytes);
    }
  }

  const db = openDatabase(paths.database);
  try {
    const pathsRewritten = rewriteDatabaseText(db, [HOME_TOKEN], (value) => rewriteTextValue(value, detokenize));
    const approvalsVoided = relocateApplications(db);
    appendEvent(db, "home.imported", "workspace", { bundleCreatedAt: header.createdAt, files: files.length, pathsRewritten, approvalsVoided });
    return { files: files.length, bundleCreatedAt: header.createdAt, pathsRewritten, approvalsVoided, backup, exported: header.summary };
  } finally {
    db.close();
  }
}
