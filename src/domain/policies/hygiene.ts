import { z } from "zod";

/**
 * Posting hygiene: liveness, repost detection, legitimacy signals, the
 * experience-years gate and the candidate's own do-not-apply list.
 */

const nonEmpty = z.string().trim().min(1);

/**
 * A do-not-apply decision the candidate recorded. `company` entries match the
 * employer name case- and punctuation-insensitively; `domain` entries match the
 * posting host or any subdomain of it.
 */
export const BlacklistEntrySchema = z.object({
  scope: z.enum(["company", "domain"]).default("company"),
  value: nonEmpty,
  reason: z.string().default(""),
  since: z.string().default(""),
});
export type BlacklistEntry = z.infer<typeof BlacklistEntrySchema>;

export const HygienePolicySchema = z
  .object({
    liveness: z
      .object({
        /** Confirm a posting is still open before preparing an application for it. */
        beforePrepare: z.boolean().default(true),
        /** Confirm again immediately before a submission run touches it. */
        beforeSubmit: z.boolean().default(true),
        /** A verdict younger than this is reused rather than re-checked. */
        maxAgeHours: z.number().positive().default(24),
      })
      .prefault({}),
    reposts: z
      .object({
        /** Postings of the same role within this window form one repost cluster. */
        windowDays: z.number().int().positive().default(90),
        /** Distinct postings needed before a role is flagged as reposted. */
        minPostings: z.number().int().min(2).default(2),
      })
      .prefault({}),
    experience: z
      .object({
        /** Professional years; derived from profile.experience when absent. */
        candidateYears: z.number().min(0).optional(),
        /** How far a posting's minimum may exceed the candidate's years before it is flagged. */
        toleranceYears: z.number().min(0).default(1.5),
        /** Reject over-the-tolerance postings at the gate instead of only flagging them. */
        enforce: z.boolean().default(false),
      })
      .prefault({}),
    blacklist: z.array(BlacklistEntrySchema).default([]),
  })
  .prefault({});
export type HygienePolicy = z.infer<typeof HygienePolicySchema>;
