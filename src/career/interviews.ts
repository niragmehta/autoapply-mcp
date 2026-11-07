import { z } from "zod";
import { appendEvent } from "../db/repositories/events.js";
import {
  getInterview,
  insertSessionRecord,
  listInterviewRecords,
  saveInterviewRecord,
} from "../db/repositories/career/interviews.js";
import { AppError } from "../util/errors.js";
import { newId, nowIso } from "../util/hash.js";
import { daysUntil, parseInput, recordOutcomeOnce, requireApplication, toIsoDateTime, type CareerWorkspace } from "./context.js";
import { STAGE_GUIDES } from "./interviewGuides.js";
import { panelHints } from "./panelists.js";
import {
  INTERVIEW_STAGES,
  INTERVIEW_STATUSES,
  SESSION_KINDS,
  type Interview,
  type InterviewSession,
  type InterviewStage,
} from "./types.js";

/**
 * Interviews and their prep sessions. Scheduling a round also records the
 * matching application outcome (recruiter_screen or interview) once, so
 * conversion rates stay right without a separate record_outcome call.
 */

export { interviewContext } from "./interviewContext.js";

const InterviewerSchema = z.object({
  name: z.string().trim().min(1).max(120),
  role: z.string().trim().max(160).default("").describe("Their job title, e.g. 'Engineering Manager'."),
});

export const ScheduleInterviewSchema = z.object({
  applicationId: z.string().trim().min(1),
  stage: z.enum(INTERVIEW_STAGES),
  scheduledAt: z.string().trim().min(1).optional().describe("ISO 8601 date-time with offset, e.g. 2026-11-12T10:00:00-08:00."),
  durationMinutes: z.number().int().positive().max(1440).optional(),
  format: z.string().trim().max(100).default("").describe("e.g. video, phone, onsite, take-home."),
  locationOrLink: z.string().trim().max(500).default(""),
  interviewers: z.array(InterviewerSchema).max(20).default([]),
  notes: z.string().max(10_000).default(""),
});
type ScheduleInterviewInput = z.input<typeof ScheduleInterviewSchema>;

export const UpdateInterviewSchema = z.object({
  id: z.string().trim().min(1),
  stage: z.enum(INTERVIEW_STAGES).optional(),
  scheduledAt: z.string().trim().min(1).nullable().optional().describe("null clears the time."),
  durationMinutes: z.number().int().positive().max(1440).nullable().optional(),
  format: z.string().trim().max(100).optional(),
  locationOrLink: z.string().trim().max(500).optional(),
  interviewers: z.array(InterviewerSchema).max(20).optional(),
  status: z.enum(INTERVIEW_STATUSES).optional(),
  notes: z.string().max(10_000).optional().describe("Replaces the notes."),
});
type UpdateInterviewInput = z.input<typeof UpdateInterviewSchema>;

export const InterviewSessionInputSchema = z.object({
  applicationId: z.string().trim().min(1),
  interviewId: z.string().trim().min(1).optional(),
  kind: z.enum(SESSION_KINDS),
  content: z.string().trim().min(1).max(100_000).describe("Markdown."),
});
type InterviewSessionInput = z.input<typeof InterviewSessionInputSchema>;

function outcomeFor(stage: InterviewStage): "recruiter_screen" | "interview" {
  return stage === "recruiter_screen" ? "recruiter_screen" : "interview";
}

function outcomeDetail(interview: Interview): string {
  const label = STAGE_GUIDES[interview.stage].label;
  return interview.scheduledAt ? `${label} scheduled for ${interview.scheduledAt}` : `${label} scheduled`;
}

export function scheduleInterview(workspace: Pick<CareerWorkspace, "db">, input: ScheduleInterviewInput) {
  const parsed = parseInput(ScheduleInterviewSchema, input, "interview");
  const { db } = workspace;
  const { application, job } = requireApplication(db, parsed.applicationId);
  const now = nowIso();
  const interview: Interview = {
    id: newId("int"),
    applicationId: application.id,
    stage: parsed.stage,
    scheduledAt: parsed.scheduledAt ? toIsoDateTime(parsed.scheduledAt, "scheduledAt") : null,
    durationMinutes: parsed.durationMinutes ?? null,
    format: parsed.format,
    locationOrLink: parsed.locationOrLink,
    interviewers: parsed.interviewers,
    status: "scheduled",
    notes: parsed.notes,
    createdAt: now,
    updatedAt: now,
  };
  saveInterviewRecord(db, interview);
  const outcome = outcomeFor(interview.stage);
  const recorded = recordOutcomeOnce(db, application.id, outcome, outcomeDetail(interview));
  appendEvent(db, "interview.scheduled", interview.id, {
    applicationId: application.id,
    stage: interview.stage,
    outcomeRecorded: recorded ? outcome : null,
  });
  const warnings =
    application.status === "submitted"
      ? []
      : [`Application is ${application.status}; if you applied, record it with record_submission so the campaign counts it.`];
  return {
    interview,
    company: job.companyName,
    title: job.title,
    daysUntil: daysUntil(interview.scheduledAt),
    outcomeRecorded: recorded ? outcome : null,
    panel: panelHints(interview.interviewers),
    warnings,
  };
}

