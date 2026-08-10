import { z } from "zod";

/**
 * Candidate profile: the single source of verified truth about a person.
 * Everything the server drafts must trace back to this file. Nothing here is
 * invented by a model at runtime.
 */

const nonEmpty = z.string().trim().min(1);

/**
 * A question pattern is matched as a case-insensitive substring against an ATS
 * question label, so it can never usefully be longer than a label itself.
 *
 * The bound exists to make corruption loud. Editing this file with a tool that
 * rewrites it in the wrong encoding re-encodes any typographic character, and
 * each pass multiplies its length: one pattern containing curly quotes survived
 * 22 such passes and reached 119 MB. Nothing rejected it, because the value was
 * still a valid non-empty string. The first thing the field matcher does is
 * lowercase every pattern, so the damage only surfaced as an out-of-memory
 * crash of the whole server, part-way through a submission run and far from its
 * cause. Failing at load names the offending field instead.
 */
const MAX_PATTERN_LENGTH = 500;
const questionPattern = nonEmpty.max(
  MAX_PATTERN_LENGTH,
  `a question pattern longer than ${MAX_PATTERN_LENGTH} characters cannot match an ATS question label; this is almost certainly text corrupted by a re-encoding edit`,
);

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
  patterns: z.array(questionPattern).min(1),
  /** May be empty to record a known question that must still be decided. */
  answer: z.string().default(""),
  /**
   * Ordered fallbacks for questions rendered as a fixed set of choices.
   * The first entry that matches an option the employer actually offers is
   * used, so one preference list works across differing dropdowns.
   */
  alternatives: z.array(z.string()).default([]),
  allowAutoFill: z.boolean().default(false),
  /**
   * Deliberately leave this question blank. Optional free-text fields are often
   * better empty than filled with something generic, and recording that as a
   * decision stops the question blocking every application.
   */
  skip: z.boolean().default(false),
  note: z.string().optional(),
});

/**
 * Templated answers for open-ended questions such as "why this company".
 *
 * A template is the candidate's own words with slots for details taken from the
 * posting, so a generated answer stays truthful and specific rather than
 * becoming boilerplate. Supported placeholders: {company}, {role}, {topics},
 * {location}. Patterns may also contain {company}, which expands to the
 * employer's name before matching.
 */
export const NarrativeTemplateSchema = z.object({
  key: nonEmpty,
  label: nonEmpty,
  patterns: z.array(questionPattern).min(1),
  template: nonEmpty,
  allowAutoFill: z.boolean().default(false),
  /** Skip the template when the posting yields fewer matched topics than this. */
  minTopics: z.number().int().min(0).default(0),
  note: z.string().optional(),
});
export type NarrativeTemplate = z.infer<typeof NarrativeTemplateSchema>;

export const WorkAuthorizationSchema = z.object({
  citizenships: z.array(nonEmpty).min(1),
  /** ISO country codes where the candidate can work with no employer action. */
  authorizedIn: z.array(nonEmpty).default([]),
  /**
   * ISO country codes where the candidate can obtain work authorization without
   * employer sponsorship, for example a Canadian citizen using TN status under
   * USMCA. Distinct from `authorizedIn`, which means already authorized today.
   */
  noSponsorshipRequiredIn: z.array(nonEmpty).default([]),
  /** ISO country codes where an employer must petition for work authorization. */
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

/**
 * A stored answer to a personal or demographic question.
 *
 * `autoFill` is the record of a decision the candidate has already made about
 * this specific field. When true, the value may be used without stopping for a
 * fresh decision on every application; when false it is only ever a suggestion.
 */
export const StoredAnswerSchema = z.object({
  value: z.string().default(""),
  autoFill: z.boolean().default(false),
});
export type StoredAnswer = z.infer<typeof StoredAnswerSchema>;

const storedAnswer = () => StoredAnswerSchema.prefault({});

/**
 * Voluntary self-identification data.
 *
 * These questions are legally sensitive and, in the US, voluntary. Nothing here
 * is filled unless the candidate sets `autoFill` on that specific field.
 * "Decline to self-identify" is a valid and common value.
 */
export const DemographicsSchema = z.object({
  gender: storedAnswer(),
  pronouns: storedAnswer(),
  raceEthnicity: storedAnswer(),
  hispanicLatino: storedAnswer(),
  veteranStatus: storedAnswer(),
  disabilityStatus: storedAnswer(),
  sexualOrientation: storedAnswer(),
  transgenderIdentity: storedAnswer(),
});

export const PostalAddressSchema = z.object({
  street: z.string().default(""),
  city: z.string().default(""),
  region: z.string().default(""),
  postalCode: z.string().default(""),
  country: z.string().default(""),
});

/**
 * Personal details that application forms routinely require. Kept separate from
 * `identity` because this is higher-sensitivity data: it is redacted from logs
 * and must never be committed to a repository.
 */
export const PersonalSchema = z.object({
  dateOfBirth: storedAnswer(),
  address: PostalAddressSchema.prefault({}),
  addressAutoFill: z.boolean().default(false),
  demographics: DemographicsSchema.prefault({}),
  /** Answer to "are you at least 18 years of age". */
  legalAgeConfirmation: storedAnswer(),
  /** Answer to "have you previously worked for this company". */
  previousEmployment: storedAnswer(),
});
export type Personal = z.infer<typeof PersonalSchema>;

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
  personal: PersonalSchema.prefault({}),
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
  narratives: z.array(NarrativeTemplateSchema).default([]),
});

export type Profile = z.infer<typeof ProfileSchema>;
export type ResumeVariant = z.infer<typeof ResumeVariantSchema>;
export type ApprovedAnswer = z.infer<typeof ApprovedAnswerSchema>;
export type Skill = z.infer<typeof SkillSchema>;
export type Fact = z.infer<typeof FactSchema>;
