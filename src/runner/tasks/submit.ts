import { basename } from "node:path";
import { z } from "zod";
import type { Workspace } from "../../config/load.js";
import { updateJsonFile } from "../../config/write.js";
import { getApplication, latestApproval } from "../../db/repositories/applications.js";
import { appendEvent } from "../../db/repositories/events.js";
import { getJob } from "../../db/repositories/jobs.js";
import { CampaignSchema } from "../../domain/campaign.js";
import {
  approveApplication,
  previewApplication,
  submitApplication,
  type SubmitOutcome,
} from "../../services/applications.js";
import { AppError, isAppError, toErrorMessage } from "../../util/errors.js";
import { countRoundSubmissions, roundStartIso } from "../roundCap.js";
import { RunCancelledError, type TaskContext } from "../types.js";
import { invalidateWorkspace } from "../workspace.js";

/**
 * Submission as a run, for an explicit list of applications a person chose.
 *
 * Starting the run is the person's approval of that list: an application whose
 * current packet is not yet approved is approved at its current hash, noted as
 * approved by this run. When the caller passes the hashes it reviewed, an
 * application whose content changed since is skipped instead. Every guard in
 * submitApplication still applies to every item. Anything with an unresolved
 * required answer is skipped, never guessed.
 */

export const SubmitParamsSchema = z
  .object({
    applicationIds: z.array(z.string().trim().min(1)).min(1).max(200),
    mode: z.enum(["auto", "assisted"]).default("auto"),
    headed: z.boolean().optional(),
    paceSeconds: z.number().int().min(0).max(3600).optional(),
    codeWaitSeconds: z.number().int().min(0).max(1800).optional(),
    /** applicationId -> packet hash the person reviewed. */
    packetHashes: z.record(z.string(), z.string().min(8)).optional(),
  })
  .strict();
export type SubmitParams = z.infer<typeof SubmitParamsSchema>;

const MAX_PACING_RETRIES = 8;
/** Guard denials that apply to every later item too, so the run stops instead of failing each one. */
const STOP_CODES = new Set(["daily_limit_reached", "mode_not_permitted"]);

export type SubmitItemOutcome = "sent" | "prepared" | "failed" | "skipped" | "already_submitted";

export type SubmitItemResult = {
  applicationId: string;
  company: string;
  title: string;
  outcome: SubmitItemOutcome;
  reason?: string;
  code?: string;
  screenshot?: string;
  seconds?: number;
  /** Whether the employer's form was opened, which is what pacing protects. */
  attempted: boolean;
};

export type SubmitRunSummary = {
  requested: number;
  sent: number;
  prepared: number;
  failed: number;
  skipped: number;
  alreadySubmitted: number;
  stoppedEarly: string | null;
  items: SubmitItemResult[];
};

type Tag = { applicationId: string; company: string; title: string };

const describe = (tag: Tag) => `${tag.applicationId} ${tag.company} | ${tag.title.slice(0, 50)}`;

function skip(ctx: TaskContext, tag: Tag, reason: string, code?: string): SubmitItemResult {
  ctx.log("warn", `SKIP ${describe(tag)} - ${reason}`, { ...tag, outcome: "skipped", reason, ...(code ? { code } : {}) });
  return { ...tag, outcome: "skipped", reason, ...(code ? { code } : {}), attempted: false };
}

/** Sleeps, returning false instead of throwing when the run is cancelled meanwhile. */
async function pause(ctx: TaskContext, ms: number): Promise<boolean> {
  try {
    await ctx.sleep(ms);
    return true;
  } catch (error) {
    if (error instanceof RunCancelledError) return false;
    throw error;
  }
}

function pacingWaitSeconds(error: unknown): number | null {
  if (!isAppError(error) || error.code !== "pacing") return null;
  const fromDetails = Number(error.details.waitSeconds);
  if (Number.isFinite(fromDetails) && fromDetails >= 0) return fromDetails;
  const fromMessage = /wait (\d+)s/.exec(error.message)?.[1];
  return fromMessage ? Number(fromMessage) : 30;
}

/** Adds `company` to submission.allowedCompanies, validating the result before it is written. */
function withAllowedCompany(current: unknown, company: string): unknown {
  if (typeof current !== "object" || current === null) throw new AppError("config_invalid", "campaign.json is not an object");
  const campaign = current as Record<string, unknown>;
  const submission = (campaign.submission ?? {}) as Record<string, unknown>;
  const allowed = Array.isArray(submission.allowedCompanies) ? submission.allowedCompanies.map(String) : [];
  const next = { ...campaign, submission: { ...submission, allowedCompanies: [...allowed, company] } };
  const check = CampaignSchema.safeParse(next);
  if (!check.success) throw new AppError("config_invalid", "campaign.json would not validate after allowlisting; left unchanged");
  return next;
}

