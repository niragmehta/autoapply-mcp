import { z } from "zod";

/** Orchestrated runs started from the dashboard or a CLI. */

export const RoundCapSchema = z.object({
  /** At most this many submissions per company within the round. */
  max: z.number().int().positive(),
  /** ISO timestamp the round started; submissions before it do not count. */
  since: z.string().min(1),
});
export type RoundCap = z.infer<typeof RoundCapSchema>;

export const RunnerPolicySchema = z
  .object({
    /** Seconds a submission run waits between applications, on top of submission.minDelaySeconds. */
    paceSeconds: z.number().int().min(0).default(90),
    /** Per-company ceiling for the current round, or null for none. */
    roundCap: RoundCapSchema.nullable().default(null),
    /**
     * Add a company to submission.allowedCompanies just before a run submits to
     * it. Off by default: the allowlist is a deliberate per-company decision.
     */
    autoAllowlist: z.boolean().default(false),
    /** Run the submission browser with a visible window. */
    headed: z.boolean().default(false),
    /** Seconds a submission waits at an email verification gate for the code. */
    codeWaitSeconds: z.number().int().min(0).max(1800).default(300),
  })
  .prefault({});
export type RunnerPolicy = z.infer<typeof RunnerPolicySchema>;
