import type { Workspace } from "../../config/load.js";
import { listInterviews } from "../../career/interviews.js";
import { listOffers } from "../../career/offers.js";
import { ACTIVE_OFFER_STATUSES } from "../../career/types.js";
import { countInboxByStatus } from "../../db/repositories/inbox.js";
import { countLeads } from "../../db/repositories/leads.js";
import { followUpsDue } from "../../followup/cadence.js";
import { careerContactLookup } from "../../followup/contacts.js";
import { toErrorMessage } from "../../util/errors.js";
import { logger } from "../../util/logger.js";
import { pendingProposals } from "./leads.js";

/**
 * What happens after applying, at a glance: replies to review, follow-ups due,
 * interviews coming up, offers in play, and new sources to look at. Feeds the
 * Overview's next actions and the navigation badges.
 */

const FOLLOWUP_CACHE_MS = 60_000;
const WEEK_DAYS = 7;

let followupCache: { db: unknown; at: number; due: number } | null = null;

/** Due follow-ups change by the day, not the second, so the polled status reuses a recent count. */
function dueFollowUps(workspace: Workspace, now: number): number {
  if (followupCache && followupCache.db === workspace.db && now - followupCache.at < FOLLOWUP_CACHE_MS) return followupCache.due;
  const due = followUpsDue(workspace, { horizonDays: 0, contactLookup: careerContactLookup(workspace.db) }).due.length;
  followupCache = { db: workspace.db, at: now, due };
  return due;
}

export function resetAfterApplyCache(): void {
  followupCache = null;
}

export type AfterApplySummary = {
  repliesToReview: number;
  followUpsDue: number;
  interviewsThisWeek: number;
  nextInterview: { company: string; title: string; scheduledAt: string; daysUntil: number | null } | null;
  activeOffers: number;
  offersDueThisWeek: number;
  newLeads: number;
  pendingProposals: number;
};

/** Each part degrades to zero on its own: one feature's broken table must not blank the Overview. */
function safely<T>(label: string, fallback: T, read: () => T): T {
  try {
    return read();
  } catch (error) {
    logger.warn("after-apply summary part failed", { part: label, error: toErrorMessage(error) });
    return fallback;
  }
}

const UNDECIDED_OFFER_STATUSES = new Set(["received", "negotiating"]);

export function afterApplySummary(workspace: Workspace, now = Date.now()): AfterApplySummary {
  const interviews = safely("interviews", [], () => listInterviews(workspace, { upcoming: true, limit: 50 }));
  const soon = interviews.filter((interview) => interview.daysUntil !== null && interview.daysUntil <= WEEK_DAYS);
  const next = interviews.find((interview) => interview.scheduledAt !== null) ?? null;
  const offers = safely("offers", [], () => listOffers(workspace, { limit: 100 })).filter((offer) => ACTIVE_OFFER_STATUSES.includes(offer.status));
  const undecided = offers.filter((offer) => UNDECIDED_OFFER_STATUSES.has(offer.status));
  return {
    repliesToReview: safely("inbox", 0, () => countInboxByStatus(workspace.db).proposed),
    followUpsDue: safely("followups", 0, () => dueFollowUps(workspace, now)),
    interviewsThisWeek: soon.length,
    nextInterview: next?.scheduledAt
      ? { company: next.company, title: next.title, scheduledAt: next.scheduledAt, daysUntil: next.daysUntil }
      : null,
    activeOffers: offers.length,
    offersDueThisWeek: undecided.filter((offer) => offer.daysToDeadline !== null && offer.daysToDeadline <= WEEK_DAYS).length,
    newLeads: safely("leads", 0, () =>
      countLeads(workspace.db)
        .filter((count) => count.status === "new")
        .reduce((sum, count) => sum + count.count, 0),
    ),
    pendingProposals: safely("proposals", 0, () => pendingProposals(workspace).proposals.length),
  };
}
