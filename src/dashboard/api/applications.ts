import { z } from "zod";
import { listInterviews } from "../../career/interviews.js";
import { listOffers } from "../../career/offers.js";
import { latestApproval, listOutcomes } from "../../db/repositories/applications.js";
import { getEvaluation } from "../../db/repositories/jobs.js";
import { latestLiveness } from "../../db/repositories/liveness.js";
import { ApplicationStatusSchema } from "../../domain/job.js";
import { OutcomeKindSchema } from "../../domain/policies/followup.js";
import { recordApplicationOutcome } from "../../followup/outcomes.js";
import {
  approveApplication,
  loadApplicationContext,
  previewApplication,
  recordManualSubmission,
  setApplicationContent,
  submitApplication,
} from "../../services/applications.js";
import { AppError } from "../../util/errors.js";
import { isUnresolved, listApplicationRows, listEventRows, type ApplicationSort, APPLICATION_SORTS } from "../queries/applications.js";
import { resetAfterApplyCache } from "../queries/afterApply.js";
import { artifactNameOf, listArtifacts } from "../queries/artifacts.js";
import { scrubHome } from "../queries/files.js";
import { JsonReply, parseBody, parseParams, parseQuery, type ApiRequest, type Router } from "../router.js";
import { IdParams, csvList, paged, queryInt, queryText, sortDir } from "./shared.js";

/** Applications: the table, one packet in full, and every human decision on it. */

/** The outcomes record_outcome accepts; one schema shared with the inbox and follow-up features. */
export const OUTCOME_STATUSES = OutcomeKindSchema.options;

const ApplicationListQuery = z.object({
  status: csvList(ApplicationStatusSchema),
  q: queryText(),
  company: queryText(),
  sort: z.preprocess(
    (value) => (value === "" ? undefined : value),
    z.enum(Object.keys(APPLICATION_SORTS) as [ApplicationSort, ...ApplicationSort[]]).default("created"),
  ),
  dir: z.preprocess((value) => (value === "" ? undefined : value), sortDir.default("desc")),
  page: queryInt(1, 100_000, 1),
  pageSize: queryInt(1, 200, 50),
});

const AnswersBody = z
  .object({
    answers: z
      .array(z.object({ questionKey: z.string().min(1).max(300), answer: z.string().max(20_000) }).strict())
      .max(200)
      .default([]),
    coverLetter: z.string().max(50_000).optional(),
    notes: z.string().max(20_000).optional(),
  })
  .strict();

const ApproveBody = z
  .object({
    packetHash: z.string().trim().min(8).max(128),
    decision: z.enum(["approved", "rejected"]).default("approved"),
    note: z.string().max(2000).optional(),
  })
  .strict();

const SubmitBody = z.object({ mode: z.enum(["manual", "assisted", "auto"]) }).strict();

const RecordSubmissionBody = z
  .object({ confirmationRef: z.string().trim().max(500).optional(), notes: z.string().max(20_000).optional() })
  .strict();

const OutcomeBody = z.object({ status: OutcomeKindSchema, detail: z.string().max(5000).default("") }).strict();

