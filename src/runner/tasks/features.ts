import { z } from "zod";
import { listApplications } from "../../db/repositories/applications.js";
import { getJob, listQueue } from "../../db/repositories/jobs.js";
import { closeStaleApplications } from "../../followup/stale.js";
import { checkLiveness } from "../../hygiene/liveness.js";
import { scanInbox } from "../../inbox/scan.js";
import { scanHarvestedBoards } from "../../sourcing/boardScan.js";
import { harvestBoards } from "../../sourcing/commonCrawl.js";
import { fetchFundedCompanies } from "../../sourcing/funded.js";
import { scanAlertInbox } from "../../sourcing/linkedinAlerts.js";
import { proposeCompanies } from "../../sourcing/proposals.js";
import type { RunQueue } from "../queue.js";
import type { TaskContext } from "../types.js";

/**
 * Run types contributed by the hygiene, inbox and sourcing features.
 *
 * Each wraps one service so it can run for as long as it needs, report
 * progress, and be cancelled - the reasons long operations live in the queue
 * rather than in an MCP call, which a client times out.
 */

const LivenessParamsSchema = z
  .object({
    jobIds: z.array(z.string().min(1)).max(2000).optional(),
    /** Applications in these states have their postings checked. */
    applicationStatuses: z
      .array(z.enum(["drafted", "awaiting_approval", "approved", "needs_human"]))
      .default(["awaiting_approval", "approved", "needs_human"]),
    /** Also check the top of the unapplied queue. */
    includeQueue: z.boolean().default(false),
    limit: z.number().int().min(1).max(2000).default(200),
    /** Re-check even when a fresh verdict exists. */
    force: z.boolean().default(false),
  })
  .strict();
type LivenessParams = z.infer<typeof LivenessParamsSchema>;

function livenessTargets(ctx: TaskContext, params: LivenessParams): string[] {
  if (params.jobIds && params.jobIds.length > 0) return [...new Set(params.jobIds)].slice(0, params.limit);
  const ids = new Set<string>();
  for (const status of params.applicationStatuses) {
    for (const application of listApplications(ctx.workspace.db, status, params.limit)) ids.add(application.jobId);
  }
  if (params.includeQueue) {
    for (const item of listQueue(ctx.workspace.db, { limit: params.limit })) ids.add(item.job.id);
  }
  return [...ids].slice(0, params.limit);
}

async function runLivenessTask(ctx: TaskContext, params: LivenessParams) {
  const targets = livenessTargets(ctx, params);
  const counts = { open: 0, closed: 0, unknown: 0, missing: 0 };
  const closedPostings: Array<{ jobId: string; company: string; title: string; detail: string }> = [];
  for (const [index, jobId] of targets.entries()) {
    ctx.throwIfCancelled();
    const job = getJob(ctx.workspace.db, jobId);
    if (!job) {
      counts.missing += 1;
    } else {
      const verdict = await checkLiveness(ctx.workspace, job, { force: params.force });
      counts[verdict.status] += 1;
      if (verdict.status === "closed") {
        closedPostings.push({ jobId, company: job.companyName, title: job.title, detail: verdict.detail });
        ctx.log("warn", `CLOSED ${job.companyName} | ${job.title}: ${verdict.detail}`);
      }
    }
    ctx.progress(index + 1, targets.length);
  }
  ctx.log("info", `checked ${targets.length}: ${counts.open} open, ${counts.closed} closed, ${counts.unknown} unknown`);
  return { checked: targets.length, ...counts, closedPostings };
}

const InboxParamsSchema = z
  .object({ lookbackDays: z.number().int().min(1).max(365).optional(), dryRun: z.boolean().default(false) })
  .strict();

async function runInboxTask(ctx: TaskContext, params: z.infer<typeof InboxParamsSchema>) {
  const result = await scanInbox(ctx.workspace, params);
  ctx.log("info", `inbox: ${result.counts.candidates} candidates, ${result.counts.recorded} recorded, ${result.counts.proposed} proposed`);
  for (const error of result.errors) ctx.log("warn", error);
  return { ...result.counts, timedOut: result.timedOut, errors: result.errors, dryRun: result.dryRun };
}

const AlertsParamsSchema = z.object({ lookbackDays: z.number().int().min(1).max(90).default(14) }).strict();

