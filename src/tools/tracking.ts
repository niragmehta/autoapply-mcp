import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getWorkspace, reloadWorkspace } from "../config/load.js";
import { getApplication, listApplications, listOutcomes, recordOutcome } from "../db/repositories/applications.js";
import { appendEvent, listEvents } from "../db/repositories/events.js";
import { getJob } from "../db/repositories/jobs.js";
import { AppError } from "../util/errors.js";
import { handler, ok } from "./helpers.js";

/** Outcome tracking, auditing and configuration reload. */

const OUTCOME_STATUSES = [
  "acknowledged",
  "recruiter_screen",
  "interview",
  "offer",
  "rejected",
  "ghosted",
  "withdrawn",
] as const;

export function registerTrackingTools(server: McpServer): void {
  server.registerTool(
    "record_outcome",
    {
      title: "Record an application outcome",
      description: "Appends an outcome to an application's history so conversion rates can be measured per track, tier and company.",
      inputSchema: {
        applicationId: z.string().min(1),
        status: z.enum(OUTCOME_STATUSES),
        detail: z.string().optional(),
      },
      annotations: { readOnlyHint: false },
    },
    handler(async (args: { applicationId: string; status: string; detail?: string }) => {
      const workspace = getWorkspace();
      const application = getApplication(workspace.db, args.applicationId);
      if (!application) throw new AppError("application_not_found", `no application ${args.applicationId}`);
      recordOutcome(workspace.db, application.id, args.status, args.detail ?? "");
      appendEvent(workspace.db, "outcome.recorded", application.id, { status: args.status });
      return ok({
        applicationId: application.id,
        history: listOutcomes(workspace.db, application.id),
      });
    }),
  );

  server.registerTool(
    "list_applications",
    {
      title: "List applications",
      description: "Lists applications with their status, target role and outcome history.",
      inputSchema: {
        status: z
          .enum(["drafted", "awaiting_approval", "approved", "submitted", "failed", "skipped", "needs_human"])
          .optional(),
        limit: z.number().int().positive().max(500).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    handler(async (args: { status?: string; limit?: number }) => {
      const workspace = getWorkspace();
      const applications = listApplications(workspace.db, args.status, args.limit ?? 100);
      return ok({
        count: applications.length,
        applications: applications.map((application) => {
          const job = getJob(workspace.db, application.jobId);
          return {
            applicationId: application.id,
            status: application.status,
            company: job?.companyName ?? "unknown",
            title: job?.title ?? "unknown",
            url: job?.url ?? "",
            resumeId: application.resumeId,
            createdAt: application.createdAt,
            submittedAt: application.submittedAt,
            blockedQuestions: application.blockedQuestions,
            outcomes: listOutcomes(workspace.db, application.id),
          };
        }),
      });
    }),
  );

  server.registerTool(
    "audit_log",
    {
      title: "Read the audit log",
      description: "Returns recent recorded events: discovery runs, approvals, submissions and blocked attempts. Values are redacted.",
      inputSchema: {
        type: z.string().optional().describe("Filter by event type, e.g. 'submission.submitted'."),
        limit: z.number().int().positive().max(500).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    handler(async (args: { type?: string; limit?: number }) => {
      const workspace = getWorkspace();
      return ok({ events: listEvents(workspace.db, args.type, args.limit ?? 50) });
    }),
  );

  server.registerTool(
    "reload_config",
    {
      title: "Reload configuration",
      description: "Re-reads profile.json, campaign.json and companies.json so edits take effect without restarting the server.",
      inputSchema: {},
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    handler(async () => {
      const workspace = reloadWorkspace();
      return ok({
        campaign: workspace.campaign.name,
        tracks: workspace.campaign.tracks.map((track) => track.id),
        companies: workspace.companies.length,
        resumes: workspace.profile.resumes.map((resume) => resume.id),
        submissionMode: workspace.campaign.submission.mode,
        paths: workspace.paths,
      });
    }),
  );
}
