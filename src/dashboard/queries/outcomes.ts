import {
  OutcomeKindSchema,
  PROGRESS_OUTCOMES,
  TERMINAL_OUTCOMES,
  progressRank,
  type OutcomeKind,
  type TerminalOutcome,
} from "../../domain/policies/followup.js";

/**
 * The outcome taxonomy the dashboard shows, derived from the follow-up
 * policy so the server and the browser never keep their own copies.
 */

/** The terminal outcome an employer sends. Ghosted is silence; withdrawn is the candidate's own decision. */
const EMPLOYER_TERMINAL: readonly TerminalOutcome[] = ["rejected"];

/** Outcomes that mean an employer actually responded: progress beyond an automatic acknowledgement, or a rejection. */
export const RESPONSE_OUTCOMES: readonly OutcomeKind[] = [
  ...PROGRESS_OUTCOMES.filter((kind) => progressRank(kind) > progressRank("acknowledged")),
  ...EMPLOYER_TERMINAL,
];

export type OutcomeTaxonomy = {
  /** Every outcome record_outcome accepts, in pipeline order. */
  kinds: readonly OutcomeKind[];
  progress: readonly OutcomeKind[];
  terminal: readonly OutcomeKind[];
  responses: readonly OutcomeKind[];
  /** How far along each outcome puts an application; terminal outcomes rank 0. */
  rank: Record<OutcomeKind, number>;
};

export function outcomeTaxonomy(): OutcomeTaxonomy {
  return {
    kinds: OutcomeKindSchema.options,
    progress: PROGRESS_OUTCOMES,
    terminal: TERMINAL_OUTCOMES,
    responses: RESPONSE_OUTCOMES,
    rank: Object.fromEntries(OutcomeKindSchema.options.map((kind) => [kind, progressRank(kind)])) as Record<OutcomeKind, number>,
  };
}
