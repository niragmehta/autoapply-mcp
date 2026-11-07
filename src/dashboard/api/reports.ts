import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { z } from "zod";
import { getJob } from "../../db/repositories/jobs.js";
import { getEvaluationReport, listEvaluationReports } from "../../evaluation/report.js";
import { findRepostClusters } from "../../hygiene/reposts.js";
import { AppError } from "../../util/errors.js";
import { storedFileInside } from "../queries/files.js";
import { parseParams, parseQuery, type Router } from "../router.js";
import { IdParams, queryInt, queryText } from "./shared.js";

/**
 * Reports: stored evaluation reports and their Markdown, roles reposted under
 * new ids (a weak ghost-job signal), and the do-not-apply list. All read-only.
 */

const MARKDOWN_LIMIT = 400_000;
const REPOST_MEMBERS_SHOWN = 10;

const ReportsQuery = z.object({ jobId: queryText(), limit: queryInt(1, 500, 100) });

const RepostsQuery = z.object({
  windowDays: z.preprocess((value) => (value === "" ? undefined : value), z.coerce.number().int().min(1).max(365).optional()),
  minPostings: z.preprocess((value) => (value === "" ? undefined : value), z.coerce.number().int().min(2).max(20).optional()),
  company: queryText(),
  limit: queryInt(1, 200, 50),
});

function readMarkdown(reportsDir: string, path: string): { markdown: string | null; markdownNote: string | null } {
  const file = storedFileInside(reportsDir, path, [".md"]);
  if (!file) return { markdown: null, markdownNote: path ? "The report file is missing or outside the reports folder." : "No Markdown file was written." };
  const text = readFileSync(file, "utf8");
  return text.length > MARKDOWN_LIMIT
    ? { markdown: text.slice(0, MARKDOWN_LIMIT), markdownNote: "The report is long; the rest is in the file." }
    : { markdown: text, markdownNote: null };
}

export function registerRoutes(router: Router): void {
  router.get("/api/reports", (request) => {
    const query = parseQuery(ReportsQuery, request);
    const reports = listEvaluationReports(request.ctx.workspace(), { jobId: query.jobId, limit: query.limit }).map(
      ({ markdownPath, ...report }) => ({ ...report, fileName: markdownPath ? basename(markdownPath) : null }),
    );
    return { count: reports.length, reports };
  });

  router.get("/api/reports/:id", (request) => {
    const { id } = parseParams(IdParams, request);
    const workspace = request.ctx.workspace();
    const report = getEvaluationReport(workspace, { reportId: id });
    if (!report) throw new AppError("report_not_found", `no evaluation report ${id}`);
    const job = getJob(workspace.db, report.jobId);
    return {
      report: {
        id: report.id,
        jobId: report.jobId,
        number: report.number,
        createdAt: report.createdAt,
        score: report.score,
        verdict: report.verdict,
        narrative: report.narrative,
        unverifiedFigures: report.unverifiedFigures,
        fileName: report.markdownPath ? basename(report.markdownPath) : null,
      },
      job: job ? { id: job.id, company: job.companyName, title: job.title, url: job.url } : null,
      ...readMarkdown(workspace.paths.reports, report.markdownPath),
    };
  });

  router.get("/api/reposts", (request) => {
    const query = parseQuery(RepostsQuery, request);
    const workspace = request.ctx.workspace();
    const policy = workspace.campaign.hygiene.reposts;
    const windowDays = query.windowDays ?? policy.windowDays;
    const minPostings = query.minPostings ?? policy.minPostings;
    const clusters = findRepostClusters(workspace.db, { windowDays, minPostings, ...(query.company ? { company: query.company } : {}) });
    return {
      windowDays,
      minPostings,
      count: clusters.length,
      clusters: clusters.slice(0, query.limit).map((cluster) => ({ ...cluster, members: cluster.members.slice(0, REPOST_MEMBERS_SHOWN) })),
      truncated: Math.max(0, clusters.length - query.limit),
    };
  });

  router.get("/api/blacklist", ({ ctx }) => {
    const entries = ctx.workspace().campaign.hygiene.blacklist;
    return { count: entries.length, entries };
  });
}