export function updateInterview(workspace: Pick<CareerWorkspace, "db">, input: UpdateInterviewInput) {
  const parsed = parseInput(UpdateInterviewSchema, input, "interview update");
  const { db } = workspace;
  const existing = getInterview(db, parsed.id);
  if (!existing) throw new AppError("interview_not_found", `no interview ${parsed.id}`);
  const next: Interview = {
    ...existing,
    stage: parsed.stage ?? existing.stage,
    scheduledAt:
      parsed.scheduledAt === undefined
        ? existing.scheduledAt
        : parsed.scheduledAt === null
          ? null
          : toIsoDateTime(parsed.scheduledAt, "scheduledAt"),
    durationMinutes: parsed.durationMinutes === undefined ? existing.durationMinutes : parsed.durationMinutes,
    format: parsed.format ?? existing.format,
    locationOrLink: parsed.locationOrLink ?? existing.locationOrLink,
    interviewers: parsed.interviewers ?? existing.interviewers,
    status: parsed.status ?? existing.status,
    notes: parsed.notes ?? existing.notes,
    updatedAt: nowIso(),
  };
  const changed = (Object.keys(next) as Array<keyof Interview>).filter(
    (key) => key !== "updatedAt" && JSON.stringify(next[key]) !== JSON.stringify(existing[key]),
  );
  saveInterviewRecord(db, next);
  const outcome = outcomeFor(next.stage);
  const recorded =
    changed.includes("stage") && next.status !== "cancelled"
      ? recordOutcomeOnce(db, next.applicationId, outcome, outcomeDetail(next))
      : false;
  appendEvent(db, "interview.updated", next.id, { changed, status: next.status });
  return { interview: next, changed, outcomeRecorded: recorded ? outcome : null, panel: panelHints(next.interviewers) };
}

export function saveInterviewSession(workspace: Pick<CareerWorkspace, "db">, input: InterviewSessionInput) {
  const parsed = parseInput(InterviewSessionInputSchema, input, "interview session");
  const { db } = workspace;
  requireApplication(db, parsed.applicationId);
  if (parsed.interviewId) {
    const interview = getInterview(db, parsed.interviewId);
    if (!interview) throw new AppError("interview_not_found", `no interview ${parsed.interviewId}`);
    if (interview.applicationId !== parsed.applicationId) {
      throw new AppError("interview_mismatch", `interview ${interview.id} belongs to application ${interview.applicationId}`);
    }
  }
  const session: InterviewSession = {
    id: newId("isess"),
    interviewId: parsed.interviewId ?? null,
    applicationId: parsed.applicationId,
    kind: parsed.kind,
    content: parsed.content,
    createdAt: nowIso(),
  };
  insertSessionRecord(db, session);
  appendEvent(db, "interview.session_saved", session.id, { applicationId: session.applicationId, kind: session.kind });
  return {
    sessionId: session.id,
    applicationId: session.applicationId,
    interviewId: session.interviewId,
    kind: session.kind,
    characters: session.content.length,
    createdAt: session.createdAt,
  };
}

type InterviewListFilter = {
  /** Scheduled interviews from now on, plus ones not yet given a time. */
  upcoming?: boolean;
  applicationId?: string;
  status?: Interview["status"];
  limit?: number;
};

type InterviewListing = Interview & { company: string; title: string; daysUntil: number | null };

export function listInterviews(workspace: Pick<CareerWorkspace, "db">, filter: InterviewListFilter = {}): InterviewListing[] {
  const { db } = workspace;
  const interviews = listInterviewRecords(db, {
    applicationId: filter.applicationId,
    status: filter.upcoming ? "scheduled" : filter.status,
    from: filter.upcoming ? nowIso() : undefined,
    includeUnscheduled: filter.upcoming === true,
    limit: filter.limit,
  });
  const roles = new Map<string, { company: string; title: string }>();
  const roleOf = (applicationId: string) => {
    const cached = roles.get(applicationId);
    if (cached) return cached;
    let role = { company: "unknown", title: "unknown" };
    try {
      const { job } = requireApplication(db, applicationId);
      role = { company: job.companyName, title: job.title };
    } catch {
      // A missing application leaves the interview listed under "unknown" rather than hiding it.
    }
    roles.set(applicationId, role);
    return role;
  };
  return interviews.map((interview) => ({ ...interview, ...roleOf(interview.applicationId), daysUntil: daysUntil(interview.scheduledAt) }));
}
