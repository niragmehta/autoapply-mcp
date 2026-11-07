import type { Workspace } from "../../config/load.js";
import { listInterviews } from "../../career/interviews.js";
import { listOffers } from "../../career/offers.js";
import { listRuns, type RunRecord } from "../../db/repositories/runs.js";
import { followUpsDue } from "../../followup/cadence.js";
import { careerContactLookup } from "../../followup/contacts.js";
import { toErrorMessage } from "../../util/errors.js";
import { logger } from "../../util/logger.js";

/**
 * The notifications tray: what is coming up and what just happened.
 * Interviews within 48 hours, undecided offers whose deadline is within 7
 * days, follow-ups due today, and runs that finished or failed in the last
 * day. Each item has a stable id, so the browser can remember what was seen.
 */

export type Notice = {
  id: string;
  kind: "interview" | "offer" | "follow-up" | "run";
  title: string;
  detail: string;
  at: string | null;
  href: string;
  tone: "ok" | "bad" | "held" | "info";
};

const HOUR_MS = 3_600_000;
const INTERVIEW_HOURS = 48;
const OFFER_DAYS = 7;
const RUN_HOURS = 24;
const UNDECIDED = new Set(["received", "negotiating"]);
const FINISHED = new Set(["succeeded", "failed", "interrupted", "cancelled"]);

const STAGE_TEXT: Record<string, string> = {
  recruiter_screen: "Recruiter screen",
  hiring_manager: "Hiring manager interview",
  technical: "Technical interview",
  system_design: "System design interview",
  behavioral: "Behavioral interview",
  onsite: "Onsite",
  other: "Interview",
};

function safely<T>(part: string, read: () => T[]): T[] {
  try {
    return read();
  } catch (error) {
    logger.warn("notifications part failed", { part, error: toErrorMessage(error) });
    return [];
  }
}

export function runNotice(run: Pick<RunRecord, "id" | "type" | "status" | "finishedAt" | "error">): Notice {
  const failed = run.status === "failed" || run.status === "interrupted";
  return {
    id: `run:${run.id}:${run.status}`,
    kind: "run",
    title: `${run.type.charAt(0).toUpperCase()}${run.type.slice(1)} run ${run.status === "succeeded" ? "finished" : run.status}`,
    detail: failed && run.error ? run.error.slice(0, 160) : run.status === "cancelled" ? "Stopped before it finished." : "Open it for the summary and log.",
    at: run.finishedAt,
    href: `/runs?run=${encodeURIComponent(run.id)}`,
    tone: failed ? "bad" : run.status === "succeeded" ? "ok" : "info",
  };
}

export function notificationsFor(workspace: Workspace, now = Date.now()): Notice[] {
  const interviews = safely("interviews", () => listInterviews(workspace, { upcoming: true, limit: 50 }))
    .filter((interview) => interview.scheduledAt !== null && Date.parse(interview.scheduledAt) - now <= INTERVIEW_HOURS * HOUR_MS && Date.parse(interview.scheduledAt) >= now - HOUR_MS)
    .map(
      (interview): Notice => ({
        id: `interview:${interview.id}:${interview.scheduledAt}`,
        kind: "interview",
        title: `${STAGE_TEXT[interview.stage] ?? "Interview"} with ${interview.company}`,
        detail: interview.title,
        at: interview.scheduledAt,
        href: `/interviews?interview=${encodeURIComponent(interview.id)}`,
        tone: "info",
      }),
    );
  const offers = safely("offers", () => listOffers(workspace, { limit: 100 }))
    .filter((offer) => UNDECIDED.has(offer.status) && offer.daysToDeadline !== null && offer.daysToDeadline >= 0 && offer.daysToDeadline <= OFFER_DAYS)
    .map(
      (offer): Notice => ({
        id: `offer:${offer.id}:${offer.deadline}`,
        kind: "offer",
        title: `Decide on ${offer.company} by ${offer.deadline}`,
        detail: offer.daysToDeadline === 0 ? "The deadline is today." : `${offer.daysToDeadline} day${offer.daysToDeadline === 1 ? "" : "s"} left.`,
        at: offer.deadline,
        href: `/offers?offer=${encodeURIComponent(offer.id)}`,
        tone: (offer.daysToDeadline ?? OFFER_DAYS) <= 2 ? "held" : "info",
      }),
    );
  const followUps = safely("follow-ups", () => followUpsDue(workspace, { horizonDays: 0, contactLookup: careerContactLookup(workspace.db) }).due).map(
    (due): Notice => ({
      id: `follow-up:${due.applicationId}:${due.kind}`,
      kind: "follow-up",
      title: `Follow up with ${due.company}`,
      detail: `${due.title}; ${due.overdueDays > 0 ? `${due.overdueDays} day${due.overdueDays === 1 ? "" : "s"} overdue` : "due today"}.`,
      at: due.dueDate,
      href: "/follow-ups",
      tone: due.overdueDays > 0 ? "held" : "info",
    }),
  );
  const runs = safely("runs", () => listRuns(workspace.db, { limit: 30 }))
    .filter((run) => FINISHED.has(run.status) && run.finishedAt !== null && now - Date.parse(run.finishedAt) <= RUN_HOURS * HOUR_MS)
    .map(runNotice);
  return [...interviews, ...offers, ...followUps, ...runs];
}
