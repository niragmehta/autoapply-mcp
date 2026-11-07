import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { getWorkspace } from "../config/load.js";
import { getApplication } from "../db/repositories/applications.js";
import { getJob, listQueue } from "../db/repositories/jobs.js";
import { addToBlacklist } from "../hygiene/blacklistStore.js";
import { checkLiveness, checkLivenessMany } from "../hygiene/liveness.js";
import { legitimacyFor } from "../hygiene/postingSignals.js";
import { findRepostClusters } from "../hygiene/reposts.js";
import { dismissJob, listDismissedJobs, restoreJob } from "../services/jobs.js";
import { AppError } from "../util/errors.js";
import { handler, ok } from "./helpers.js";

/** Posting hygiene: liveness checks, repost clusters, legitimacy signals and the do-not-apply list. */
export function registerHygieneTools(server: McpServer): void {
  server.registerTool(
    "check_liveness",
    {
      title: "Check whether postings are still open",
      description:
        "Confirms postings still take applications: the ATS API first, then the posting page. A fresh stored verdict is reused unless force=true. Closed needs evidence (404, a redirect to the board index, the ATS or page saying so); everything inconclusive is 'unknown', which never blocks. Without ids it checks the top of the queue.",
      inputSchema: {
        jobIds: z.array(z.string().min(1)).max(50).optional(),
        applicationIds: z.array(z.string().min(1)).max(50).optional(),
        limit: z.number().int().min(1).max(50).optional().describe("Queue items to check when no ids are given (default 10)."),
        force: z.boolean().optional().describe("Check now even when a fresh verdict is stored."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    handler(async (args: { jobIds?: string[]; applicationIds?: string[]; limit?: number; force?: boolean }) => {
      const workspace = getWorkspace();
      const fromApplications = (args.applicationIds ?? []).map((id) => {
        const application = getApplication(workspace.db, id);
        if (!application) throw new AppError("application_not_found", `no application ${id}`);
        return application.jobId;
      });
      let ids = [...(args.jobIds ?? []), ...fromApplications];
      if (ids.length === 0) {
        ids = listQueue(workspace.db, {
          minScore: workspace.campaign.scoring.thresholds.tierC,
          maxPerCompany: workspace.campaign.submission.maxPerCompany,
          fx: workspace.campaign.compensation.fx,
          allowUnknownCompensation: true,
          limit: args.limit ?? 10,
        }).map((item) => item.job.id);
      }
      const result = await checkLivenessMany(workspace, ids, { force: args.force === true });
      return ok({
        ...result,
        verdicts: result.verdicts.map((verdict) => ({
          jobId: verdict.jobId,
          company: verdict.company,
          title: verdict.title,
          status: verdict.status,
          via: verdict.via,
          detail: verdict.detail,
          checkedAt: verdict.checkedAt,
          reused: verdict.reused,
          listing: verdict.listing.status,
        })),
        note: "Only 'closed' stops prepare_application; 'unknown' never blocks.",
      });
    }),
  );

  server.registerTool(
    "find_reposts",
    {
      title: "Find reposted roles",
      description:
        "Clusters stored postings of the same role on the same board, by title identity, and reports roles re-listed under new posting ids on different days within the window. A weak ghost-job signal: evergreen and hard-to-fill roles are reposted too.",
      inputSchema: {
        windowDays: z.number().int().min(1).max(365).optional(),
        minPostings: z.number().int().min(2).max(20).optional(),
        company: z.string().min(1).optional(),
        limit: z.number().int().min(1).max(200).optional(),
      },
      annotations: { readOnlyHint: true },
    },
    handler(async (args: { windowDays?: number; minPostings?: number; company?: string; limit?: number }) => {
      const workspace = getWorkspace();
      const policy = workspace.campaign.hygiene.reposts;
      const clusters = findRepostClusters(workspace.db, {
        windowDays: args.windowDays ?? policy.windowDays,
        minPostings: args.minPostings ?? policy.minPostings,
        ...(args.company ? { company: args.company } : {}),
      });
      const limit = args.limit ?? 50;
      return ok({
        count: clusters.length,
        clusters: clusters.slice(0, limit).map((cluster) => ({ ...cluster, members: cluster.members.slice(0, 10) })),
        truncated: Math.max(0, clusters.length - limit),
      });
    }),
  );

  server.registerTool(
    "posting_legitimacy",
    {
      title: "Assess a posting's legitimacy",
      description:
        "Observations about whether a posting is a real, active opening: liveness, listing absence, reposts, age, pay transparency, agency and contract terms, fee requests, AI-screening disclosure and description quality. Each signal quotes its evidence; the tier (high, caution, suspicious) summarises observations, never a verdict on the employer.",
      inputSchema: {
        jobId: z.string().min(1),
        refreshLiveness: z.boolean().optional().describe("Check liveness first when no fresh verdict is stored (default true)."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true },
    },
    handler(async (args: { jobId: string; refreshLiveness?: boolean }) => {
      const workspace = getWorkspace();
      const job = getJob(workspace.db, args.jobId);
      if (!job) throw new AppError("job_not_found", `no job stored with id ${args.jobId}`);
      if (args.refreshLiveness !== false) await checkLiveness(workspace, job);
      const assessment = legitimacyFor(workspace, job);
      return ok({
        jobId: job.id,
        company: job.companyName,
        title: job.title,
        tier: assessment.tier,
        summary: assessment.summary,
        signals: assessment.signals,
        liveness: assessment.liveness,
        listing: assessment.listing,
        repost: assessment.repost ? { ...assessment.repost, members: assessment.repost.members.slice(0, 10) } : null,
      });
    }),
  );

  server.registerTool(
    "blacklist_company",
    {
      title: "Add to the do-not-apply list",
      description:
        "Records the candidate's decision never to apply to an employer (by name) or a domain (the posting host or any subdomain) in campaign.json, with a dated backup. The gate rejects matching postings from then on, and stored ones are re-evaluated now. Only call this when the candidate asks.",
      inputSchema: {
        company: z.string().min(1).max(200).optional(),
        domain: z.string().min(1).max(253).optional(),
        reason: z.string().max(500).describe("The candidate's reason, in their words."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    handler(async (args: { company?: string; domain?: string; reason: string }) => {
      const result = addToBlacklist(getWorkspace(), args);
      return ok({
        added: result.added,
        alreadyListed: result.alreadyListed,
        backupPath: result.backupPath,
        entries: result.blacklist.length,
        reevaluated: result.reevaluated,
      });
    }),
  );

  server.registerTool(
    "list_blacklist",
    {
      title: "List the do-not-apply list",
      description: "Returns campaign.hygiene.blacklist: every company and domain the candidate decided never to apply to, with reasons and dates.",
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    handler(async () => {
      const entries = getWorkspace().campaign.hygiene.blacklist;
      return ok({ count: entries.length, entries });
    }),
  );

  server.registerTool(
    "dismiss_job",
    {
      title: "Dismiss a posting",
      description:
        "Rules one posting out by hand: it and the same role on any other board leave list_queue and every batch. An application drafted for it but never sent is rejected: any earlier approval is voided and it is taken out of prepared batches. Refused once submitted. Use blacklist_company to rule out a whole company instead.",
      inputSchema: {
        jobId: z.string().min(1),
        reason: z.string().max(500).optional().describe("Why, in the candidate's words, kept for later review."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    handler(async (args: { jobId: string; reason?: string }) => ok(dismissJob(getWorkspace(), args))),
  );

  server.registerTool(
    "restore_job",
    {
      title: "Restore a dismissed posting",
      description: "Puts a dismissed posting back in the queue. A skipped application stays skipped until prepare_application drafts it again.",
      inputSchema: { jobId: z.string().min(1) },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    handler(async (args: { jobId: string }) => ok(restoreJob(getWorkspace(), args.jobId))),
  );

  server.registerTool(
    "list_dismissed_jobs",
    {
      title: "List dismissed postings",
      description: "Postings dismissed by hand, newest first, with the reason given.",
      inputSchema: { limit: z.number().int().min(1).max(500).optional() },
      annotations: { readOnlyHint: true },
    },
    handler(async (args: { limit?: number }) => {
      const jobs = listDismissedJobs(getWorkspace().db, args.limit);
      return ok({ count: jobs.length, jobs });
    }),
  );
}
