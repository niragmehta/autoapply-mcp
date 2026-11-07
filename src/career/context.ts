import type { z } from "zod";
import type { Workspace } from "../config/load.js";
import type { Db } from "../db/database.js";
import { getApplication, listOutcomes, recordOutcome } from "../db/repositories/applications.js";
import { appendEvent } from "../db/repositories/events.js";
import { getJob } from "../db/repositories/jobs.js";
import type { Application, Job } from "../domain/job.js";
import { AppError } from "../util/errors.js";

/** Shared plumbing for the career services. */

/** The parts of a workspace the career services read; callers may pass a full Workspace. */
export type CareerWorkspace = Pick<Workspace, "db" | "profile" | "campaign">;

type ApplicationWithJob = { application: Application; job: Job };

export function requireApplication(db: Db, applicationId: string): ApplicationWithJob {
  const application = getApplication(db, applicationId);
  if (!application) throw new AppError("application_not_found", `no application ${applicationId}`);
  const job = getJob(db, application.jobId);
  if (!job) throw new AppError("job_not_found", `job ${application.jobId} for application ${applicationId} is missing`);
  return { application, job };
}

/**
 * Records an outcome only when the application has none with that status, so
 * a second technical round or a revised offer is not counted as another
 * conversion. Leaves the same `outcome.recorded` audit event as the
 * record_outcome tool.
 */
export function recordOutcomeOnce(db: Db, applicationId: string, status: string, detail: string): boolean {
  if (listOutcomes(db, applicationId).some((outcome) => outcome.status === status)) return false;
  recordOutcome(db, applicationId, status, detail);
  appendEvent(db, "outcome.recorded", applicationId, { status, via: "career" });
  return true;
}

export function sameCompany(left: string, right: string): boolean {
  return left.trim().toLowerCase() === right.trim().toLowerCase();
}

/** Parses service input with zod, failing with one readable `invalid_input` error. */
export function parseInput<S extends z.ZodType>(schema: S, input: unknown, label: string): z.output<S> {
  const result = schema.safeParse(input);
  if (result.success) return result.data;
  const issues = result.error.issues
    .slice(0, 6)
    .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("; ");
  throw new AppError("invalid_input", `${label}: ${issues}`);
}

/** Normalizes a date or date-time to ISO 8601 UTC, rejecting unparseable text. */
export function toIsoDateTime(value: string, field: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new AppError("invalid_input", `${field}: "${value}" is not a date-time (use ISO 8601, e.g. 2026-11-12T17:00:00Z)`);
  }
  return parsed.toISOString();
}

/** Days from `now` to `iso`, one decimal place; negative when past. */
export function daysUntil(iso: string | null, now: Date = new Date()): number | null {
  if (!iso) return null;
  const target = new Date(iso);
  if (Number.isNaN(target.getTime())) return null;
  return Math.round(((target.getTime() - now.getTime()) / 86_400_000) * 10) / 10;
}

/** Caps long stored text so one call cannot flood the agent's context. */
export function truncateText(text: string, max: number): { text: string; truncated: boolean } {
  return text.length <= max ? { text, truncated: false } : { text: `${text.slice(0, max)}\n[truncated]`, truncated: true };
}
