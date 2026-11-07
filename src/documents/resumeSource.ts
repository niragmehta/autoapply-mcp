import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import type { WorkspacePaths } from "../config/paths.js";
import { AppError } from "../util/errors.js";

/**
 * resume.json: the structured source every resume PDF is rendered from.
 *
 * It holds the candidate's own wording, bullet by bullet. Tailoring reorders
 * and selects from it; nothing that renders a document may add to it. Figures
 * are wrapped in [[...]] so the template can set them in bold, which is the
 * only bold a bullet ever carries.
 */

const nonEmpty = z.string().trim().min(1);
const identifier = nonEmpty.regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "use letters, digits, dots, dashes or underscores");
// Theme values are written into CSS, so they are limited to shapes that cannot
// close a declaration and smuggle in another rule.
const hexColor = z
  .string()
  .regex(/^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/, "use a hex colour such as #FF6A3D");
const cssLength = z.string().regex(/^\d+(?:\.\d+)?(?:in|mm|cm|pt|px)$/, "use a length such as 0.5in, 12mm or 36pt");

const METRIC_MARKER = /\[\[([^[\]]+?)\]\]/g;

/** Whether every [[ opens a non-empty marker that closes. */
function markersBalanced(text: string): boolean {
  const rest = text.replace(METRIC_MARKER, "");
  return !rest.includes("[[") && !rest.includes("]]");
}

/** The bullet as it reads, without metric markers. */
export function stripMetricMarkers(text: string): string {
  return text.replace(METRIC_MARKER, "$1");
}

const ContactItemSchema = z.object({
  text: nonEmpty,
  href: z
    .string()
    .trim()
    .regex(/^(?:https?:\/\/|mailto:|tel:)\S+$/i, "links must start with http://, https://, mailto: or tel:")
    .optional(),
});

const ResumeHeaderSchema = z.object({
  name: nonEmpty,
  headline: z.string().trim().default(""),
  contact: z.array(ContactItemSchema).default([]),
});

export const ResumeThemeSchema = z
  .object({
    accent: hexColor.default("#FF6A3D"),
    linkColor: hexColor.default("#3A95D7"),
    pageSize: z.enum(["A4", "Letter"]).default("A4"),
    /** Justified text stretches lines, because hyphenation is always off. */
    align: z.enum(["left", "justify"]).default("left"),
    margins: z.object({ top: cssLength, right: cssLength, bottom: cssLength, left: cssLength }).optional(),
  })
  .prefault({});

const ResumeBulletSchema = z.object({
  id: identifier,
  text: nonEmpty.refine(markersBalanced, "every [[ must close with ]] around a non-empty figure"),
  /** profile.facts ids this bullet is evidence for. */
  factIds: z.array(nonEmpty).default([]),
  /** Extra matching terms; never printed. */
  tags: z.array(nonEmpty).default([]),
});

const BulletGroupSchema = z.object({
  id: identifier,
  /** Printed in italics above the bullets; omit for a plain list under the title. */
  label: z.string().trim().min(1).optional(),
  bullets: z.array(ResumeBulletSchema).min(1),
});

const ResumeRoleSchema = z.object({
  title: nonEmpty,
  dates: nonEmpty,
  groups: z.array(BulletGroupSchema).default([]),
});

const ExperienceEntrySchema = z.object({
  organization: nonEmpty,
  location: z.string().trim().default(""),
  roles: z.array(ResumeRoleSchema).min(1),
});

/** A one-line entry, such as an earlier internship. */
const AdditionalEntrySchema = z.object({
  organization: nonEmpty,
  location: z.string().trim().optional(),
  title: nonEmpty,
  dates: nonEmpty,
});

const ResumeEducationSchema = z.object({
  institution: nonEmpty,
  location: z.string().trim().default(""),
  credential: nonEmpty,
  dates: z.string().trim().default(""),
});

const SkillCategorySchema = z.object({
  id: identifier,
  label: z.string().trim().min(1).optional(),
  terms: z.array(nonEmpty).min(1),
});

/**
 * A fixed track variant, keyed by the profile.resumes id it renders. It picks
 * and orders existing content; the only wording of its own is a headline,
 * which is part of the source and so counts as verified.
 */
const ResumeVariantSchema = z.object({
  headline: z.string().trim().min(1).optional(),
  /** Group ids in print order; unlisted groups follow in source order. */
  groupOrder: z.array(nonEmpty).optional(),
  /** Skill category ids in print order; unlisted categories follow in source order. */
  skillOrder: z.array(nonEmpty).optional(),
  /** When set, only these bullets print. */
  includeBullets: z.array(nonEmpty).optional(),
  excludeBullets: z.array(nonEmpty).optional(),
});

const SectionTitlesSchema = z
  .object({
    experience: nonEmpty.default("Experience"),
    additional: nonEmpty.default("Previous Roles"),
    education: nonEmpty.default("Education"),
    skills: nonEmpty.default("Technical Skills"),
  })
  .prefault({});

type ReferenceField = "groupOrder" | "skillOrder" | "includeBullets" | "excludeBullets";

