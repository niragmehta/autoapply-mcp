import { z } from "zod";
import { getApplicationByJob } from "../../db/repositories/applications.js";
import { getDismissal } from "../../db/repositories/dismissals.js";
import { findDuplicates, getEvaluation, getJob } from "../../db/repositories/jobs.js";
import { livenessHistory } from "../../db/repositories/liveness.js";
import { LocationClassSchema } from "../../domain/campaign.js";
import type { Job } from "../../domain/job.js";
import { checkLiveness } from "../../hygiene/liveness.js";
import { legitimacyFor } from "../../hygiene/postingSignals.js";
import { prepareApplication } from "../../services/applications.js";
import { dismissJob, listDismissedJobs, restoreJob } from "../../services/jobs.js";
import { AppError, toErrorMessage } from "../../util/errors.js";
import type { Workspace } from "../../config/load.js";
import { listEventRows } from "../queries/applications.js";
import { JOB_SORTS, jobFacets, listJobRows, type JobSort } from "../queries/jobs.js";
import { parseBody, parseParams, parseQuery, type Router } from "../router.js";
import { IdParams, csvList, paged, queryBool, queryInt, queryNumber, queryText, sortDir } from "./shared.js";

/**
 * Jobs: the filterable table, one posting's evaluation, liveness and
 * legitimacy, preparing an application for it, and dismissing or restoring it.
 */

const DESCRIPTION_LIMIT = 20_000;
const REPOST_MEMBERS_SHOWN = 10;
const LIVENESS_HISTORY = 10;
const BULK_LIMIT = 200;

const JobListQuery = z.object({
  q: queryText(),
  tier: csvList(z.enum(["A", "B", "C", "none"])),
  track: csvList(z.string().max(100)),
  decision: csvList(z.enum(["accept", "review", "reject"])),
  locationClass: csvList(LocationClassSchema),
  ats: csvList(z.string().max(40)),
  company: queryText(),
  hasApplication: queryBool,
  minScore: queryNumber,
  dismissed: z.preprocess((value) => (value === "" ? undefined : value), z.enum(["hide", "include", "only"]).default("hide")),
  sort: z.preprocess((value) => (value === "" ? undefined : value), z.enum(Object.keys(JOB_SORTS) as [JobSort, ...JobSort[]]).default("score")),
  dir: z.preprocess((value) => (value === "" ? undefined : value), sortDir.default("desc")),
  page: queryInt(1, 100_000, 1),
  pageSize: queryInt(1, 200, 50),
});

const PrepareBody = z
  .object({
    force: z.boolean().optional(),
    resumeId: z.string().trim().min(1).max(100).optional(),
  })
  .strict();

const DismissBody = z.object({ reason: z.string().trim().max(500).optional() }).strict();

const BulkDismissBody = z
  .object({
    jobIds: z.array(z.string().trim().min(1).max(200)).min(1).max(BULK_LIMIT),
    reason: z.string().trim().max(500).optional(),
  })
  .strict();

const BulkRestoreBody = z.object({ jobIds: z.array(z.string().trim().min(1).max(200)).min(1).max(BULK_LIMIT) }).strict();

const LivenessBody = z.object({ force: z.boolean().optional() }).strict();

const DismissedQuery = z.object({ limit: queryInt(1, 1000, 200) });

function requireJob(workspace: Workspace, id: string): Job {
  const job = getJob(workspace.db, id);
  if (!job) throw new AppError("job_not_found", `no job ${id}`);
  return job;
}

/** Legitimacy reads only stored data; a failure in one signal must not hide the rest of the posting. */
function legitimacyOf(workspace: Workspace, job: Job) {
  try {
    const assessment = legitimacyFor(workspace, job);
    return {
      tier: assessment.tier,
      summary: assessment.summary,
      signals: assessment.signals,
      listing: assessment.listing,
      repost: assessment.repost ? { ...assessment.repost, members: assessment.repost.members.slice(0, REPOST_MEMBERS_SHOWN) } : null,
      error: null,
    };
  } catch (error) {
    return { tier: null, summary: "", signals: [], listing: null, repost: null, error: toErrorMessage(error) };
  }
}

/** Runs one action per id and reports each result, so one refused id does not hide the others. */
function eachJob<T>(ids: readonly string[], action: (id: string) => T) {
  const done: T[] = [];
  const failed: Array<{ jobId: string; code: string; message: string }> = [];
  for (const id of [...new Set(ids)]) {
    try {
      done.push(action(id));
    } catch (error) {
      failed.push({ jobId: id, code: error instanceof AppError ? error.code : "internal_error", message: toErrorMessage(error) });
    }
  }
  return { done, failed };
}

