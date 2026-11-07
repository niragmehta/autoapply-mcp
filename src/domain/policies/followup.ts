import { z } from "zod";

/** After-apply loop: reading employer replies and following up. */

export const OutcomeKindSchema = z.enum([
  "acknowledged",
  "recruiter_screen",
  "assessment",
  "interview",
  "offer",
  "rejected",
  "ghosted",
  "withdrawn",
]);
export type OutcomeKind = z.infer<typeof OutcomeKindSchema>;

/** Outcomes that move an application forward, in the order they happen. */
export const PROGRESS_OUTCOMES = ["acknowledged", "recruiter_screen", "assessment", "interview", "offer"] as const;
export type ProgressOutcome = (typeof PROGRESS_OUTCOMES)[number];

/** Outcomes that end an application. */
export const TERMINAL_OUTCOMES = ["rejected", "ghosted", "withdrawn"] as const;
export type TerminalOutcome = (typeof TERMINAL_OUTCOMES)[number];

/**
 * How far along an outcome puts an application. Terminal outcomes have no
 * rank: a rejection after an interview still means the interview happened.
 */
export function progressRank(kind: string): number {
  const index = (PROGRESS_OUTCOMES as readonly string[]).indexOf(kind);
  return index < 0 ? 0 : index + 1;
}

export function isProgressOutcome(kind: string): kind is ProgressOutcome {
  return (PROGRESS_OUTCOMES as readonly string[]).includes(kind);
}

export function isTerminalOutcome(kind: string): kind is TerminalOutcome {
  return (TERMINAL_OUTCOMES as readonly string[]).includes(kind);
}

export const InboxPolicySchema = z
  .object({
    /** Read the configured mailbox for replies to submitted applications. */
    enabled: z.boolean().default(false),
    /** How far back the first scan reads. Later scans resume from the last one. */
    lookbackDays: z.number().int().positive().default(30),
    /**
     * Outcomes recorded without confirmation when a reply is classified with
     * high confidence. Anything else is proposed for a person to confirm.
     */
    autoRecord: z.array(OutcomeKindSchema).default(["acknowledged", "rejected"]),
  })
  .prefault({});

export const FollowUpPolicySchema = z
  .object({
    enabled: z.boolean().default(true),
    /** Days after submission with no reply before the first follow-up is due. */
    firstAfterDays: z.number().int().positive().default(7),
    /** Days after submission before the second and last follow-up is due. */
    secondAfterDays: z.number().int().positive().default(14),
    /** Days after submission, and at least a week after the last follow-up sent, before a silent application is closed as ghosted. */
    ghostAfterDays: z.number().int().positive().default(45),
  })
  .prefault({});
export type FollowUpPolicy = z.infer<typeof FollowUpPolicySchema>;
