import { z } from "zod";

/**
 * Candidate profile: the single source of verified truth about a person.
 * Everything the server drafts must trace back to this file. Nothing here is
 * invented by a model at runtime.
 */

const nonEmpty = z.string().trim().min(1);

export const SkillLevelSchema = z.enum(["expert", "strong", "working", "familiar"]);

export const SkillSchema = z.object({
  name: nonEmpty,
  aliases: z.array(nonEmpty).default([]),
  level: SkillLevelSchema.default("working"),
  tags: z.array(nonEmpty).default([]),
});

export const FactSchema = z.object({
  id: nonEmpty,
  statement: nonEmpty,
  category: z.string().default("experience"),
  metrics: z.array(nonEmpty).default([]),
  tags: z.array(nonEmpty).default([]),
  evidence: z.string().optional(),
});

export const ExperienceSchema = z.object({
  company: nonEmpty,
  title: nonEmpty,
  location: z.string().default(""),
  start: nonEmpty,
  end: z.string().default("present"),
  highlights: z.array(nonEmpty).default([]),
});

export const EducationSchema = z.object({
  institution: nonEmpty,
  credential: nonEmpty,
  field: z.string().default(""),
  location: z.string().default(""),
  start: z.string().default(""),
  end: z.string().default(""),
});

export const ResumeVariantSchema = z.object({
  id: nonEmpty,
  label: nonEmpty,
  /** Path to the rendered PDF/DOCX actually uploaded to the ATS. */
  path: nonEmpty,
  /** Campaign track ids this variant is written for. */
  tracks: z.array(nonEmpty).default([]),
  isDefault: z.boolean().default(false),
});

/**
 * Pre-approved answers to recurring ATS questions. `allowAutoFill` is the
 * switch that lets an answer be used without a fresh human decision; it must be
 * false for anything legally material.
 */
export const ApprovedAnswerSchema = z.object({
  key: nonEmpty,
  label: nonEmpty,
  /** Case-insensitive substrings matched against the ATS question label. */
  patterns: z.array(nonEmpty).min(1),
  answer: nonEmpty,
  allowAutoFill: z.boolean().default(false),
  note: z.string().optional(),
});

export const WorkAuthorizationSchema = z.object({
  citizenships: z.array(nonEmpty).min(1),
  /** ISO country codes where the candidate can work with no employer action. */
  authorizedIn: z.array(nonEmpty).default([]),
  /** ISO country codes where an employer must support work authorization. */
  requiresSponsorshipIn: z.array(nonEmpty).default([]),
  /** Verbatim disclosure used when a form asks about authorization. */
  statement: nonEmpty,
  /** When true, authorization questions always stop for human review. */
  alwaysReviewManually: z.boolean().default(true),
});

export const CompensationPreferenceSchema = z.object({
  currency: z.string().length(3).default("USD"),
  targetTotal: z.number().positive(),
  minimumTotal: z.number().positive(),
  disclosurePolicy: z.enum(["decline", "range", "exact"]).default("decline"),
  rangeStatement: z.string().optional(),
});

export const IdentitySchema = z.object({
  fullName: nonEmpty,
  headline: z.string().default(""),
  email: z.email(),
  phone: z.string().default(""),
  location: z.object({
    city: z.string().default(""),
    region: z.string().default(""),
    country: z.string().default(""),
  }),
  links: z.record(z.string(), z.string()).prefault({}),
});

export const ProfileSchema = z.object({
  version: z.literal(1),
  identity: IdentitySchema,
  workAuthorization: WorkAuthorizationSchema,
  compensation: CompensationPreferenceSchema,
  preferences: z
    .object({
      willingToRelocate: z.boolean().default(false),
      relocationTargets: z.array(nonEmpty).default([]),
      workplaceTypes: z.array(z.enum(["onsite", "hybrid", "remote"])).default(["onsite", "hybrid", "remote"]),
      noticePeriod: z.string().default(""),
    })
    .prefault({}),
  resumes: z.array(ResumeVariantSchema).min(1),
  skills: z.array(SkillSchema).default([]),
  facts: z.array(FactSchema).default([]),
  experience: z.array(ExperienceSchema).default([]),
  education: z.array(EducationSchema).default([]),
  answers: z.array(ApprovedAnswerSchema).default([]),
});

export type Profile = z.infer<typeof ProfileSchema>;
export type ResumeVariant = z.infer<typeof ResumeVariantSchema>;
export type ApprovedAnswer = z.infer<typeof ApprovedAnswerSchema>;
export type Skill = z.infer<typeof SkillSchema>;
export type Fact = z.infer<typeof FactSchema>;