export function registerRoutes(router: Router): void {
  router.get("/api/jobs", (request) => {
    const query = parseQuery(JobListQuery, request);
    const { total, rows } = listJobRows(request.ctx.workspace().db, {
      q: query.q,
      tiers: query.tier,
      tracks: query.track,
      decisions: query.decision,
      locationClasses: query.locationClass,
      ats: query.ats,
      company: query.company,
      hasApplication: query.hasApplication,
      minScore: query.minScore,
      dismissed: query.dismissed,
      sort: query.sort,
      dir: query.dir,
      page: query.page,
      pageSize: query.pageSize,
    });
    return paged(total, query.page, query.pageSize, rows);
  });

  router.get("/api/jobs/facets", ({ ctx }) => jobFacets(ctx.workspace().db));

  router.get("/api/jobs/dismissed", (request) => {
    const query = parseQuery(DismissedQuery, request);
    const jobs = listDismissedJobs(request.ctx.workspace().db, query.limit);
    return { count: jobs.length, jobs };
  });

  router.post("/api/jobs/dismiss", (request) => {
    const body = parseBody(BulkDismissBody, request);
    const workspace = request.ctx.workspace();
    const { done, failed } = eachJob(body.jobIds, (jobId) => dismissJob(workspace, { jobId, reason: body.reason }));
    return { dismissed: done, failed };
  });

  router.post("/api/jobs/restore", (request) => {
    const body = parseBody(BulkRestoreBody, request);
    const workspace = request.ctx.workspace();
    const { done, failed } = eachJob(body.jobIds, (jobId) => restoreJob(workspace, jobId));
    return { restored: done, failed };
  });

  router.get("/api/jobs/:id", (request) => {
    const { id } = parseParams(IdParams, request);
    const workspace = request.ctx.workspace();
    const { db } = workspace;
    const job = requireJob(workspace, id);
    const application = getApplicationByJob(db, id);
    const duplicates = findDuplicates(db, job.fingerprint, job.id).map((other) => ({
      id: other.id,
      company: other.companyName,
      title: other.title,
      ats: other.ats,
      url: other.url,
    }));
    const dismissal = getDismissal(db, job.fingerprint);
    return {
      job: {
        ...job,
        descriptionText: job.descriptionText.slice(0, DESCRIPTION_LIMIT),
        descriptionTruncated: job.descriptionText.length > DESCRIPTION_LIMIT,
      },
      evaluation: getEvaluation(db, id),
      application: application
        ? {
            id: application.id,
            status: application.status,
            packetHash: application.packetHash,
            createdAt: application.createdAt,
            submittedAt: application.submittedAt,
          }
        : null,
      duplicates,
      dismissal: dismissal ? { reason: dismissal.reason, dismissedAt: dismissal.dismissedAt, viaJobId: dismissal.jobId } : null,
      liveness: { history: livenessHistory(db, id, LIVENESS_HISTORY) },
      legitimacy: legitimacyOf(workspace, job),
      events: listEventRows(db, { subjects: application ? [application.id, job.id] : [job.id], limit: 30 }),
    };
  });

  router.post("/api/jobs/:id/prepare", async (request) => {
    const { id } = parseParams(IdParams, request);
    const body = parseBody(PrepareBody, request);
    return prepareApplication(request.ctx.workspace(), { jobId: id, force: body.force, resumeId: body.resumeId });
  });

  router.post("/api/jobs/:id/dismiss", (request) => {
    const { id } = parseParams(IdParams, request);
    const body = parseBody(DismissBody, request);
    return dismissJob(request.ctx.workspace(), { jobId: id, reason: body.reason });
  });

  router.post("/api/jobs/:id/restore", (request) => {
    const { id } = parseParams(IdParams, request);
    parseBody(z.object({}).strict(), request);
    return restoreJob(request.ctx.workspace(), id);
  });

  /** Checks the posting now (one ATS request, then its page if needed) and stores the verdict. */
  router.post("/api/jobs/:id/liveness", async (request) => {
    const { id } = parseParams(IdParams, request);
    const body = parseBody(LivenessBody, request);
    const workspace = request.ctx.workspace();
    const job = requireJob(workspace, id);
    const verdict = await checkLiveness(workspace, job, { force: body.force ?? true });
    return { verdict, legitimacy: legitimacyOf(workspace, job) };
  });
}
