import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getWorkspace } from "../config/load.js";
import { appendEvent } from "../db/repositories/events.js";
import { countJobs, listQueue, rejectionBreakdown, tierBreakdown, upsertJobs, getJob, getEvaluation } from "../db/repositories/jobs.js";
import { countSubmittedSince, listApplications } from "../db/repositories/applications.js";
import { evaluateAndStore } from "../pipeline.js";
import { discoverJobs, resolveBoards } from "../sources/registry.js";
import { startOfDayIso } from "../submission/guards.js";
import { prepareUntrusted, wrapUntrusted } from "../text/untrusted.js";
import { AppError } from "../util/errors.js";
import { handler, ok, okText } from "./helpers.js";

/** Discovery, ranking and campaign reporting tools. */

export function registerDiscoveryTools(server: McpServer): void {
  server.registerTool(
    "discover_jobs",
    {
      title: "Discover and rank jobs",
      description:
        "Fetches every configured ATS board, normalizes the postings, applies the campaign's hard gates, scores what survives, and stores the results. Read-only against employers: no application is created or sent.",
      inputSchema: {
        companies: z.array(z.string()).optional().describe("Optional company-name filter; defaults to every active board."),
        includeIssues: z.boolean().optional().describe("Include per-board fetch failures in the response."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    handler(async (args: { companies?: string[]; includeIssues?: boolean }) => {
      const workspace = getWorkspace();
      const selected = args.companies?.length
        ? workspace.companies.filter((company) =>
            args.companies!.some((name) => name.toLowerCase() === company.name.toLowerCase()),
          )
        : workspace.companies;

      if (selected.length === 0) {
        throw new AppError("no_companies", "no matching companies configured; check companies.json");
      }

      const discovery = await discoverJobs(selected);
      const stored = upsertJobs(workspace.db, discovery.jobs);
      const summary = evaluateAndStore(workspace.db, discovery.jobs, workspace.campaign, workspace.profile);

      appendEvent(workspace.db, "discovery.run", "campaign", {
        boards: discovery.boardsQueried,
        found: discovery.jobs.length,
        accepted: summary.accepted,
      });

      return ok({
        boardsQueried: discovery.boardsQueried,
        postingsFetched: discovery.jobs.length,
        newPostings: stored.inserted,
        refreshedPostings: stored.updated,
        evaluation: summary,
        totalStoredJobs: countJobs(workspace.db),
        boardIssues: args.includeIssues === false ? undefined : discovery.issues,
      });
    }),
  );

  server.registerTool(
    "resolve_company_board",
    {
      title: "Find a company's ATS board",
      description:
        "Probes Greenhouse, Lever and Ashby for a company's public board slug. Board tokens are not published centrally, so guesses must be verified before being added to companies.json.",
      inputSchema: {
        companyName: z.string().min(1).describe("Company name, for example 'Anthropic'."),
        extraSlugs: z.array(z.string()).optional().describe("Additional slug candidates to probe."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    handler(async (args: { companyName: string; extraSlugs?: string[] }) => {
      const matches = await resolveBoards(args.companyName, args.extraSlugs ?? []);
      return ok({
        companyName: args.companyName,
        matches,
        hint:
          matches.length === 0
            ? "No public board found. The company may use Workday, SmartRecruiters or a custom system, which this server does not support."
            : "Add the chosen match to companies.json as { name, ats, board }.",
      });
    }),
  );

  server.registerTool(
    "list_queue",
    {
      title: "List the ranked application queue",
      description:
        "Returns gated-in jobs ordered by score. Roles already applied to are excluded by fingerprint, so the same posting on a second board is not surfaced twice.",
      inputSchema: {
        minScore: z.number().optional(),
        tiers: z.array(z.enum(["A", "B", "C"])).optional(),
        trackId: z.string().optional(),
        limit: z.number().int().positive().max(200).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    handler(async (args: { minScore?: number; tiers?: string[]; trackId?: string; limit?: number }) => {
      const workspace = getWorkspace();
      const items = listQueue(workspace.db, {
        minScore: args.minScore ?? workspace.campaign.scoring.thresholds.tierC,
        tiers: args.tiers,
        trackId: args.trackId ?? null,
        limit: args.limit ?? 25,
      });

      return ok({
        count: items.length,
        jobs: items.map((item) => ({
          jobId: item.job.id,
          score: item.evaluation.score,
          tier: item.evaluation.tier,
          track: item.evaluation.trackId,
          company: item.job.companyName,
          title: item.job.title,
          location: item.job.locationsRaw.join(" | "),
          locationClass: item.job.locationClass,
          workplaceType: item.job.workplaceType,
          compensation: item.job.compensation?.raw ?? "not published",
          postedAt: item.job.postedAt,
          url: item.job.url,
          flags: item.evaluation.flags,
        })),
      });
    }),
  );

  server.registerTool(
    "explain_job",
    {
      title: "Explain a job evaluation",
      description:
        "Returns the full gate result, score breakdown with quoted evidence, and the posting text wrapped as untrusted data.",
      inputSchema: {
        jobId: z.string().min(1),
        includeDescription: z.boolean().optional(),
      },
      annotations: { readOnlyHint: true },
    },
    handler(async (args: { jobId: string; includeDescription?: boolean }) => {
      const workspace = getWorkspace();
      const job = getJob(workspace.db, args.jobId);
      if (!job) throw new AppError("job_not_found", `no job stored with id ${args.jobId}`);
      const evaluation = getEvaluation(workspace.db, args.jobId);

      const body = {
        job: {
          id: job.id,
          company: job.companyName,
          title: job.title,
          locations: job.locationsRaw,
          locationClass: job.locationClass,
          country: job.country,
          workplaceType: job.workplaceType,
          compensation: job.compensation,
          postedAt: job.postedAt,
          url: job.url,
          applyUrl: job.applyUrl,
        },
        evaluation,
      };

      if (args.includeDescription === false) return ok(body);
      const untrusted = prepareUntrusted(job.descriptionText, 12_000);
      return okText(
        `${JSON.stringify(body, null, 2)}\n\n${wrapUntrusted(`${job.companyName} - ${job.title}`, untrusted)}`,
      );
    }),
  );

  server.registerTool(
    "campaign_status",
    {
      title: "Campaign status and metrics",
      description:
        "Summarizes progress toward the application target, pipeline health, tier distribution and the most common rejection reasons.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    handler(async () => {
      const workspace = getWorkspace();
      const applications = listApplications(workspace.db, undefined, 1000);
      const byStatus = applications.reduce<Record<string, number>>((acc, application) => {
        acc[application.status] = (acc[application.status] ?? 0) + 1;
        return acc;
      }, {});

      const queue = listQueue(workspace.db, { minScore: workspace.campaign.scoring.thresholds.tierC, limit: 1000 });
      const submitted = applications.filter((application) => application.status === "submitted");

      // Compare the campaign's intended track mix with what is actually queued
      // and submitted, so the mix can be steered rather than drifting.
      const queueByTrack = queue.reduce<Record<string, number>>((acc, item) => {
        const track = item.evaluation.trackId ?? "unassigned";
        acc[track] = (acc[track] ?? 0) + 1;
        return acc;
      }, {});
      const trackAllocation = workspace.campaign.tracks.map((track) => ({
        trackId: track.id,
        targetShare: track.allocation,
        targetApplications: Math.round(track.allocation * workspace.campaign.targetApplications),
        queued: queueByTrack[track.id] ?? 0,
      }));

      return ok({
        campaign: workspace.campaign.name,
        target: workspace.campaign.targetApplications,
        submitted: submitted.length,
        remainingToTarget: Math.max(0, workspace.campaign.targetApplications - submitted.length),
        submittedToday: countSubmittedSince(workspace.db, startOfDayIso()),
        dailyLimit: workspace.campaign.submission.dailyLimit,
        submissionMode: workspace.campaign.submission.mode,
        applicationsByStatus: byStatus,
        storedJobs: countJobs(workspace.db),
        acceptedByTier: tierBreakdown(workspace.db),
        topRejectionReasons: rejectionBreakdown(workspace.db).slice(0, 12),
        queueDepth: queue.length,
        trackAllocation,
      });
    }),
  );
}
