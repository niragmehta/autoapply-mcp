import { z } from "zod";

/** After-apply loop: reading employer replies and following up. */

export const OutcomeKindSchema = z.enum([
  "acknowledged",
  "recruiter_screen",
  "interview",
  "offer",
  "rejected",
  "ghosted",
  "withdrawn",
]);
export type OutcomeKind = z.infer<typeof OutcomeKindSchema>;

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
export type InboxPolicy = z.infer<typeof InboxPolicySchema>;

export const FollowUpPolicySchema = z
  .object({
    enabled: z.boolean().default(true),
    /** Days after submission with no reply before the first follow-up is due. */
    firstAfterDays: z.number().int().positive().default(7),
    /** Days after submission before the second and last follow-up is due. */
    secondAfterDays: z.number().int().positive().default(14),
    /** Days of silence after which an application is recorded as ghosted. */
    ghostAfterDays: z.number().int().positive().default(45),
  })
  .prefault({});
export type FollowUpPolicy = z.infer<typeof FollowUpPolicySchema>;
