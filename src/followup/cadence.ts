import type { Workspace } from "../config/load.js";
import { appendEvent } from "../db/repositories/events.js";
import {
  FOLLOWUP_KINDS,
  markFollowupDone,
  seedFollowup,
  snoozeFollowup,
  withTransaction,
  type FollowupKind,
  type FollowupRecord,
} from "../db/repositories/followups.js";
import { AppError } from "../util/errors.js";
import { activeSnooze, cadenceExclusion, daysBetween, loadFollowUpStates, scheduleFor, type FollowUpState } from "./state.js";

/**
 * Follow-up cadence for submitted applications that have heard nothing but
 * an automatic acknowledgement: a first nudge, a second, then closing the
 * application as ghosted. Drafts are suggestions for the candidate to send
 * themselves; nothing here sends anything.
 */

export type FollowUpChannel = { channel: string; detail: string; /** Who to greet, when known. */ name?: string };

/**
 * Where a follow-up should go for an application, or null when nobody is on
 * file. The contacts table (src/career) is expected to provide this; until it
 * is wired in through this hook every application reports "no contact on file".
 */
export type FollowUpContactLookup = (target: { applicationId: string; company: string; title: string }) => FollowUpChannel | null;

export const noContactOnFile: FollowUpContactLookup = () => null;

const NO_CONTACT: FollowUpChannel = { channel: "none", detail: "no contact on file" };

export type DueFollowUp = {
  applicationId: string;
  company: string;
  title: string;
  url: string;
  submittedAt: string;
  kind: FollowupKind;
  dueDate: string;
  daysSinceSubmission: number;
  overdueDays: number;
  channel: FollowUpChannel;
  draft: string;
  suggestion: string;
  note: string;
};

export type FollowUpPlan = {
  enabled: boolean;
  asOf: string;
  policy: { firstAfterDays: number; secondAfterDays: number; ghostAfterDays: number };
  due: DueFollowUp[];
  upcoming: Array<Pick<DueFollowUp, "applicationId" | "company" | "title" | "kind" | "dueDate">>;
  excluded: Record<string, number>;
};