const ResumeSourceSchema = z
  .object({
    version: z.literal(1),
    header: ResumeHeaderSchema,
    theme: ResumeThemeSchema,
    sectionTitles: SectionTitlesSchema,
    /** Pages a rendered resume may take: one unless the candidate opts into two. */
    maxPages: z.union([z.literal(1), z.literal(2)]).default(1),
    experience: z.array(ExperienceEntrySchema).min(1),
    additional: z.array(AdditionalEntrySchema).default([]),
    education: z.array(ResumeEducationSchema).default([]),
    skills: z.object({ categories: z.array(SkillCategorySchema).default([]) }).prefault({}),
    variants: z.record(z.string(), ResumeVariantSchema).default({}),
  })
  .superRefine((source, ctx) => {
    const bulletIds = new Set<string>();
    const groupIds = new Set<string>();
    source.experience.forEach((entry, e) =>
      entry.roles.forEach((role, r) => {
        const inRole = new Set<string>();
        role.groups.forEach((group, g) => {
          const groupPath = ["experience", e, "roles", r, "groups", g];
          if (inRole.has(group.id)) {
            ctx.addIssue({ code: "custom", message: `duplicate group id "${group.id}" in this role`, path: [...groupPath, "id"] });
          }
          inRole.add(group.id);
          groupIds.add(group.id);
          group.bullets.forEach((bullet, b) => {
            if (bulletIds.has(bullet.id)) {
              ctx.addIssue({
                code: "custom",
                message: `duplicate bullet id "${bullet.id}"; bullet ids must be unique across the resume`,
                path: [...groupPath, "bullets", b, "id"],
              });
            }
            bulletIds.add(bullet.id);
          });
        });
      }),
    );
    const categoryIds = new Set<string>();
    source.skills.categories.forEach((category, c) => {
      if (categoryIds.has(category.id)) {
        ctx.addIssue({ code: "custom", message: `duplicate skill category id "${category.id}"`, path: ["skills", "categories", c, "id"] });
      }
      categoryIds.add(category.id);
    });
    const references: Array<[ReferenceField, Set<string>, string]> = [
      ["groupOrder", groupIds, "group"],
      ["skillOrder", categoryIds, "skill category"],
      ["includeBullets", bulletIds, "bullet"],
      ["excludeBullets", bulletIds, "bullet"],
    ];
    for (const [variantId, variant] of Object.entries(source.variants)) {
      for (const [field, known, noun] of references) {
        (variant[field] ?? []).forEach((value, index) => {
          if (!known.has(value)) {
            ctx.addIssue({ code: "custom", message: `unknown ${noun} id "${value}"`, path: ["variants", variantId, field, index] });
          }
        });
      }
    }
  });

export type ResumeSource = z.infer<typeof ResumeSourceSchema>;
export type ResumeTheme = ResumeSource["theme"];
export type ResumeHeader = ResumeSource["header"];
export type SectionTitles = ResumeSource["sectionTitles"];
export type ContactItem = z.infer<typeof ContactItemSchema>;
export type ResumeBullet = z.infer<typeof ResumeBulletSchema>;
export type BulletGroup = z.infer<typeof BulletGroupSchema>;
export type ResumeRole = z.infer<typeof ResumeRoleSchema>;
export type ExperienceEntry = z.infer<typeof ExperienceEntrySchema>;
export type AdditionalEntry = z.infer<typeof AdditionalEntrySchema>;
export type ResumeEducation = z.infer<typeof ResumeEducationSchema>;
export type SkillCategory = z.infer<typeof SkillCategorySchema>;

/** Parses resume.json content, failing with every problem located by path. */
export function parseResumeSource(value: unknown, path = "resume.json"): ResumeSource {
  const result = ResumeSourceSchema.safeParse(value);
  if (result.success) return result.data;
  const issues = result.error.issues
    .slice(0, 12)
    .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("\n");
  throw new AppError("resume_source_invalid", `resume source at ${path} failed validation:\n${issues}`, { path });
}

/**
 * Loads resume.json from the workspace. The file is optional for the server as
 * a whole, but anything that renders a resume needs it, so a missing file is a
 * clear error naming where it was expected.
 */
export function loadResumeSource(paths: Pick<WorkspacePaths, "resumeSource">): ResumeSource {
  const path = paths.resumeSource;
  if (!existsSync(path)) {
    throw new AppError(
      "resume_source_missing",
      `no resume source at ${path}. Copy examples/resume.example.json there and replace its content with your own (see docs/DOCUMENTS.md).`,
      { path },
    );
  }
  let parsed: unknown;
  try {
    // A byte order mark from a Windows editor would otherwise fail JSON.parse.
    parsed = JSON.parse(readFileSync(path, "utf8").replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new AppError("resume_source_invalid", `resume source at ${path} is not valid JSON: ${String(error)}`, { path });
  }
  return parseResumeSource(parsed, path);
}

/** The resume source when one exists; still throws when it exists but is invalid. */
export function loadResumeSourceIfPresent(paths: Pick<WorkspacePaths, "resumeSource">): ResumeSource | null {
  return existsSync(paths.resumeSource) ? loadResumeSource(paths) : null;
}
