import {
  isProgressOutcome,
  isTerminalOutcome,
  PROGRESS_OUTCOMES,
  progressRank,
  type OutcomeKind,
  type ProgressOutcome,
  type TerminalOutcome,
} from "../domain/policies/followup.js";

/**
 * Reads an application's outcome history as a position in the hiring process.
 *
 * History is cumulative ("ever reached"): an application rejected after an
 * interview still reached the interview. That is the only reading under which
 * stage counts and conversion rates mean what they say.
 */

export type OutcomeEntry = { status: string; notedAt: string };

/** Outcomes that are an employer answering, as opposed to the candidate or the calendar deciding. */
export const REPLY_OUTCOMES: readonly OutcomeKind[] = [...PROGRESS_OUTCOMES, "rejected"];

export function isReplyOutcome(kind: string): boolean {
  return (REPLY_OUTCOMES as readonly string[]).includes(kind);
}

export type OutcomeSummary = {
  furthestStage: ProgressOutcome | null;
  furthestRank: number;
  /** Every kind recorded at least once. */
  reached: ReadonlySet<string>;
  /** The terminal state the application is in now, if any. */
  terminal: TerminalOutcome | null;
  /** Any employer reply, rejection included. */
  responded: boolean;
  /** A reply beyond an automatic acknowledgement. */
  respondedBeyondAcknowledgement: boolean;
  /** When each kind was first recorded. */
  firstAt: Partial<Record<OutcomeKind, string>>;
  firstReplyAt: string | null;
};

/**
 * A later reply revives an application closed as ghosted: the silence that
 * closed it was an assumption. A rejection or withdrawal is only reopened by a
 * real step forward (a screen or later), never by a lagging acknowledgement.
 */
function activeTerminal(sorted: readonly OutcomeEntry[]): TerminalOutcome | null {
  let terminal: TerminalOutcome | null = null;
  for (const entry of sorted) {
    if (isTerminalOutcome(entry.status)) {
      terminal = entry.status;
      continue;
    }
    if (!terminal || !isProgressOutcome(entry.status)) continue;
    if (terminal === "ghosted" || progressRank(entry.status) >= progressRank("recruiter_screen")) terminal = null;
  }
  return terminal;
}

export function summarizeOutcomes(history: readonly OutcomeEntry[]): OutcomeSummary {
  const sorted = [...history].sort((a, b) => a.notedAt.localeCompare(b.notedAt));
  const firstAt: Partial<Record<OutcomeKind, string>> = {};
  let furthestRank = 0;
  let furthestStage: ProgressOutcome | null = null;
  for (const entry of sorted) {
    const kind = entry.status as OutcomeKind;
    if (firstAt[kind] === undefined) firstAt[kind] = entry.notedAt;
    if (isProgressOutcome(entry.status) && progressRank(entry.status) > furthestRank) {
      furthestRank = progressRank(entry.status);
      furthestStage = entry.status;
    }
  }
  const replies = sorted.filter((entry) => isReplyOutcome(entry.status));
  return {
    furthestStage,
    furthestRank,
    reached: new Set(sorted.map((entry) => entry.status)),
    terminal: activeTerminal(sorted),
    responded: replies.length > 0,
    respondedBeyondAcknowledgement: replies.some((entry) => entry.status !== "acknowledged"),
    firstAt,
    firstReplyAt: replies[0]?.notedAt ?? null,
  };
}

type AdvanceCheck = { advances: boolean; reason: string };

/**
 * Whether recording `kind` moves the application on. Used to decide what may
 * be recorded without a person: only a step forward or an ending, never a
 * repeat and never a step back such as an acknowledgement after an interview.
 */
export function advancesApplication(kind: string, summary: OutcomeSummary): AdvanceCheck {
  const terminal = summary.terminal;
  if (terminal && terminal !== "ghosted") {
    return { advances: false, reason: `application already ended as ${terminal}` };
  }
  if (isTerminalOutcome(kind)) {
    return terminal === kind
      ? { advances: false, reason: `already recorded as ${kind}` }
      : { advances: true, reason: `ends the application as ${kind}` };
  }
  if (!isProgressOutcome(kind)) return { advances: false, reason: `${kind} is not an outcome` };
  const rank = progressRank(kind);
  if (rank <= summary.furthestRank) {
    return {
      advances: false,
      reason:
        rank === summary.furthestRank
          ? `already at ${kind}`
          : `already at ${summary.furthestStage}, which is later than ${kind}`,
    };
  }
  return { advances: true, reason: `moves the application from ${summary.furthestStage ?? "submitted"} to ${kind}` };
}
