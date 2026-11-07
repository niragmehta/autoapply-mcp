import type { Workspace } from "../config/load.js";
import { withTransaction } from "../db/repositories/followups.js";
import { recordApplicationOutcome } from "./outcomes.js";
import { activeSnooze, cadenceExclusion, daysBetween, lastContactAt, loadFollowUpStates, scheduleFor } from "./state.js";

/**
 * Closes long-silent applications as ghosted.
 *
 * Left open, an application nobody will answer keeps reading as "in flight"
 * in every count and keeps its follow-up reminders alive. Closing waits
 * ghostAfterDays from submission, and at least a week after the last
 * follow-up the candidate sent, so a recent nudge buys the employer time. Dry
 * run unless told otherwise; each closure is tagged so it can be told apart
 * from a real rejection and revived by a later reply.
 */

export type StaleCandidate = {
  applicationId: string;
  company: string;
  title: string;
  submittedAt: string;
  lastContactAt: string;
  silentDays: number;
};

export type StaleSkip = { applicationId: string; company: string; title: string; reason: string };

export type StaleResult = {
  dryRun: boolean;
  ghostAfterDays: number;
  closed: StaleCandidate[];
  skipped: StaleSkip[];
};

export function closeStaleApplications(workspace: Workspace, options: { dryRun?: boolean; now?: Date } = {}): StaleResult {
  const dryRun = options.dryRun !== false;
  const now = options.now ?? new Date();
  const policy = workspace.campaign.followUps;
  const closed: StaleCandidate[] = [];
  const skipped: StaleSkip[] = [];
  for (const state of loadFollowUpStates(workspace.db)) {
    if (state.outcomes.terminal) continue;
    const { applicationId, company, title, submittedAt } = state.application;
    const due = scheduleFor(state, policy).close;
    if (due.getTime() > now.getTime()) continue;
    const exclusion = cadenceExclusion(state);
    if (exclusion) {
      skipped.push({ applicationId, company, title, reason: exclusion });
      continue;
    }
    const snoozed = activeSnooze(state, now);
    if (snoozed) {
      skipped.push({ applicationId, company, title, reason: `snoozed until ${snoozed.slice(0, 10)}` });
      continue;
    }
    const contact = lastContactAt(state);
    closed.push({ applicationId, company, title, submittedAt, lastContactAt: contact, silentDays: Math.floor(daysBetween(contact, now)) });
  }
  if (!dryRun) {
    const today = now.toISOString().slice(0, 10);
    withTransaction(workspace.db, () => {
      for (const candidate of closed) {
        recordApplicationOutcome(workspace.db, {
          applicationId: candidate.applicationId,
          kind: "ghosted",
          detail: `no response in ${candidate.silentDays} days since ${candidate.lastContactAt.slice(0, 10)} (auto-closed ${today})`,
          event: "outcome.auto_closed",
          payload: { silentDays: candidate.silentDays },
        });
      }
    });
  }
  return { dryRun, ghostAfterDays: policy.ghostAfterDays, closed, skipped };
}
