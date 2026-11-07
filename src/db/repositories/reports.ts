import type { Db } from "../database.js";
import { jsonOrDefault } from "../database.js";

/** Saved evaluation reports: the server's scaffold beside the agent's narrative. */

export type StoredReport = {
  id: string;
  jobId: string;
  /** Sequential report number, also the Markdown file's prefix. */
  number: number;
  createdAt: string;
  score: number | null;
  verdict: string;
  scaffold: unknown;
  narrative: unknown;
  /** Figures in the narrative that neither the scaffold nor the profile contains. */
  unverifiedFigures: string[];
  markdownPath: string;
};

export type ReportSummary = Omit<StoredReport, "scaffold" | "narrative"> & {
  company: string;
  title: string;
};

type Row = Record<string, unknown>;

function rowToReport(row: Row): StoredReport {
  return {
    id: String(row.id),
    jobId: String(row.job_id),
    number: Number(row.number ?? 0),
    createdAt: String(row.created_at),
    score: row.score === null || row.score === undefined ? null : Number(row.score),
    verdict: String(row.verdict ?? ""),
    scaffold: jsonOrDefault<unknown>(row.scaffold_json, {}),
    narrative: jsonOrDefault<unknown>(row.narrative_json, {}),
    unverifiedFigures: jsonOrDefault<string[]>(row.unverified_json, []),
    markdownPath: String(row.markdown_path ?? ""),
  };
}

export function insertReport(db: Db, report: StoredReport): void {
  db.prepare(`
    INSERT INTO evaluation_reports (
      id, job_id, number, created_at, score, verdict, scaffold_json, narrative_json, unverified_json, markdown_path
    ) VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(
    report.id,
    report.jobId,
    report.number,
    report.createdAt,
    report.score,
    report.verdict,
    JSON.stringify(report.scaffold),
    JSON.stringify(report.narrative),
    JSON.stringify(report.unverifiedFigures),
    report.markdownPath,
  );
}

export function getReport(db: Db, id: string): StoredReport | null {
  const row = db.prepare("SELECT * FROM evaluation_reports WHERE id = ?").get(id) as Row | undefined;
  return row ? rowToReport(row) : null;
}

export function latestReportForJob(db: Db, jobId: string): StoredReport | null {
  const row = db
    .prepare("SELECT * FROM evaluation_reports WHERE job_id = ? ORDER BY created_at DESC, number DESC LIMIT 1")
    .get(jobId) as Row | undefined;
  return row ? rowToReport(row) : null;
}

export function listReports(db: Db, options: { limit?: number; jobId?: string } = {}): ReportSummary[] {
  const limit = options.limit ?? 50;
  const rows = (options.jobId
    ? db
        .prepare(`
          SELECT r.id, r.job_id, r.number, r.created_at, r.score, r.verdict, r.unverified_json, r.markdown_path,
                 j.company_name, j.title
          FROM evaluation_reports r LEFT JOIN jobs j ON j.id = r.job_id
          WHERE r.job_id = ? ORDER BY r.created_at DESC, r.number DESC LIMIT ?
        `)
        .all(options.jobId, limit)
    : db
        .prepare(`
          SELECT r.id, r.job_id, r.number, r.created_at, r.score, r.verdict, r.unverified_json, r.markdown_path,
                 j.company_name, j.title
          FROM evaluation_reports r LEFT JOIN jobs j ON j.id = r.job_id
          ORDER BY r.created_at DESC, r.number DESC LIMIT ?
        `)
        .all(limit)) as Row[];
  return rows.map((row) => {
    const { scaffold: _scaffold, narrative: _narrative, ...rest } = rowToReport(row);
    return { ...rest, company: String(row.company_name ?? ""), title: String(row.title ?? "") };
  });
}

/** Highest report number in use, so the next report can take the one after it. */
export function maxReportNumber(db: Db): number {
  const row = db.prepare("SELECT MAX(number) AS top FROM evaluation_reports").get() as Row | undefined;
  return Number(row?.top ?? 0);
}
