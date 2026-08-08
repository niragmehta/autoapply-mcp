import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";
import { CompanyListSchema, CompanySchema, type Company } from "../domain/campaign.js";
import { AppError } from "../util/errors.js";

/**
 * Writes companies.json.
 *
 * Board lists grow as new employers are found, and the file is hand-edited too,
 * so writes preserve whatever is already there and never rewrite unrelated
 * entries. The write is staged through a temporary file and renamed, because a
 * process dying mid-write would otherwise leave the campaign with a truncated
 * board list and no way to discover anything.
 */

/** Strips a byte-order mark, which some Windows editors add and JSON.parse rejects. */
function readText(path: string): string {
  return readFileSync(path, "utf8").replace(/^\uFEFF/, "");
}

export function readCompanyFile(path: string): Company[] {
  if (!existsSync(path)) return [];
  const parsed = CompanyListSchema.safeParse(JSON.parse(readText(path)));
  if (!parsed.success) {
    throw new AppError("config_invalid", `companies file at ${path} failed validation`, { path });
  }
  return parsed.data.companies;
}

function writeCompanyFile(path: string, companies: Company[]): void {
  const body = `${JSON.stringify({ version: 1, companies }, null, 2)}\n`;
  const staged = `${path}.tmp`;
  // UTF-8 without a BOM: Node writes none by default, and adding one here would
  // make the file unreadable to the loader on the next run.
  writeFileSync(staged, body, "utf8");
  renameSync(staged, path);
}

export type AddBoardResult = {
  action: "added" | "updated";
  company: Company;
  total: number;
};

/**
 * Adds a verified board, or updates the existing entry for that company.
 *
 * Matching is by name, case-insensitively, so re-adding a company corrects its
 * board rather than silently creating a duplicate that would then be fetched
 * twice and surface every posting twice in the queue.
 */
export function upsertCompany(path: string, candidate: unknown): AddBoardResult {
  const company = CompanySchema.parse(candidate);
  const companies = readCompanyFile(path);
  const index = companies.findIndex((entry) => entry.name.toLowerCase() === company.name.toLowerCase());

  const next = [...companies];
  const action: AddBoardResult["action"] = index >= 0 ? "updated" : "added";
  if (index >= 0) next[index] = company;
  else next.push(company);

  writeCompanyFile(path, next);
  return { action, company, total: next.length };
}
