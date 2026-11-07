import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getWorkspace } from "../config/load.js";
import { getJob } from "../db/repositories/jobs.js";
import { evaluatePostingText, evaluatePostingUrl } from "../evaluation/postingUrl.js";
import { getEvaluationReport, listEvaluationReports, saveEvaluationReport, type NarrativeInput } from "../evaluation/report.js";
import { buildEvaluationScaffold, type EvaluationScaffold } from "../evaluation/scaffold.js";
import { checkLiveness } from "../hygiene/liveness.js";
import { prepareUntrusted, wrapUntrusted } from "../text/untrusted.js";
import { AppError } from "../util/errors.js";
import { handler, ok, okText } from "./helpers.js";

/** Deep per-posting evaluation: requirement match, skill gaps, legitimacy, strategy and saved reports. */

function withDescription(body: unknown, scaffold: EvaluationScaffold, description: string, include: boolean) {
  if (!include) return ok(body);
  const untrusted = prepareUntrusted(description, 12_000);
  return okText(`${JSON.stringify(body, null, 2)}\n\n${wrapUntrusted(`${scaffold.job.company} - ${scaffold.job.title}`, untrusted)}`);
}

const NEXT_STEP =
  "Write the narrative from this scaffold only (research pay and culture with your own tools and cite sources), then call save_evaluation_report. Below 4.0, recommend against applying unless the candidate gives a reason.";

