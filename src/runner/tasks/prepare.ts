import { z } from "zod";
import type { Workspace } from "../../config/load.js";
import { getJob, listQueue } from "../../db/repositories/jobs.js";
import { LocationClassSchema } from "../../domain/campaign.js";
import { prepareApplication } from "../../services/applications.js";
import { toErrorMessage } from "../../util/errors.js";
import type { TaskContext } from "../types.js";

/**
 * Preparation as a run: drafts an application for each selected job through
 * the same prepareApplication service as the single-job tool, and reports
 * which are ready for review and which need a human answer first.
 *
 * A filter selects exactly as prepare_batch does (tiers default to A and B,
 * roles already applied to are excluded, the per-company ceiling is honoured,
 * and submission.maxBatchSize caps the selection). Explicit job ids were picked
 * by a person and are prepared as given.
 */

export const PrepareFilterSchema = z
  .object({
    tiers: z.array(z.enum(["A", "B", "C"])).optional(),
    tracks: z.array(z.string().min(1)).optional(),
    locationClasses: z.array(LocationClassSchema).optional(),
    companies: z.array(z.string().min(1)).optional(),
    minCompensation: z.number().nonnegative().optional(),
    allowUnknownCompensation: z.boolean().optional(),
    minScore: z.number().optional(),
    limit: z.number().int().positive().max(500).optional(),
  })
  .strict();

export const PrepareParamsSchema = z
  .object({
    jobIds: z.array(z.string().trim().min(1)).min(1).max(500).optional(),
    filter: PrepareFilterSchema.optional(),
    /** Prepare even when a job was not accepted or its company is at the ceiling. */
    force: z.boolean().optional(),
  })
  .strict()
  .refine((params) => !(params.jobIds && params.filter), { message: "pass jobIds or filter, not both" });
export type PrepareParams = z.infer<typeof PrepareParamsSchema>;
export type PrepareFilter = z.infer<typeof PrepareFilterSchema>;

export type PreparedItem = {
  jobId: string;
  applicationId: string | null;
  company: string;
  title: string;
  state: "ready" | "needs_human" | "failed";
  detail: string;
};

export type PrepareRunSummary = {
  selected: number;
  ready: number;
  needsHuman: number;
  failed: number;
  items: PreparedItem[];
  recurringQuestions: Array<{ label: string; count: number }>;
  stoppedEarly: boolean;
};

type Target = { jobId: string; company: string; title: string };

function selectFromQueue(ctx: TaskContext, workspace: Workspace, filter: PrepareFilter): Target[] {
  const ceiling = workspace.campaign.submission.maxBatchSize;
  const requested = filter.limit ?? ceiling;
  if (requested > ceiling) ctx.log("info", `Limit ${requested} reduced to submission.maxBatchSize (${ceiling}).`);
  return listQueue(workspace.db, {
    minScore: filter.minScore ?? 0,
    tiers: filter.tiers ?? ["A", "B"],
    trackIds: filter.tracks,
    locationClasses: filter.locationClasses,
    companies: filter.companies,
    minCompensation: filter.minCompensation,
    allowUnknownCompensation: filter.allowUnknownCompensation ?? false,
    fx: workspace.campaign.compensation.fx,
    maxPerCompany: workspace.campaign.submission.maxPerCompany,
    limit: Math.min(requested, ceiling),
  }).map((item) => ({ jobId: item.job.id, company: item.job.companyName, title: item.job.title }));
}

function explicitTargets(workspace: Workspace, jobIds: readonly string[]): Target[] {
  return [...new Set(jobIds)].map((jobId) => {
    const job = getJob(workspace.db, jobId);
    return { jobId, company: job?.companyName ?? "?", title: job?.title ?? "" };
  });
}

export async function runPrepareTask(ctx: TaskContext, params: PrepareParams): Promise<PrepareRunSummary> {
  const workspace = ctx.workspace;
  const targets = params.jobIds ? explicitTargets(workspace, params.jobIds) : selectFromQueue(ctx, workspace, params.filter ?? {});
  const items: PreparedItem[] = [];
  const questionCounts = new Map<string, number>();

  ctx.progress(0, targets.length);
  ctx.log("info", targets.length === 0 ? "Nothing matches; no applications prepared." : `Preparing ${targets.length} application(s).`);

  for (const [index, target] of targets.entries()) {
    if (ctx.signal.aborted) break;
    const label = `${target.company} | ${target.title.slice(0, 60)}`;
    try {
      const result = await prepareApplication(ctx.workspace, { jobId: target.jobId, force: params.force });
      const outstanding = result.questionsNeedingHuman.map((question) => question.label);
      const blockers = [...(result.resumeBlocker ? [`resume: ${result.resumeBlocker}`] : []), ...outstanding];
      for (const question of outstanding) questionCounts.set(question, (questionCounts.get(question) ?? 0) + 1);
      const state = result.status === "needs_human" ? "needs_human" : "ready";
      items.push({ ...target, applicationId: result.applicationId, state, detail: blockers.join(" | ").slice(0, 500) });
      ctx.log(
        state === "ready" ? "info" : "warn",
        state === "ready"
          ? `READY ${result.applicationId} ${label}`
          : `NEEDS ${result.applicationId} ${label} - ${blockers.slice(0, 4).join("; ").slice(0, 200)}`,
        { jobId: target.jobId, applicationId: result.applicationId, state },
      );
    } catch (error) {
      const message = toErrorMessage(error);
      items.push({ ...target, applicationId: null, state: "failed", detail: message.slice(0, 500) });
      ctx.log("warn", `FAIL ${target.jobId} ${label}: ${message.slice(0, 300)}`, { jobId: target.jobId });
    }
    ctx.progress(index + 1, targets.length);
  }

  const count = (state: PreparedItem["state"]) => items.filter((item) => item.state === state).length;
  const summary: PrepareRunSummary = {
    selected: targets.length,
    ready: count("ready"),
    needsHuman: count("needs_human"),
    failed: count("failed"),
    items,
    recurringQuestions: [...questionCounts.entries()]
      .map(([label, total]) => ({ label, count: total }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 15),
    stoppedEarly: ctx.signal.aborted,
  };
  ctx.log("info", `Prepared: ${summary.ready} ready, ${summary.needsHuman} need a human, ${summary.failed} failed.`);
  return summary;
}
