import { z } from "zod";

/**
 * Campaign configuration: what counts as a qualified job, how it is scored,
 * and how far automation is allowed to go. All policy lives here so the server
 * itself stays generic.
 */

const nonEmpty = z.string().trim().min(1);

export const LocationClassSchema = z.enum([
  "bay-area",
  "us-other",
  "canada",
  "remote-us",
  "remote-canada",
  "remote-global",
  "other",
  "unknown",
]);
export type LocationClass = z.infer<typeof LocationClassSchema>;

export const KeywordSchema = z.object({
  term: nonEmpty,
  weight: z.number().min(0).max(10).default(1),
  aliases: z.array(nonEmpty).default([]),
});

export const TrackSchema = z.object({
  id: nonEmpty,
  label: nonEmpty,
  /** Share of the campaign target allocated to this track (0..1). */
  allocation: z.number().min(0).max(1).default(0),
  titleIncludes: z.array(nonEmpty).default([]),
  titleExcludes: z.array(nonEmpty).default([]),
  keywords: z.array(KeywordSchema).default([]),
  resumeId: nonEmpty,
});

export const ScoringWeightsSchema = z.object({
  roleAlignment: z.number().min(0).default(25),
  domainAlignment: z.number().min(0).default(25),
  stackAlignment: z.number().min(0).default(15),
  seniority: z.number().min(0).default(10),
  compensation: z.number().min(0).default(10),
  workAuthorization: z.number().min(0).default(10),
  freshness: z.number().min(0).default(5),
});

export const CompensationPolicySchema = z.object({
  currency: z.string().length(3).default("USD"),
  /** Minimum acceptable total compensation per ISO country code. */
  floors: z.record(z.string(), z.number().positive()),
  /** Static FX rates to the campaign currency. Documented, not fetched. */
  fx: z.record(z.string(), z.number().positive()).default({ USD: 1 }),
  /** Keep postings with no published compensation instead of rejecting them. */
  allowUnknown: z.boolean().default(true),
  /** Reject when the top of the published range is under the floor. */
  rejectBelowFloor: z.boolean().default(true),
});

export const SubmissionPolicySchema = z.object({
  /**
   * manual   - server prepares a packet, a human submits it
   * assisted - server fills the form, a human reviews and confirms the submit
   * auto     - server may submit on allowlisted boards with no blocked questions
   */
  mode: z.enum(["manual", "assisted", "auto"]).default("manual"),
  allowedAtsDomains: z.array(nonEmpty).default([
    "boards.greenhouse.io",
    "job-boards.greenhouse.io",
    "jobs.lever.co",
    "jobs.ashbyhq.com",
  ]),
  allowedCompanies: z.array(nonEmpty).default([]),
  dailyLimit: z.number().int().positive().default(25),
  /**
   * Hard ceiling on how many applications may be prepared or submitted in a
   * single batch. Keeps a run reviewable by a human and avoids tripping ATS
   * rate limiting, which rejects rapid consecutive submissions. Applies even
   * when a caller passes a larger explicit limit.
   */
  maxBatchSize: z.number().int().positive().default(3),
  minDelaySeconds: z.number().int().min(0).default(45),
  /** Question categories that always require a human decision. */
  blockedQuestionCategories: z.array(nonEmpty).default([
    "work-authorization",
    "sponsorship",
    "citizenship",
    "clearance",
    "criminal-history",
    "compensation",
    "demographic",
    "veteran",
    "disability",
    "legal-attestation",
    "essay",
    "reference",
  ]),
  captureScreenshots: z.boolean().default(true),
});

export const CampaignSchema = z.object({
  version: z.literal(1),
  name: nonEmpty,
  targetApplications: z.number().int().positive().default(100),
  tracks: z.array(TrackSchema).min(1),
  locations: z
    .object({
      allow: z.array(LocationClassSchema).min(1),
      includePatterns: z.array(nonEmpty).default([]),
      excludePatterns: z.array(nonEmpty).default([]),
      workplaceTypes: z.array(z.enum(["onsite", "hybrid", "remote", "unknown"])).default([
        "onsite",
        "hybrid",
        "remote",
        "unknown",
      ]),
    })
    .strict(),
  compensation: CompensationPolicySchema,
  seniority: z
    .object({
      allow: z.array(nonEmpty).default(["senior", "staff", "principal", "unspecified"]),
      reject: z.array(nonEmpty).default(["intern", "new-grad", "junior", "manager", "director", "executive"]),
    })
    .prefault({}),
  exclusions: z
    .object({
      titlePatterns: z.array(nonEmpty).default([]),
      descriptionPatterns: z.array(nonEmpty).default([]),
      companies: z.array(nonEmpty).default([]),
    })
    .prefault({}),
  scoring: z
    .object({
      weights: ScoringWeightsSchema.prefault({}),
      thresholds: z
        .object({ tierA: z.number().default(85), tierB: z.number().default(75), tierC: z.number().default(68) })
        .prefault({}),
    })
    .prefault({}),
  freshnessDays: z.number().int().positive().default(45),
  submission: SubmissionPolicySchema.prefault({}),
});

export type Campaign = z.infer<typeof CampaignSchema>;
export type Track = z.infer<typeof TrackSchema>;
export type ScoringWeights = z.infer<typeof ScoringWeightsSchema>;
export type CompensationPolicy = z.infer<typeof CompensationPolicySchema>;
export type SubmissionPolicy = z.infer<typeof SubmissionPolicySchema>;

export const AtsKindSchema = z.enum(["greenhouse", "lever", "ashby"]);
export type AtsKind = z.infer<typeof AtsKindSchema>;

export const CompanySchema = z.object({
  name: nonEmpty,
  ats: AtsKindSchema,
  /** Board token / site slug used by the ATS public API. */
  board: nonEmpty,
  tier: z.enum(["A", "B", "C"]).default("B"),
  tags: z.array(nonEmpty).default([]),
  active: z.boolean().default(true),
  /** Lever and Ashby have EU-hosted instances. */
  region: z.enum(["global", "eu"]).default("global"),
});
export type Company = z.infer<typeof CompanySchema>;

export const CompanyListSchema = z.object({
  version: z.literal(1),
  companies: z.array(CompanySchema),
});
