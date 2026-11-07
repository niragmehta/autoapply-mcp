import type {
  AdditionalEntry,
  ExperienceEntry,
  ResumeBullet,
  ResumeEducation,
  ResumeHeader,
  ResumeSource,
  ResumeTheme,
  SectionTitles,
  SkillCategory,
} from "./resumeSource.js";

/**
 * The render model: a resume source with one variant applied, so a template
 * has nothing left to decide. Tailoring produces the same shape.
 */
export type ResumeDocument = {
  header: ResumeHeader;
  theme: ResumeTheme;
  sectionTitles: SectionTitles;
  maxPages: 1 | 2;
  experience: ExperienceEntry[];
  additional: AdditionalEntry[];
  education: ResumeEducation[];
  skills: SkillCategory[];
};

type VariantResult = { document: ResumeDocument; variantFound: boolean };

/** Orders items by a preferred id list; unlisted items follow in their original order. */
export function orderByIds<T>(items: readonly T[], order: readonly string[] | undefined, idOf: (item: T) => string): T[] {
  if (!order || order.length === 0) return [...items];
  const rank = new Map(order.map((id, index) => [id, index]));
  return items
    .map((item, index) => ({ item, rank: rank.get(idOf(item)) ?? order.length + index }))
    .sort((a, b) => a.rank - b.rank)
    .map((entry) => entry.item);
}

/**
 * Applies a fixed track variant: its headline, group and skill order, and
 * bullet selection. A variant id the source does not define renders the
 * source as written, which the caller reports.
 */
export function applyVariant(source: ResumeSource, variantId: string | null): VariantResult {
  // hasOwn, because a record parsed from JSON still inherits "constructor" and friends.
  const variant = variantId && Object.hasOwn(source.variants, variantId) ? source.variants[variantId] : undefined;
  const include = variant?.includeBullets ? new Set(variant.includeBullets) : null;
  const exclude = new Set(variant?.excludeBullets ?? []);
  const keep = (bullet: ResumeBullet) => (include ? include.has(bullet.id) : true) && !exclude.has(bullet.id);

  const experience = source.experience.map((entry) => ({
    ...entry,
    roles: entry.roles.map((role) => ({
      ...role,
      groups: orderByIds(role.groups, variant?.groupOrder, (group) => group.id)
        .map((group) => ({ ...group, bullets: group.bullets.filter(keep) }))
        .filter((group) => group.bullets.length > 0),
    })),
  }));

  return {
    variantFound: variant !== undefined,
    document: {
      header: { ...source.header, headline: variant?.headline ?? source.header.headline },
      theme: source.theme,
      sectionTitles: source.sectionTitles,
      maxPages: source.maxPages,
      experience,
      additional: source.additional,
      education: source.education,
      skills: orderByIds(source.skills.categories, variant?.skillOrder, (category) => category.id),
    },
  };
}

type PlacedBullet = { entry: number; role: number; groupId: string; bullet: ResumeBullet };

/** Every bullet in print order, with where it sits. */
export function placedBullets(document: { readonly experience: readonly ExperienceEntry[] }): PlacedBullet[] {
  return document.experience.flatMap((entry, e) =>
    entry.roles.flatMap((role, r) =>
      role.groups.flatMap((group) => group.bullets.map((bullet) => ({ entry: e, role: r, groupId: group.id, bullet }))),
    ),
  );
}