export type FollowUpOptions = {
  now?: Date;
  contactLookup?: FollowUpContactLookup;
  /** How far ahead "upcoming" looks, in days. */
  horizonDays?: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const isoDate = (date: Date): string => date.toISOString().slice(0, 10);

function nextPending(state: FollowUpState): FollowupKind | null {
  const lastDone = FOLLOWUP_KINDS.reduce((index, kind, position) => (state.followups.get(kind)?.doneAt ? position : index), -1);
  return FOLLOWUP_KINDS[lastDone + 1] ?? null;
}

/** When a reminder is due: its scheduled date, or the end of its snooze if that is later. */
function effectiveDue(state: FollowUpState, kind: FollowupKind, schedule: Record<FollowupKind, Date>): Date {
  const snoozed = Date.parse(state.followups.get(kind)?.snoozedUntil ?? "");
  return new Date(Math.max(schedule[kind].getTime(), Number.isFinite(snoozed) ? snoozed : 0));
}

function draftFor(kind: FollowupKind, state: FollowUpState, candidateName: string, channel: FollowUpChannel): string {
  const { company, title, submittedAt } = state.application;
  const greeting = channel.name ? `Hi ${channel.name},` : "Hello,";
  const applied = isoDate(new Date(submittedAt));
  if (kind === "first") {
    return [
      greeting,
      "",
      `I applied for the ${title} role at ${company} on ${applied} and wanted to follow up. I'm still very interested and would welcome the chance to talk about how my background fits the team.`,
      "Is there any update you can share on the timeline?",
      "",
      "Thank you,",
      candidateName,
    ].join("\n");
  }
  if (kind === "second") {
    return [
      greeting,
      "",
      `I wanted to check in once more on my application for the ${title} role at ${company}, submitted on ${applied}. I remain interested and am happy to share anything else that would help your review.`,
      "",
      "Thank you for your time,",
      candidateName,
    ].join("\n");
  }
  return "";
}

function suggestionFor(kind: FollowupKind, channel: FollowUpChannel, days: number): string {
  if (kind === "close") {
    return `No reply in ${days} days. Close it as ghosted with close_stale_applications, or snooze it if you expect news.`;
  }
  const where = channel.channel === "none" ? "No contact is on file: reply to the application's confirmation email, or find the recruiter first." : `Send via ${channel.channel}.`;
  return `${kind === "first" ? "First" : "Second and last"} follow-up. ${where} Review and personalise the draft; it is never sent for you.`;
}

/** Creates or re-dates every active application's reminder rows in one transaction. */
function seedReminders(workspace: Workspace, states: readonly FollowUpState[]): void {
  withTransaction(workspace.db, () => {
    for (const state of states) {
      const schedule = scheduleFor(state, workspace.campaign.followUps);
      for (const kind of FOLLOWUP_KINDS) {
        seedFollowup(workspace.db, { applicationId: state.application.applicationId, kind, dueAt: schedule[kind].toISOString() });
      }
    }
  });
}

function exclusionCounts(states: readonly FollowUpState[]): Record<string, number> {
  const counts = new Map<string, number>();
  for (const state of states) {
    const exclusion = cadenceExclusion(state);
    if (!exclusion) continue;
    const bucket = exclusion.replace(/\s*\(.*\)$/, "");
    counts.set(bucket, (counts.get(bucket) ?? 0) + 1);
  }
  return Object.fromEntries(counts);
}

type Pending = { state: FollowUpState; kind: FollowupKind; dueAt: Date };

function pendingFollowUp(state: FollowUpState, workspace: Workspace, now: Date): Pending | null {
  const kind = nextPending(state);
  if (!kind) return null;
  const schedule = scheduleFor(state, workspace.campaign.followUps);
  // Past the close date the remaining follow-ups are moot: the next step is
  // closing it, exactly as close_stale_applications would, unless a snooze holds it.
  if (kind !== "close" && schedule.close.getTime() <= now.getTime()) {
    const snoozed = activeSnooze(state, now);
    return { state, kind: "close", dueAt: snoozed ? new Date(snoozed) : schedule.close };
  }
  return { state, kind, dueAt: effectiveDue(state, kind, schedule) };
}

function headline(pending: Pending): FollowUpPlan["upcoming"][number] {
  const { application } = pending.state;
  return { applicationId: application.applicationId, company: application.company, title: application.title, kind: pending.kind, dueDate: isoDate(pending.dueAt) };
}

function describeDue(pending: Pending, workspace: Workspace, lookup: FollowUpContactLookup, now: Date): DueFollowUp {
  const summary = headline(pending);
  const channel = lookup(summary) ?? NO_CONTACT;
  const days = Math.floor(daysBetween(pending.state.application.submittedAt, now));
  return {
    ...summary,
    url: pending.state.application.url,
    submittedAt: pending.state.application.submittedAt,
    daysSinceSubmission: days,
    overdueDays: Math.floor((now.getTime() - pending.dueAt.getTime()) / DAY_MS),
    channel,
    draft: draftFor(pending.kind, pending.state, workspace.profile.identity.fullName, channel),
    suggestion: suggestionFor(pending.kind, channel, days),
    note: pending.state.followups.get(pending.kind)?.note ?? "",
  };
}

/**
 * Due and upcoming follow-ups. Reminder rows are seeded (or re-dated after a
 * cadence change) as a side effect, so other views can read them directly.
 */
export function followUpsDue(workspace: Workspace, options: FollowUpOptions = {}): FollowUpPlan {
  const policy = workspace.campaign.followUps;
  const now = options.now ?? new Date();
  const horizon = now.getTime() + (options.horizonDays ?? 7) * DAY_MS;
  const plan: FollowUpPlan = {
    enabled: policy.enabled,
    asOf: now.toISOString(),
    policy: { firstAfterDays: policy.firstAfterDays, secondAfterDays: policy.secondAfterDays, ghostAfterDays: policy.ghostAfterDays },
    due: [],
    upcoming: [],
    excluded: {},
  };
  if (!policy.enabled) return plan;
  const states = loadFollowUpStates(workspace.db);
  const active = states.filter((state) => cadenceExclusion(state) === null);
  seedReminders(workspace, active);
  const pending = active.map((state) => pendingFollowUp(state, workspace, now)).filter((entry): entry is Pending => entry !== null);
  return {
    ...plan,
    due: pending
      .filter((entry) => entry.dueAt.getTime() <= now.getTime())
      .map((entry) => describeDue(entry, workspace, options.contactLookup ?? noContactOnFile, now))
      .sort((a, b) => b.overdueDays - a.overdueDays),
    upcoming: pending
      .filter((entry) => entry.dueAt.getTime() > now.getTime() && entry.dueAt.getTime() <= horizon)
      .map(headline)
      .sort((a, b) => a.dueDate.localeCompare(b.dueDate)),
    excluded: exclusionCounts(states),
  };
}

export type MarkFollowUpInput = {
  applicationId: string;
  kind: FollowupKind;
  /** done: the candidate sent it. skip: resolved without sending. snooze: due again in `days`. */
  action: "done" | "skip" | "snooze";
  /** Snooze length in days. Defaults to 3. */
  days?: number;
  note?: string;
  now?: Date;
};

export type MarkedFollowUp = { record: FollowupRecord; next: { kind: FollowupKind; dueDate: string } | null };

export function markFollowUp(workspace: Workspace, input: MarkFollowUpInput): MarkedFollowUp {
  const now = input.now ?? new Date();
  const states = loadFollowUpStates(workspace.db);
  const state = states.find((entry) => entry.application.applicationId === input.applicationId);
  if (!state) {
    throw new AppError("application_not_submitted", `no submitted application ${input.applicationId}; follow-ups apply after submission`);
  }
  const schedule = scheduleFor(state, workspace.campaign.followUps);
  const dueAt = schedule[input.kind].toISOString();
  const record =
    input.action === "snooze"
      ? snoozeFollowup(workspace.db, {
          applicationId: input.applicationId,
          kind: input.kind,
          dueAt,
          until: new Date(now.getTime() + Math.max(1, input.days ?? 3) * DAY_MS).toISOString(),
          note: input.note,
        })
      : markFollowupDone(workspace.db, {
          applicationId: input.applicationId,
          kind: input.kind,
          dueAt,
          doneAt: now.toISOString(),
          note: input.note,
          skipped: input.action === "skip",
        });
  const eventType = { done: "followup.done", skip: "followup.skipped", snooze: "followup.snoozed" }[input.action];
  appendEvent(workspace.db, eventType, input.applicationId, {
    kind: input.kind,
    ...(input.action === "snooze" ? { until: record.snoozedUntil } : {}),
  });
  const refreshed = loadFollowUpStates(workspace.db).find((entry) => entry.application.applicationId === input.applicationId);
  const nextKind = refreshed && !cadenceExclusion(refreshed) ? nextPending(refreshed) : null;
  const next =
    refreshed && nextKind
      ? { kind: nextKind, dueDate: isoDate(effectiveDue(refreshed, nextKind, scheduleFor(refreshed, workspace.campaign.followUps))) }
      : null;
  return { record, next };
}
