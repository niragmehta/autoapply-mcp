import { readFileSync, existsSync } from "node:fs";
import type { ZodType } from "zod";
import { CampaignSchema, CompanyListSchema, type Campaign, type Company } from "../domain/campaign.js";
import { ProfileSchema, type Profile } from "../domain/profile.js";
import { AppError } from "../util/errors.js";
import { openDatabase, type Db } from "../db/database.js";
import { resolvePaths, type WorkspacePaths } from "./paths.js";

/** Loads and validates configuration, failing fast with actionable messages. */

function readJson(path: string, label: string): unknown {
  if (!existsSync(path)) {
    throw new AppError("config_missing", `${label} not found at ${path}. See docs/CONFIGURATION.md or run the "doctor" script.`, {
      path,
      label,
    });
  }
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    throw new AppError("config_unreadable", `cannot read ${label} at ${path}: ${String(error)}`, { path });
  }
  try {
    // Windows editors and PowerShell's UTF8 encoder prepend a byte order mark.
    // JSON.parse rejects it, and the resulting "unexpected token" points at
    // what looks like a perfectly good opening brace, so strip it rather than
    // let a routine hand-edit look like a corrupt file.
    return JSON.parse(raw.replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new AppError("config_invalid_json", `${label} at ${path} is not valid JSON: ${String(error)}`, { path });
  }
}

function parseWith<T>(schema: ZodType<T>, value: unknown, label: string, path: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 8)
      .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("\n");
    throw new AppError("config_invalid", `${label} at ${path} failed validation:\n${issues}`, { path });
  }
  return result.data;
}

export function loadProfile(path: string): Profile {
  return parseWith(ProfileSchema, readJson(path, "profile"), "profile", path);
}

export function loadCampaign(path: string): Campaign {
  return parseWith(CampaignSchema, readJson(path, "campaign"), "campaign", path);
}

export function loadCompanies(path: string): Company[] {
  const parsed = parseWith(CompanyListSchema, readJson(path, "companies"), "companies", path);
  return parsed.companies;
}

export type Workspace = {
  paths: WorkspacePaths;
  profile: Profile;
  campaign: Campaign;
  companies: Company[];
  db: Db;
};

let cached: Workspace | null = null;

/** Returns the loaded workspace, opening the database on first use. */
export function getWorkspace(): Workspace {
  if (cached) return cached;
  const paths = resolvePaths();
  const workspace: Workspace = {
    paths,
    profile: loadProfile(paths.profile),
    campaign: loadCampaign(paths.campaign),
    companies: loadCompanies(paths.companies),
    db: openDatabase(paths.database),
  };
  cached = workspace;
  return workspace;
}

/** Drops the cache so configuration edits take effect without a restart. */
export function reloadWorkspace(): Workspace {
  closeWorkspace();
  return getWorkspace();
}

/** Closes the database handle and clears the cache. */
export function closeWorkspace(): void {
  try {
    cached?.db.close();
  } catch {
    // A already-closed handle is not an error worth surfacing.
  }
  cached = null;
}

export function resetWorkspaceCache(): void {
  closeWorkspace();
}