/**
 * Allowlists the company just before submitting to it. An empty allowlist
 * already permits every company, and adding one name would turn it into a
 * restriction on all the others, so it is left alone.
 */
function ensureAllowlisted(ctx: TaskContext, workspace: Workspace, company: string): Workspace {
  const allowed = workspace.campaign.submission.allowedCompanies;
  if (allowed.length === 0 || allowed.some((name) => name.toLowerCase() === company.toLowerCase())) return workspace;
  updateJsonFile<unknown>(workspace.paths.campaign, (current) => withAllowedCompany(current, company));
  invalidateWorkspace();
  appendEvent(workspace.db, "runner.allowlisted", "campaign", { company, runId: ctx.runId });
  ctx.log("info", `Allowlisted ${company} for auto submission (campaign.runner.autoAllowlist).`, { company });
  return ctx.workspace;
}

function report(ctx: TaskContext, tag: Tag, outcome: SubmitOutcome, started: number): SubmitItemResult {
  const seconds = Math.round((Date.now() - started) / 1000);
  if (outcome.kind === "manual") {
    ctx.log("info", `MANUAL ${describe(tag)} - packet ready for a person to send`, { ...tag });
    return { ...tag, outcome: "prepared", seconds, attempted: false };
  }
  const { result } = outcome;
  const screenshot = result.screenshotPath ? basename(result.screenshotPath) : undefined;
  const shot = screenshot ? ` | shot: ${screenshot}` : "";
  const data = { ...tag, status: result.status, screenshot, seconds, finalUrl: result.finalUrl };
  if (result.status === "submitted") {
    const confirmation = result.confirmationText.replace(/\s+/g, " ").trim().slice(0, 90);
    ctx.log("info", `SENT ${describe(tag)} (${seconds}s)${confirmation ? ` | ${confirmation}` : ""}${shot}`, { ...data, outcome: "sent" });
    return { ...tag, outcome: "sent", screenshot, seconds, attempted: true };
  }
  if (result.status === "prepared") {
    ctx.log("info", `FILLED ${describe(tag)} (${seconds}s) - review the browser window, submit it, then record the submission${shot}`, {
      ...data,
      outcome: "prepared",
    });
    return { ...tag, outcome: "prepared", screenshot, seconds, attempted: true };
  }
  const reason = result.reason.replace(/\s+/g, " ").slice(0, 400);
  ctx.log("error", `FAIL ${describe(tag)} (${seconds}s): ${reason}${shot}`, { ...data, outcome: "failed", reason });
  return { ...tag, outcome: "failed", reason, screenshot, seconds, attempted: true };
}

async function attemptSubmission(ctx: TaskContext, params: SubmitParams, tag: Tag, ats: string): Promise<SubmitItemResult> {
  const started = Date.now();
  for (let attempt = 0; ; attempt += 1) {
    const workspace = ctx.workspace;
    const runner = workspace.campaign.runner;
    // Ashby flags headless automated submissions as spam, so its forms always get a visible window.
    const headless = !(params.headed ?? runner.headed) && ats !== "ashby";
    try {
      const outcome = await submitApplication(workspace, {
        applicationId: tag.applicationId,
        mode: params.mode,
        headless,
        waitForCodeSeconds: params.codeWaitSeconds ?? runner.codeWaitSeconds,
      });
      return report(ctx, tag, outcome, started);
    } catch (error) {
      const wait = pacingWaitSeconds(error);
      if (wait !== null && attempt < MAX_PACING_RETRIES) {
        ctx.log("info", `Pacing: waiting ${wait}s before retrying ${tag.applicationId}.`, { waitSeconds: wait });
        if (!(await pause(ctx, (wait + 2) * 1000))) return skip(ctx, tag, "cancelled while waiting for pacing");
        continue;
      }
      // A closed posting is a reason to move on, not a failed submission.
      if (isAppError(error) && error.code === "posting_closed") return skip(ctx, tag, error.message, error.code);
      const code = isAppError(error) ? error.code : "error";
      const reason = toErrorMessage(error).replace(/\s+/g, " ").slice(0, 400);
      ctx.log("error", `FAIL ${describe(tag)}: ${reason}`, { ...tag, outcome: "failed", code, reason });
      // A guard denial never reached the employer; anything else may have.
      return { ...tag, outcome: "failed", code, reason, attempted: !isAppError(error) };
    }
  }
}

