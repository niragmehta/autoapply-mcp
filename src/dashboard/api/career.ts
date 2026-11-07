import { z } from "zod";
import { listContacts } from "../../career/contacts.js";
import { listInterviews } from "../../career/interviews.js";
import { compareOffers, listOffers } from "../../career/offers.js";
import { listOutreachDrafts, markOutreach } from "../../career/outreach.js";
import { companyNotes } from "../../career/research.js";
import { listStories, storyBankScaffold } from "../../career/stories.js";
import {
  CONTACT_KINDS,
  INTERVIEW_STATUSES,
  NOTE_KINDS,
  OFFER_STATUSES,
  OUTREACH_CHANNELS,
  OUTREACH_STATUSES,
  SESSION_KINDS,
} from "../../career/types.js";
import { getApplication } from "../../db/repositories/applications.js";
import { getInterview, listSessionRecords } from "../../db/repositories/career/interviews.js";
import { getJob } from "../../db/repositories/jobs.js";
import type { Db } from "../../db/database.js";
import { interviewIcs } from "../../followup/ics.js";
import { AppError } from "../../util/errors.js";
import { listRecentCompanyNotes } from "../queries/career.js";
import { DownloadReply, parseBody, parseParams, parseQuery, safeDownloadName, type Router } from "../router.js";
import { IdParams, queryBool, queryInt, queryText } from "./shared.js";

/**
 * Interviews and offers: the schedule with calendar files, prep and debrief
 * sessions, offers side by side, the story bank, contacts with outreach
 * drafts, and company research notes. Drafts are copied, never sent; marking
 * one "sent" records that the person sent it themselves.
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

const OffersQuery = z.object({ status: z.preprocess(blank, z.enum(OFFER_STATUSES).optional()), applicationId: queryText() });

const CompareQuery = z.object({ includeClosed: queryBool });

const StoriesQuery = z.object({ tag: queryText(100), skill: queryText(100), limit: queryInt(1, 500, 200) });

const ContactsQuery = z.object({
  company: queryText(),
  kind: z.preprocess(blank, z.enum(CONTACT_KINDS).optional()),
  applicationId: queryText(),
  limit: queryInt(1, 500, 200),
});

const OutreachQuery = z.object({
  applicationId: queryText(),
  contactId: queryText(),
  company: queryText(),
  status: z.preprocess(blank, z.enum(OUTREACH_STATUSES).optional()),
  channel: z.preprocess(blank, z.enum(OUTREACH_CHANNELS).optional()),
  limit: queryInt(1, 500, 100),
});

const OutreachMarkBody = z.object({ status: z.enum(OUTREACH_STATUSES) }).strict();

const NotesQuery = z.object({
  company: queryText(),
  kind: z.preprocess(blank, z.enum(NOTE_KINDS).optional()),
  limit: queryInt(1, 500, 100),
});

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
  return { company: job?.companyName ?? "unknown", title: job?.title ?? "unknown", url: job?.url ?? "" };
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

  router.get("/api/interviews/:id", (request) => {
    const { id } = parseParams(IdParams, request);
    const { db } = request.ctx.workspace();
    const interview = getInterview(db, id);
    if (!interview) throw new AppError("interview_not_found", `no interview ${id}`);
    const sessions = listSessionRecords(db, { applicationId: interview.applicationId, limit: 50 }).filter(
      (session) => session.interviewId === null || session.interviewId === interview.id,
    );
    return { interview: { ...interview, ...roleOf(db, interview.applicationId) }, sessions };
  });

  /** A calendar file for one scheduled interview, generated on request and never written to disk. */
  router.get("/api/interviews/:id/ics", (request) => {
    const { id } = parseParams(IdParams, request);
    const { db } = request.ctx.workspace();
    const interview = getInterview(db, id);
    if (!interview) throw new AppError("interview_not_found", `no interview ${id}`);
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

  router.get("/api/offers", (request) => {
    const query = parseQuery(OffersQuery, request);
    const offers = listOffers(request.ctx.workspace(), { status: query.status, applicationId: query.applicationId });
    return { count: offers.length, offers };
  });

  router.get("/api/offers/compare", (request) => {
    const query = parseQuery(CompareQuery, request);
    return compareOffers(request.ctx.workspace(), { includeClosed: query.includeClosed === true });
  });

  router.get("/api/stories", (request) => {
    const query = parseQuery(StoriesQuery, request);
    const stories = listStories(request.ctx.workspace(), { tag: query.tag, skill: query.skill, limit: query.limit });
    return { count: stories.length, stories };
  });

  router.get("/api/stories/scaffold", ({ ctx }) => storyBankScaffold(ctx.workspace()));

  router.get("/api/contacts", (request) => {
    const query = parseQuery(ContactsQuery, request);
    const contacts = listContacts(request.ctx.workspace(), {
      company: query.company,
      kind: query.kind,
      applicationId: query.applicationId,
      limit: query.limit,
    });
    return { count: contacts.length, contacts };
  });

  router.get("/api/outreach", (request) => {
    const query = parseQuery(OutreachQuery, request);
    const drafts = listOutreachDrafts(request.ctx.workspace(), {
      applicationId: query.applicationId,
      contactId: query.contactId,
      company: query.company,
      status: query.status,
      channel: query.channel,
      limit: query.limit,
    });
    return { count: drafts.length, drafts };
  });

  router.post("/api/outreach/:id/mark", (request) => {
    const { id } = parseParams(IdParams, request);
    const body = parseBody(OutreachMarkBody, request);
    return markOutreach(request.ctx.workspace(), id, body.status);
  });

  router.get("/api/company-notes", (request) => {
    const query = parseQuery(NotesQuery, request);
    const workspace = request.ctx.workspace();
    const notes = query.company
      ? companyNotes(workspace, query.company, { kind: query.kind, limit: query.limit })
      : listRecentCompanyNotes(workspace.db, { kind: query.kind, limit: query.limit });
    return { company: query.company ?? null, count: notes.length, notes };
  });
}