export function registerEvaluationTools(server: McpServer): void {
  server.registerTool(
    "evaluate_job",
    {
      title: "Evaluate a stored posting in depth",
      description:
        "Builds the deterministic evaluation scaffold for one posting: requirement-by-requirement evidence from the verified profile (direct, adjacent or none) with importance bands, a three-bucket skill gap, ATS keyword coverage, level fit, compensation against targets, liveness and legitimacy, interview focus areas, and a 1-5 score with per-dimension evidence and confidence. The agent writes the narrative from it and saves it with save_evaluation_report.",
      inputSchema: {
        jobId: z.string().min(1),
        checkLiveness: z.boolean().optional().describe("Confirm the posting is open first, reusing a fresh verdict (default true)."),
        resumeText: z.string().max(100_000).optional().describe("The resume being sent, to measure keyword coverage against it instead of the profile."),
        includeDescription: z.boolean().optional().describe("Append the posting text as untrusted data (default true)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    handler(async (args: { jobId: string; checkLiveness?: boolean; resumeText?: string; includeDescription?: boolean }) => {
      const workspace = getWorkspace();
      const job = getJob(workspace.db, args.jobId);
      if (!job) throw new AppError("job_not_found", `no job stored with id ${args.jobId}`);
      if (args.checkLiveness !== false) await checkLiveness(workspace, job);
      const scaffold = buildEvaluationScaffold(workspace, job.id, args.resumeText ? { resumeText: args.resumeText } : {});
      return withDescription({ scaffold, nextStep: NEXT_STEP }, scaffold, job.descriptionText, args.includeDescription !== false);
    }),
  );

  server.registerTool(
    "evaluate_posting",
    {
      title: "Evaluate a pasted posting URL or text",
      description:
        "Paste a job URL (any supported ATS, or any page publishing schema.org JobPosting metadata) or the posting text with company and title. The posting is fetched read-only, stored and evaluated like a discovered one, and its evaluation scaffold is returned. Nothing is applied to, and an employer's board is not added to companies.json.",
      inputSchema: {
        url: z.string().min(1).max(2000).optional(),
        text: z.string().max(200_000).optional().describe("The full posting text, when there is no URL to read."),
        company: z.string().min(1).max(200).optional().describe("Employer name; required with text, optional with a URL."),
        title: z.string().min(1).max(300).optional().describe("Role title; required with text."),
        location: z.string().max(300).optional(),
        includeDescription: z.boolean().optional(),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    handler(async (args: { url?: string; text?: string; company?: string; title?: string; location?: string; includeDescription?: boolean }) => {
      const workspace = getWorkspace();
      let result;
      if (args.text?.trim()) {
        if (!args.company || !args.title) throw new AppError("missing_argument", "pasted text needs company and title");
        result = evaluatePostingText(workspace, {
          text: args.text,
          company: args.company,
          title: args.title,
          ...(args.location ? { location: args.location } : {}),
          ...(args.url ? { url: args.url } : {}),
        });
      } else if (args.url?.trim()) {
        result = await evaluatePostingUrl(workspace, args.url, args.company ? { company: args.company } : {});
      } else {
        throw new AppError("missing_argument", "give a url, or text with company and title");
      }
      const job = getJob(workspace.db, result.jobId);
      const body = { jobId: result.jobId, source: result.source, ats: result.ats, companyNameSource: result.companyNameSource, scaffold: result.scaffold, nextStep: NEXT_STEP };
      return withDescription(body, result.scaffold, job?.descriptionText ?? "", args.includeDescription !== false);
    }),
  );

  server.registerTool(
    "save_evaluation_report",
    {
      title: "Save an evaluation report",
      description:
        "Saves the agent's narrative beside a fresh deterministic scaffold, writes the Markdown report to the reports folder and records it. The verdict must match the score's band (>=4.5 strong-apply, 4.0-4.4 apply, 3.5-3.9 apply-with-reason, <3.5 do-not-apply); a score 0.5 or more away from the deterministic one needs scoreDeviation. Figures in the summary or CV notes found in neither the scaffold nor the profile are flagged as unverified.",
      inputSchema: {
        jobId: z.string().min(1),
        summary: z.string().describe("Two to five sentences: the call and the main reasons, from scaffold evidence."),
        cvMatchNotes: z.string().optional(),
        strategy: z.string().optional(),
        compResearch: z
          .object({ notes: z.string(), sources: z.array(z.object({ title: z.string().optional(), url: z.string() })).optional() })
          .optional()
          .describe("Pay research with the sources it came from."),
        cultureNotes: z.string().optional(),
        interviewPlan: z.string().optional(),
        verdict: z.enum(["strong-apply", "apply", "apply-with-reason", "do-not-apply"]),
        score: z.number().min(1).max(5).optional().describe("Defaults to the deterministic score."),
        scoreDeviation: z.string().optional().describe("Why the score departs from the deterministic one."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    handler(async (args: NarrativeInput & { jobId: string }) => {
      const { jobId, ...narrative } = args;
      return ok(saveEvaluationReport(getWorkspace(), jobId, narrative));
    }),
  );

  server.registerTool(
    "get_evaluation_report",
    {
      title: "Read a saved evaluation report",
      description: "Returns a saved report by reportId, or the latest one for a jobId: score, verdict, narrative, unverified figures and the Markdown.",
      inputSchema: {
        jobId: z.string().min(1).optional(),
        reportId: z.string().min(1).optional(),
        includeScaffold: z.boolean().optional().describe("Include the stored deterministic scaffold (large)."),
      },
      annotations: { readOnlyHint: true },
    },
    handler(async (args: { jobId?: string; reportId?: string; includeScaffold?: boolean }) => {
      const report = getEvaluationReport(getWorkspace(), args);
      if (!report) throw new AppError("report_not_found", "no evaluation report matches");
      const markdown = report.markdownPath && existsSync(report.markdownPath) ? readFileSync(report.markdownPath, "utf8") : null;
      const { scaffold, ...rest } = report;
      return ok({ ...rest, ...(args.includeScaffold ? { scaffold } : {}), markdown });
    }),
  );

  server.registerTool(
    "list_evaluation_reports",
    {
      title: "List saved evaluation reports",
      description: "Lists saved reports, newest first, with score, verdict and file path.",
      inputSchema: {
        jobId: z.string().min(1).optional(),
        limit: z.number().int().min(1).max(500).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    handler(async (args: { jobId?: string; limit?: number }) => {
      const reports = listEvaluationReports(getWorkspace(), args);
      return ok({ count: reports.length, reports });
    }),
  );
}