async function submitOne(ctx: TaskContext, params: SubmitParams, applicationId: string): Promise<SubmitItemResult> {
  let workspace = ctx.workspace;
  const application = getApplication(workspace.db, applicationId);
  if (!application) return skip(ctx, { applicationId, company: "?", title: "" }, "no such application");
  const job = getJob(workspace.db, application.jobId);
  const tag: Tag = { applicationId, company: job?.companyName ?? "?", title: job?.title ?? "" };
  if (!job) return skip(ctx, tag, "its job record is missing");
  if (application.status === "submitted") {
    ctx.log("info", `DONE ${describe(tag)} (already submitted)`, { ...tag, outcome: "already_submitted" });
    return { ...tag, outcome: "already_submitted", attempted: false };
  }

  const roundCap = workspace.campaign.runner.roundCap;
  if (roundCap) {
    const held = countRoundSubmissions(workspace.db, job.companyName, roundStartIso(roundCap), applicationId);
    if (held >= roundCap.max) {
      return skip(ctx, tag, `round cap: ${held} already submitted to ${job.companyName} since ${roundCap.since}`);
    }
  }

  if (params.mode === "auto" && workspace.campaign.runner.autoAllowlist) {
    workspace = ensureAllowlisted(ctx, workspace, job.companyName);
  }

  const preview = previewApplication(workspace, applicationId);
  if (preview.unresolvedRequired.length > 0) {
    return skip(ctx, tag, `unresolved: ${preview.unresolvedRequired.join("; ").replace(/\s+/g, " ").slice(0, 160)}`);
  }
  const reviewed = params.packetHashes?.[applicationId];
  if (reviewed !== undefined && reviewed !== preview.packetHash) {
    return skip(ctx, tag, "content changed since it was reviewed; review it again before submitting");
  }
  const approval = latestApproval(workspace.db, applicationId);
  if (!approval || approval.decision !== "approved" || approval.packetHash !== preview.packetHash) {
    approveApplication(workspace, {
      applicationId,
      packetHash: preview.packetHash,
      decision: "approved",
      note: `approved via submit run ${ctx.runId}`,
    });
    ctx.log("info", `Approved ${describe(tag)} at packet ${preview.packetHash.slice(0, 12)} (approved via submit run ${ctx.runId}).`);
  }
  return attemptSubmission(ctx, params, tag, job.ats);
}

function summarize(items: SubmitItemResult[], requested: number, stoppedEarly: string | null): SubmitRunSummary {
  const count = (outcome: SubmitItemOutcome) => items.filter((item) => item.outcome === outcome).length;
  return {
    requested,
    sent: count("sent"),
    prepared: count("prepared"),
    failed: count("failed"),
    skipped: count("skipped"),
    alreadySubmitted: count("already_submitted"),
    stoppedEarly,
    items,
  };
}

export async function runSubmitTask(ctx: TaskContext, params: SubmitParams): Promise<SubmitRunSummary> {
  const ids = [...new Set(params.applicationIds)];
  const items: SubmitItemResult[] = [];
  let stoppedEarly: string | null = null;
  ctx.progress(0, ids.length);
  ctx.log("info", `Submitting ${ids.length} application(s) in ${params.mode} mode.`);

  for (const [index, applicationId] of ids.entries()) {
    if (ctx.signal.aborted) break;
    let result: SubmitItemResult;
    try {
      result = await submitOne(ctx, params, applicationId);
    } catch (error) {
      const reason = toErrorMessage(error).replace(/\s+/g, " ").slice(0, 400);
      ctx.log("error", `ERR  ${applicationId}: ${reason}`, { applicationId, reason });
      result = { applicationId, company: "?", title: "", outcome: "failed", reason, attempted: false };
    }
    items.push(result);
    ctx.progress(index + 1, ids.length);
    if (result.code && STOP_CODES.has(result.code)) {
      stoppedEarly = result.reason ?? result.code;
      ctx.log("warn", `Stopping the run: ${stoppedEarly}`);
      break;
    }
    if (index === ids.length - 1 || !result.attempted || ctx.signal.aborted) continue;
    const pace = params.paceSeconds ?? ctx.workspace.campaign.runner.paceSeconds;
    if (pace > 0) {
      ctx.log("info", `Waiting ${pace}s before the next application.`);
      if (!(await pause(ctx, pace * 1000))) break;
    }
  }

  const summary = summarize(items, ids.length, stoppedEarly);
  ctx.log(
    "info",
    `sent=${summary.sent} filled=${summary.prepared} failed=${summary.failed} skipped=${summary.skipped} already=${summary.alreadySubmitted}`,
  );
  return summary;
}