async function runAlertsTask(ctx: TaskContext, params: z.infer<typeof AlertsParamsSchema>) {
  const result = await scanAlertInbox(ctx.workspace, params);
  ctx.log("info", "alert inbox scanned", result);
  return result;
}

const FundedParamsSchema = z
  .object({ months: z.number().int().min(1).max(24).default(3), limit: z.number().int().min(1).max(200).default(50) })
  .strict();

async function runFundedTask(ctx: TaskContext, params: z.infer<typeof FundedParamsSchema>) {
  const result = await fetchFundedCompanies(ctx.workspace, params);
  ctx.log("info", `funding feeds read: ${result.added} new companies, ${result.already} already known`, { feeds: result.feeds });
  return result;
}

const ProposeParamsSchema = z.object({ limit: z.number().int().min(1).max(25).default(5) }).strict();

async function runProposeTask(ctx: TaskContext, params: z.infer<typeof ProposeParamsSchema>) {
  const result = await proposeCompanies(ctx.workspace, { ...params, signal: ctx.signal });
  ctx.log("info", "company proposals ready", { proposals: result.proposals.length });
  return result;
}

const HarvestParamsSchema = z
  .object({
    ats: z.array(z.enum(["greenhouse", "ashby", "lever", "workday"])).optional(),
    indexes: z.number().int().min(1).max(12).default(1),
    maxPages: z.number().int().min(1).max(500).optional(),
    /** After harvesting, scan untracked boards for postings that pass the campaign gates. */
    scan: z.boolean().default(true),
    scanLimit: z.number().int().min(1).max(5000).default(200),
  })
  .strict();

async function runHarvestTask(ctx: TaskContext, params: z.infer<typeof HarvestParamsSchema>) {
  const harvest = await harvestBoards(
    { db: ctx.workspace.db, companies: ctx.workspace.companies, ats: params.ats, indexes: params.indexes, maxPages: params.maxPages },
    (progress) => ctx.log(progress.stage === "retry" ? "warn" : "info", progress.message),
    ctx.signal,
  );
  if (!params.scan || harvest.aborted) return { harvest };
  const scan = await scanHarvestedBoards(
    ctx.workspace,
    { ats: params.ats, limit: params.scanLimit },
    (progress) => {
      if (progress.current !== undefined && progress.total !== undefined) ctx.progress(progress.current, progress.total);
      if (progress.stage !== "board") ctx.log("info", progress.message);
    },
    ctx.signal,
  );
  for (const board of scan.matching) ctx.log("info", "board with fitting roles", board);
  return { harvest, scan };
}

const CloseStaleParamsSchema = z.object({ dryRun: z.boolean().default(true) }).strict();

async function runCloseStaleTask(ctx: TaskContext, params: z.infer<typeof CloseStaleParamsSchema>) {
  const result = closeStaleApplications(ctx.workspace, params);
  ctx.log("info", params.dryRun ? "dry run: nothing recorded" : "stale applications recorded as ghosted", result);
  return result;
}

/**
 * Registers the run types contributed by the hygiene, inbox and sourcing
 * features. The liveness check before each submission needs no hook here:
 * submitApplication refuses a posting confirmed closed.
 */
export function registerFeatureTasks(queue: RunQueue): void {
  queue.registerTask("liveness", runLivenessTask, {
    params: LivenessParamsSchema,
    description: "Confirm postings are still open: pending applications, chosen jobs, or the top of the queue.",
  });
  queue.registerTask("inbox", runInboxTask, {
    params: InboxParamsSchema,
    description: "Read employer replies from the mailbox (read-only) and record or propose outcomes.",
  });
  queue.registerTask("alerts", runAlertsTask, {
    params: AlertsParamsSchema,
    description: "Import LinkedIn job alerts from the mailbox as leads.",
  });
  queue.registerTask("funded", runFundedTask, {
    params: FundedParamsSchema,
    description: "Collect recently funded companies from public funding feeds as leads.",
  });
  queue.registerTask("propose", runProposeTask, {
    params: ProposeParamsSchema,
    description: "Resolve and verify ATS boards for companies seen in leads.",
  });
  queue.registerTask("harvest", runHarvestTask, {
    params: HarvestParamsSchema,
    description: "Harvest ATS boards from Common Crawl, then scan untracked ones for fitting roles.",
  });
  queue.registerTask("close-stale", runCloseStaleTask, {
    params: CloseStaleParamsSchema,
    description: "Record long-silent applications as ghosted (dry run by default).",
  });
}
