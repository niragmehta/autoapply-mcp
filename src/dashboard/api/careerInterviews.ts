import { z } from "zod";
import {
  interviewContext,
  InterviewSessionInputSchema,
  listInterviews,
  saveInterviewSession,
  scheduleInterview,
  ScheduleInterviewSchema,
  updateInterview,
  UpdateInterviewSchema,
} from "../../career/interviews.js";
import { INTERVIEW_STAGES, INTERVIEW_STATUSES, SESSION_KINDS } from "../../career/types.js";
import { getApplication } from "../../db/repositories/applications.js";
import { getInterview, listSessionRecords } from "../../db/repositories/career/interviews.js";
import { getJob } from "../../db/repositories/jobs.js";
import type { Db } from "../../db/database.js";
import { interviewIcs } from "../../followup/ics.js";
import { AppError } from "../../util/errors.js";
import { resetAfterApplyCache } from "../queries/afterApply.js";
import { DownloadReply, JsonReply, parseBody, parseParams, parseQuery, safeDownloadName, type Router } from "../router.js";
import { IdParams, queryBounded, queryInt, queryText } from "./shared.js";

/**
 * Interviews: scheduling from an application, rescheduling, cancelling and
 * status changes, a prep sheet built on interviewContext, debriefs and other
 * sessions, and calendar files generated on request.
 */

const DEFAULT_DURATION_MINUTES = 45;

const blank = (value: unknown) => (value === "" ? undefined : value);

const InterviewsQuery = z.object({
  scope: z.preprocess(blank, z.enum(["upcoming", "all"]).default("upcoming")),
  status: z.preprocess(blank, z.enum(INTERVIEW_STATUSES).optional()),
  applicationId: queryText(),
  limit: queryInt(1, 500, 100),
});

const SessionsQuery = z.object({
  applicationId: queryText(),
  interviewId: queryText(),
  kind: z.preprocess(blank, z.enum(SESSION_KINDS).optional()),
  limit: queryInt(1, 200, 50),
});

const PrepQuery = z.object({
  stage: z.preprocess(blank, z.enum(INTERVIEW_STAGES).optional()),
  hours: queryBounded(0.5, 40),
});

const ScheduleBody = ScheduleInterviewSchema.strict();
const UpdateBody = UpdateInterviewSchema.omit({ id: true }).strict();
const SessionBody = InterviewSessionInputSchema.strict();

function isWebLink(value: string): boolean {
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function roleOf(db: Db, applicationId: string) {
  const application = getApplication(db, applicationId);
  const job = application ? getJob(db, application.jobId) : null;
  return { company: job?.companyName ?? "unknown", title: job?.title ?? "unknown", url: job?.url ?? "", jobId: job?.id ?? null };
}

function requireInterview(db: Db, id: string) {
  const interview = getInterview(db, id);
  if (!interview) throw new AppError("interview_not_found", `no interview ${id}`);
  return interview;
}

export function registerRoutes(router: Router): void {
  router.get("/api/interviews", (request) => {
    const query = parseQuery(InterviewsQuery, request);
    const interviews = listInterviews(request.ctx.workspace(), {
      upcoming: query.scope === "upcoming",
      status: query.scope === "upcoming" ? undefined : query.status,
      applicationId: query.applicationId,
      limit: query.limit,
    });
    return { scope: query.scope, count: interviews.length, interviews };
  });

  router.post("/api/interviews", (request) => {
    const body = parseBody(ScheduleBody, request);
    const result = scheduleInterview(request.ctx.workspace(), body);
    resetAfterApplyCache();
    return new JsonReply(201, result);
  });

  router.get("/api/interviews/:id", (request) => {
    const { id } = parseParams(IdParams, request);
    const { db } = request.ctx.workspace();
    const interview = requireInterview(db, id);
    const sessions = listSessionRecords(db, { applicationId: interview.applicationId, limit: 50 }).filter(
      (session) => session.interviewId === null || session.interviewId === interview.id,
    );
    return { interview: { ...interview, ...roleOf(db, interview.applicationId) }, sessions };
  });

  router.patch("/api/interviews/:id", (request) => {
    const { id } = parseParams(IdParams, request);
    const body = parseBody(UpdateBody, request);
    const result = updateInterview(request.ctx.workspace(), { ...body, id });
    resetAfterApplyCache();
    return result;
  });

  /** A prep sheet for one interview: interviewContext for its application, at the interview's own stage unless asked otherwise. */
  router.get("/api/interviews/:id/prep", (request) => {
    const { id } = parseParams(IdParams, request);
    const query = parseQuery(PrepQuery, request);
    const workspace = request.ctx.workspace();
    const interview = requireInterview(workspace.db, id);
    const context = interviewContext(workspace, interview.applicationId, { stage: query.stage ?? interview.stage, hoursAvailable: query.hours });
    return { ...context, interview: { ...interview, ...roleOf(workspace.db, interview.applicationId) } };
  });

  /** A prep sheet for an application with no interview chosen: the next scheduled one's stage, or the one asked for. */
  router.get("/api/applications/:id/prep", (request) => {
    const { id } = parseParams(IdParams, request);
    const query = parseQuery(PrepQuery, request);
    return { ...interviewContext(request.ctx.workspace(), id, { stage: query.stage, hoursAvailable: query.hours }), interview: null };
  });

  /** A calendar file for one scheduled interview, generated on request and never written to disk. */
  router.get("/api/interviews/:id/ics", (request) => {
    const { id } = parseParams(IdParams, request);
    const { db } = request.ctx.workspace();
    const interview = requireInterview(db, id);
    if (!interview.scheduledAt) throw new AppError("interview_unscheduled", "this interview has no time yet");
    const role = roleOf(db, interview.applicationId);
    const link = interview.locationOrLink.trim();
    const panel = interview.interviewers.map((person) => (person.role ? `${person.name} (${person.role})` : person.name)).join(", ");
    const description = [
      `Stage: ${interview.stage.replace(/_/g, " ")}`,
      interview.format ? `Format: ${interview.format}` : "",
      panel ? `Interviewers: ${panel}` : "",
      role.url ? `Posting: ${role.url}` : "",
    ]
      .filter((line) => line.length > 0)
      .join("\n");
    const calendar = interviewIcs({
      title: `Interview: ${role.title} at ${role.company}`,
      start: interview.scheduledAt,
      durationMinutes: interview.durationMinutes ?? DEFAULT_DURATION_MINUTES,
      ...(link ? (isWebLink(link) ? { url: link } : { location: link }) : {}),
      description,
      uid: `${interview.id}@autoapply-mcp`,
    });
    const fileName = safeDownloadName(`interview-${role.company}-${interview.scheduledAt.slice(0, 10)}.ics`, "interview.ics");
    return new DownloadReply(calendar, "text/calendar; charset=utf-8", fileName);
  });

  router.get("/api/interview-sessions", (request) => {
    const query = parseQuery(SessionsQuery, request);
    const sessions = listSessionRecords(request.ctx.workspace().db, {
      applicationId: query.applicationId,
      interviewId: query.interviewId,
      kind: query.kind,
      limit: query.limit,
    });
    return { count: sessions.length, sessions };
  });

  /** A prep plan, practice notes, a debrief or a red-flag review, saved as Markdown. */
  router.post("/api/interview-sessions", (request) => {
    const body = parseBody(SessionBody, request);
    return new JsonReply(201, saveInterviewSession(request.ctx.workspace(), body));
  });
}
