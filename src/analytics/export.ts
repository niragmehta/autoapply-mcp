import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Workspace } from "../config/load.js";
import type { Db } from "../db/database.js";
import { listOutcomeHistories } from "../db/repositories/followups.js";
import { AppError } from "../util/errors.js";

/**
 * The application tracker as a file a person can open: CSV for a
 * spreadsheet, Markdown for notes. Written to `paths.exports` with a
 * timestamped name, never over an earlier export.
 *
 * Company names and titles come from job boards, so every text cell is
 * neutralised against spreadsheet formula injection: a cell that starts with
 * = + - @ (or a tab or carriage return) is prefixed with an apostrophe, which
 * spreadsheets display as text instead of evaluating.
 */

type TrackerFormat = "csv" | "markdown";

type TrackerRow = {
  company: string;
  title: string;
  ats: string;
  track: string;
  tier: string;
  score: number | null;
  status: string;
  submitted_at: string;
  latest_outcome: string;
  latest_outcome_at: string;
  url: string;
};

const TRACKER_COLUMNS: ReadonlyArray<keyof TrackerRow> = [
  "company",
  "title",
  "ats",
  "track",
  "tier",
  "score",
  "status",
  "submitted_at",
  "latest_outcome",
  "latest_outcome_at",
  "url",
];

type Row = Record<string, unknown>;

export function trackerRows(db: Db): TrackerRow[] {
  const rows = db
    .prepare(
      `SELECT a.id, a.status, a.submitted_at, a.created_at, j.company_name, j.title, j.ats, j.url,
              e.track_id, e.tier, e.score
       FROM applications a JOIN jobs j ON j.id = a.job_id LEFT JOIN evaluations e ON e.job_id = a.job_id
       ORDER BY (a.submitted_at IS NULL), a.submitted_at DESC, a.created_at DESC`,
    )
    .all() as Row[];
  const histories = listOutcomeHistories(db);
  return rows.map((row) => {
    const latest = (histories.get(String(row.id)) ?? []).at(-1);
    return {
      company: String(row.company_name ?? ""),
      title: String(row.title ?? ""),
      ats: String(row.ats ?? ""),
      track: row.track_id ? String(row.track_id) : "",
      tier: row.tier ? String(row.tier) : "",
      score: row.score === null || row.score === undefined ? null : Math.round(Number(row.score) * 10) / 10,
      status: String(row.status ?? ""),
      submitted_at: row.submitted_at ? String(row.submitted_at) : "",
      latest_outcome: latest?.status ?? "",
      latest_outcome_at: latest?.notedAt ?? "",
      url: String(row.url ?? ""),
    };
  });
}

/** A formula trigger, also behind leading whitespace, which some spreadsheets skip before parsing. */
const FORMULA_START = /^(?:[\t\r]|\s*[=+\-@])/;

/** Makes a value safe to open in a spreadsheet: text that would start a formula is prefixed with '. */
export function neutralizeFormula(value: string): string {
  return FORMULA_START.test(value) ? `'${value}` : value;
}

/** One CSV field per RFC 4180, after formula neutralisation for text. */
export function csvCell(value: string | number | null): string {
  if (value === null) return "";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  const safe = neutralizeFormula(value);
  return /[",\r\n]|^\s|\s$/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv(rows: readonly TrackerRow[]): string {
  const lines = [TRACKER_COLUMNS.join(","), ...rows.map((row) => TRACKER_COLUMNS.map((column) => csvCell(row[column])).join(","))];
  // The byte order mark lets spreadsheet software read accented company names as UTF-8.
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}

export function markdownCell(value: string | number | null): string {
  if (value === null) return "";
  return String(value).replace(/\\/g, "\\\\").replace(/\|/g, "\\|").replace(/\s+/g, " ").trim();
}

function toMarkdown(rows: readonly TrackerRow[], generatedAt: Date = new Date()): string {
  const header = `| ${TRACKER_COLUMNS.join(" | ")} |`;
  const rule = `| ${TRACKER_COLUMNS.map(() => "---").join(" | ")} |`;
  const body = rows.map((row) => `| ${TRACKER_COLUMNS.map((column) => markdownCell(row[column])).join(" | ")} |`);
  return [`# Application tracker`, "", `Exported ${generatedAt.toISOString()} - ${rows.length} applications.`, "", header, rule, ...body, ""].join("\n");
}

function stamp(now: Date): string {
  return now.toISOString().replace(/\.\d{3}Z$/, "").replace(/[-:]/g, "").replace("T", "-");
}

type TrackerExport = { path: string; format: TrackerFormat; rows: number };

export function exportTracker(workspace: Workspace, format: TrackerFormat, now: Date = new Date()): TrackerExport {
  if (format !== "csv" && format !== "markdown") throw new AppError("invalid_format", `format must be csv or markdown (got ${String(format)})`);
  const rows = trackerRows(workspace.db);
  const text = format === "csv" ? toCsv(rows) : toMarkdown(rows, now);
  mkdirSync(workspace.paths.exports, { recursive: true });
  const extension = format === "csv" ? "csv" : "md";
  const base = `tracker-${stamp(now)}`;
  let path = join(workspace.paths.exports, `${base}.${extension}`);
  for (let attempt = 2; existsSync(path); attempt += 1) path = join(workspace.paths.exports, `${base}-${attempt}.${extension}`);
  writeFileSync(path, text, "utf8");
  return { path, format, rows: rows.length };
}
