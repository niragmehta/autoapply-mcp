import { z } from "zod";
import { AtsKindSchema, LocationClassSchema } from "./campaign.js";

/** Normalized job posting and evaluation records shared across the server. */

export const CompensationRangeSchema = z.object({
  min: z.number().nonnegative().nullable(),
  max: z.number().nonnegative().nullable(),
  currency: z.string().length(3),
  period: z.enum(["year", "month", "hour", "unknown"]).default("year"),
  /** Where the numbers came from, for auditability. */
  source: z.enum(["ats-structured", "description-text", "none"]).default("none"),
  raw: z.string().default(""),
});
export type CompensationRange = z.infer<typeof CompensationRangeSchema>;

export const WorkplaceTypeSchema = z.enum(["onsite", "hybrid", "remote", "unknown"]);
export type WorkplaceType = z.infer<typeof WorkplaceTypeSchema>;

export const JobSchema = z.object({
  id: z.string(),
  fingerprint: z.string(),
  ats: AtsKindSchema,
  companyName: z.string(),
  companyTier: z.enum(["A", "B", "C"]).default("B"),
  board: z.string(),
  externalId: z.string(),
  title: z.string(),
  locationsRaw: z.array(z.string()).default([]),
  locationClass: LocationClassSchema,
  country: z.string().default("unknown"),
  workplaceType: WorkplaceTypeSchema.default("unknown"),
  employmentType: z.string().default("unknown"),
  url: z.string(),
  applyUrl: z.string(),
  descriptionText: z.string().default(""),
  descriptionHash: z.string().default(""),
  compensation: CompensationRangeSchema.nullable().default(null),
  postedAt: z.string().nullable().default(null),
  capturedAt: z.string(),
});
export type Job = z.infer<typeof JobSchema>;

export const EvidenceSchema = z.object({
  term: z.string(),
  quote: z.string(),
});
export type Evidence = z.infer<typeof EvidenceSchema>;

export const ScoreComponentSchema = z.object({
  dimension: z.string(),
  weight: z.number(),
  earned: z.number(),
  rationale: z.string(),
  evidence: z.array(EvidenceSchema).default([]),
});
export type ScoreComponent = z.infer<typeof ScoreComponentSchema>;

export const GateResultSchema = z.object({
  passed: z.boolean(),
  rule: z.string().nullable(),
  reason: z.string(),
  evidence: z.string().default(""),
});
export type GateResult = z.infer<typeof GateResultSchema>;

export const EvaluationSchema = z.object({
  jobId: z.string(),
  decision: z.enum(["reject", "review", "accept"]),
  gate: GateResultSchema,
  trackId: z.string().nullable(),
  score: z.number(),
  tier: z.enum(["A", "B", "C", "none"]),
  components: z.array(ScoreComponentSchema).default([]),
  flags: z.array(z.string()).default([]),
  evaluatedAt: z.string(),
});
export type Evaluation = z.infer<typeof EvaluationSchema>;

export const ApplicationStatusSchema = z.enum([
  "drafted",
  "awaiting_approval",
  "approved",
  "submitted",
  "failed",
  "skipped",
  "needs_human",
]);
export type ApplicationStatus = z.infer<typeof ApplicationStatusSchema>;

export const AnswerSourceSchema = z.enum(["profile", "approved-answer", "human", "blocked"]);

export const DraftAnswerSchema = z.object({
  questionKey: z.string(),
  label: z.string(),
  answer: z.string(),
  source: AnswerSourceSchema,
  citation: z.string().default(""),
  requiresHuman: z.boolean().default(false),
  /**
   * Whether the employer marked the field required. A blank optional field
   * asserts nothing and cannot stop the form submitting, so it is reported but
   * never blocks; a blank required one always does.
   */
  required: z.boolean().default(true),
  category: z.string().default("general"),
  /** Advice shown alongside a question that a person must decide. */
  guidance: z.string().default(""),
});
export type DraftAnswer = z.infer<typeof DraftAnswerSchema>;

export const ApplicationSchema = z.object({
  id: z.string(),
  jobId: z.string(),
  status: ApplicationStatusSchema,
  resumeId: z.string(),
  resumePath: z.string(),
  packetHash: z.string(),
  coverLetter: z.string().default(""),
  answers: z.array(DraftAnswerSchema).default([]),
  blockedQuestions: z.array(z.string()).default([]),
  createdAt: z.string(),
  approvedAt: z.string().nullable().default(null),
  submittedAt: z.string().nullable().default(null),
  submissionMode: z.string().nullable().default(null),
  confirmationRef: z.string().nullable().default(null),
  artifactPath: z.string().nullable().default(null),
  notes: z.string().default(""),
});
export type Application = z.infer<typeof ApplicationSchema>;
