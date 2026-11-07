import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import type { Workspace } from "../config/load.js";
import { appendEvent } from "../db/repositories/events.js";
import { getJob } from "../db/repositories/jobs.js";
import {
  getReport,
  insertReport,
  latestReportForJob,
  listReports,
  maxReportNumber,
  type ReportSummary,
  type StoredReport,
} from "../db/repositories/reports.js";
import { extractFigures, sameValue, withoutTimestamps } from "../text/figures.js";
import { AppError } from "../util/errors.js";
import { newId } from "../util/hash.js";
import { renderReportMarkdown } from "./markdown.js";
import { buildEvaluationScaffold, type EvaluationScaffold } from "./scaffold.js";
import { verdictFor, VERDICT_LABELS } from "./scorecard.js";

/**
 * Saving the agent's narrative beside the server's scaffold.
 *
 * The narrative is validated, its score must sit in the band its verdict
 * names, and a score that departs from the deterministic one by half a point
 * or more needs a stated reason. Figures in the summary and CV-match notes
 * that appear in neither the scaffold nor the profile are recorded as
 * unverified, so an invented number is visible in the stored report.
 */

const SourceSchema = z.object({ title: z.string().trim().max(200).optional(), url: z.url().max(2000) });

const NarrativeSchema = z.object({
  summary: z.string().trim().min(20).max(4000),
  cvMatchNotes: z.string().trim().max(8000).optional(),
  strategy: z.string().trim().max(6000).optional(),
  compResearch: z
    .object({ notes: z.string().trim().min(1).max(6000), sources: z.array(SourceSchema).max(20).default([]) })
    .optional(),
  cultureNotes: z.string().trim().max(6000).optional(),
  interviewPlan: z.string().trim().max(8000).optional(),
  verdict: z.enum(["strong-apply", "apply", "apply-with-reason", "do-not-apply"]),
  score: z.number().min(1).max(5).optional(),
  /** Required when `score` departs from the deterministic score by 0.5 or more. */
  scoreDeviation: z.string().trim().min(10).max(2000).optional(),
});
export type Narrative = z.infer<typeof NarrativeSchema>;
export type NarrativeInput = z.input<typeof NarrativeSchema>;

const DEVIATION_LIMIT = 0.5;

/**
 * Figures quoted in the text that no number in the known corpus supports,
 * whatever their kind. Machine timestamps are dropped from both sides: the
 * corpus carries the report's own, whose minutes would otherwise vouch for an
 * invented figure.
 */
export function unverifiedFigures(text: string, corpus: string): string[] {
  const known = extractFigures(withoutTimestamps(corpus)).map((figure) => figure.value);
  const flagged = extractFigures(withoutTimestamps(text)).filter((figure) => !known.some((value) => sameValue(value, figure.value)));
  return [...new Set(flagged.map((figure) => figure.raw))];
}

export function slugify(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug.length > 0 ? slug : "company";
}

function highestFileNumber(directory: string): number {
  try {
    return readdirSync(directory)
      .map((name) => /^(\d{3,})-/.exec(name)?.[1])
      .filter((value): value is string => value !== undefined)
      .reduce((top, value) => Math.max(top, Number(value)), 0);
  } catch {
    return 0;
  }
}

/** Writes the Markdown under the next free number; a taken name moves on rather than overwriting. */
function writeReportFile(directory: string, company: string, date: string, start: number, render: (number: number) => string): { number: number; path: string } {
  mkdirSync(directory, { recursive: true });
  for (let number = start; number < start + 20; number += 1) {
    const path = join(directory, `${String(number).padStart(3, "0")}-${slugify(company)}-${date}.md`);
    try {
      writeFileSync(path, render(number), { encoding: "utf8", flag: "wx" });
      return { number, path };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
  }
  throw new AppError("report_number_exhausted", `could not find a free report number in ${directory}`);
}

type SavedReport = {
  reportId: string;
  number: number;
  markdownPath: string;
  score: number;
  verdict: string;
  verdictLabel: string;
  deterministicScore: number;
  unverifiedFigures: string[];
};

export function saveEvaluationReport(workspace: Workspace, jobId: string, input: NarrativeInput, options: { now?: Date } = {}): SavedReport {
  const parsed = NarrativeSchema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 5).map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`);
    throw new AppError("invalid_narrative", `narrative failed validation: ${issues.join("; ")}`);
  }
  const narrative = parsed.data;
  const job = getJob(workspace.db, jobId);
  if (!job) throw new AppError("job_not_found", `no job stored with id ${jobId}`);
  const now = options.now ?? new Date();
  const scaffold: EvaluationScaffold = buildEvaluationScaffold(workspace, jobId, { now });
  const deterministic = scaffold.scorecard.globalScore;

  const score = narrative.score ?? deterministic;
  if (Math.abs(score - deterministic) >= DEVIATION_LIMIT && !narrative.scoreDeviation) {
    throw new AppError(
      "score_deviation_unexplained",
      `score ${score} departs from the deterministic ${deterministic} by ${Math.round(Math.abs(score - deterministic) * 10) / 10}; explain why in scoreDeviation`,
    );
  }
  const band = verdictFor(score);
  if (band !== narrative.verdict) {
    throw new AppError("verdict_mismatch", `a score of ${score} falls in "${VERDICT_LABELS[band]}" (${band}), not ${narrative.verdict}`);
  }

  const corpus = [JSON.stringify(scaffold), JSON.stringify(workspace.profile), job.descriptionText].join("\n");
  const unverified = unverifiedFigures([narrative.summary, narrative.cvMatchNotes ?? ""].join("\n"), corpus);
  const date = now.toISOString().slice(0, 10);
  const start = Math.max(maxReportNumber(workspace.db), highestFileNumber(workspace.paths.reports)) + 1;
  const { number, path } = writeReportFile(workspace.paths.reports, job.companyName, date, start, (reportNumber) =>
    renderReportMarkdown({ number: reportNumber, date, scaffold, narrative, score, verdict: band, unverifiedFigures: unverified, descriptionText: job.descriptionText }),
  );

  const report: StoredReport = {
    id: newId("rpt"),
    jobId,
    number,
    createdAt: now.toISOString(),
    score,
    verdict: band,
    scaffold,
    narrative,
    unverifiedFigures: unverified,
    markdownPath: path,
  };
  insertReport(workspace.db, report);
  appendEvent(workspace.db, "evaluation.report_saved", jobId, { reportId: report.id, number, score, verdict: band, unverified: unverified.length });
  return {
    reportId: report.id,
    number,
    markdownPath: path,
    score,
    verdict: band,
    verdictLabel: VERDICT_LABELS[band],
    deterministicScore: deterministic,
    unverifiedFigures: unverified,
  };
}

export function getEvaluationReport(workspace: Workspace, query: { jobId?: string; reportId?: string }): StoredReport | null {
  if (query.reportId) return getReport(workspace.db, query.reportId);
  if (query.jobId) return latestReportForJob(workspace.db, query.jobId);
  throw new AppError("missing_argument", "give a jobId or a reportId");
}

export function listEvaluationReports(workspace: Workspace, options: { limit?: number; jobId?: string } = {}): ReportSummary[] {
  return listReports(workspace.db, options);
}