function detail(request: ApiRequest) {
  const { id } = parseParams(IdParams, request);
  const workspace = request.ctx.workspace();
  const { application, job } = loadApplicationContext(workspace, id);
  const preview = previewApplication(workspace, id);
  const evaluation = getEvaluation(workspace.db, job.id);
  const artifacts = listArtifacts(workspace.paths.artifacts).get(application.id) ?? [];
  const stored = artifactNameOf(application.artifactPath);
  return {
    application: {
      id: application.id,
      status: application.status,
      resumeId: application.resumeId,
      resumeFile: application.resumePath.split(/[\\/]/).at(-1) ?? "",
      packetHash: application.packetHash,
      coverLetter: application.coverLetter,
      notes: application.notes,
      createdAt: application.createdAt,
      approvedAt: application.approvedAt,
      submittedAt: application.submittedAt,
      submissionMode: application.submissionMode,
      confirmationRef: application.confirmationRef,
      screenshot: stored,
    },
    job: {
      id: job.id,
      company: job.companyName,
      title: job.title,
      ats: job.ats,
      url: job.url,
      applyUrl: job.applyUrl,
      locations: job.locationsRaw,
      locationClass: job.locationClass,
      compensation: job.compensation?.raw ?? null,
    },
    evaluation: evaluation ? { decision: evaluation.decision, score: evaluation.score, tier: evaluation.tier, trackId: evaluation.trackId } : null,
    liveness: latestLiveness(workspace.db, job.id),
    preview: {
      // The packet names the resume by its full path; the browser gets the home folder as "~".
      text: scrubHome(preview.text),
      packetHash: preview.packetHash,
      storedHashStale: preview.storedHashStale,
      unresolvedRequired: preview.unresolvedRequired,
    },
    answers: application.answers.map((answer) => ({
      questionKey: answer.questionKey,
      label: answer.label,
      answer: answer.answer,
      source: answer.source,
      citation: answer.citation,
      category: answer.category,
      guidance: answer.guidance,
      required: answer.required,
      requiresHuman: answer.requiresHuman,
      notApplicable: answer.notApplicable === true,
      blocked: isUnresolved(answer),
    })),
    approval: latestApproval(workspace.db, application.id),
    outcomes: listOutcomes(workspace.db, application.id),
    interviews: listInterviews(workspace, { applicationId: application.id, limit: 20 }),
    offers: listOffers(workspace, { applicationId: application.id, limit: 10 }).map((offer) => ({
      id: offer.id,
      status: offer.status,
      level: offer.level,
      currency: offer.currency,
      base: offer.base,
      deadline: offer.deadline,
      daysToDeadline: offer.daysToDeadline,
    })),
    // The job's own events (dismissed, restored) explain an application skipped from the Jobs page.
    events: listEventRows(workspace.db, { subjects: [application.id, application.jobId], limit: 50 }),
    artifacts,
  };
}

export function registerRoutes(router: Router): void {
  router.get("/api/applications", (request) => {
    const query = parseQuery(ApplicationListQuery, request);
    const { total, rows } = listApplicationRows(request.ctx.workspace().db, {
      statuses: query.status,
      q: query.q,
      company: query.company,
      sort: query.sort,
      dir: query.dir,
      page: query.page,
      pageSize: query.pageSize,
    });
    return paged(total, query.page, query.pageSize, rows);
  });

  router.get("/api/applications/:id", detail);

  router.post("/api/applications/:id/answers", (request) => {
    const { id } = parseParams(IdParams, request);
    const body = parseBody(AnswersBody, request);
    return setApplicationContent(request.ctx.workspace(), {
      applicationId: id,
      answers: body.answers,
      coverLetter: body.coverLetter,
      notes: body.notes,
    });
  });

  router.post("/api/applications/:id/approve", (request) => {
    const { id } = parseParams(IdParams, request);
    const body = parseBody(ApproveBody, request);
    return approveApplication(request.ctx.workspace(), {
      applicationId: id,
      packetHash: body.packetHash,
      decision: body.decision,
      note: body.note ?? (body.decision === "approved" ? "approved in the dashboard" : "skipped in the dashboard"),
    });
  });

  router.post("/api/applications/:id/submit", async (request) => {
    const { id } = parseParams(IdParams, request);
    const body = parseBody(SubmitBody, request);
    if (body.mode !== "manual") {
      throw new AppError(
        "use_submit_run",
        `${body.mode} submission runs a browser for minutes; start a submit run (POST /api/runs with type "submit") so it can be watched and cancelled`,
      );
    }
    const outcome = await submitApplication(request.ctx.workspace(), { applicationId: id, mode: "manual" });
    return outcome.kind === "manual" ? { applicationId: id, mode: "manual", packetText: scrubHome(outcome.packetText) } : outcome;
  });

  router.post("/api/applications/:id/record-submission", (request) => {
    const { id } = parseParams(IdParams, request);
    const body = parseBody(RecordSubmissionBody, request);
    return recordManualSubmission(request.ctx.workspace(), {
      applicationId: id,
      confirmationRef: body.confirmationRef,
      notes: body.notes,
    });
  });

  router.post("/api/applications/:id/outcome", (request) => {
    const { id } = parseParams(IdParams, request);
    const body = parseBody(OutcomeBody, request);
    const recorded = recordApplicationOutcome(request.ctx.workspace().db, {
      applicationId: id,
      kind: body.status,
      detail: body.detail,
      payload: { via: "dashboard" },
    });
    resetAfterApplyCache();
    return new JsonReply(201, { applicationId: recorded.applicationId, kind: recorded.kind, history: recorded.history });
  });
}
