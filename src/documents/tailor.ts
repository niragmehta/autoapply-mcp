import type { Job } from "../domain/job.js";
import type { Profile } from "../domain/profile.js";
import { assertFacts, buildFactCorpus } from "./factCheck.js";
import { applyVariant, placedBullets, type ResumeDocument } from "./model.js";
import {
  stripMetricMarkers,
  type BulletGroup,
  type ExperienceEntry,
  type ResumeBullet,
  type ResumeRole,
  type ResumeSource,
  type SkillCategory,
} from "./resumeSource.js";
import { aliasMap, extractJobTerms, round, scoreTerms, termSet, type AliasMap, type JobTerm, type TermMatch } from "./terms.js";

/**
 * Per-posting resume tailoring.
 *
 * Starting from the application's track variant, it moves the most relevant
 * bullet groups and bullets up within each role and the most relevant skills
 * forward, by weighted overlap with the posting's terms. When asked to, it
 * drops the least relevant bullets to fit the page, never below a minimum per
 * role and never a group's last bullet. It never adds, edits or rewords a
 * bullet, and every move is logged with the terms that caused it.
 */

const DEFAULT_MIN_BULLETS_PER_ROLE = 2;

type TailorOptions = {
  /** Fewest bullets a role keeps when bullets are dropped to fit the page. */
  minBulletsPerRole?: number;
  /** How many of the least relevant bullets to drop; page fitting raises this one at a time. */
  dropBullets?: number;
  /** A headline written by the agent. It is used only if it passes the fact check. */
  headline?: string;
};

type TailorChangeKind = "variant" | "headline" | "group-moved" | "bullet-moved" | "bullet-dropped" | "skills-moved" | "skill-term-moved";

export type TailorChange = { kind: TailorChangeKind; target: string; from?: number; to?: number; terms?: string[]; message: string };

type BulletScore = { id: string; score: number; terms: string[] };

export type TailoredResume = {
  variantId: string;
  variantFound: boolean;
  document: ResumeDocument;
  headline: { text: string; source: "override" | "variant" | "source" };
  changes: TailorChange[];
  /** Bullet ids in the order page fitting would drop them. */
  droppable: string[];
  dropped: string[];
  scores: BulletScore[];
  /** The posting's strongest terms, for explaining the result. */
  jobTerms: Array<{ term: string; weight: number }>;
};

type Scored<T> = { item: T; match: TermMatch };
type Tailored<T> = { value: T; changes: TailorChange[] };

const EXPLAIN_TERMS = 6;

/** Stable sort by score, highest first; ties keep their incoming order. */
function rank<T>(items: ReadonlyArray<Scored<T>>): Array<Scored<T>> {
  return items
    .map((entry, index) => ({ entry, index }))
    .sort((a, b) => b.entry.match.score - a.entry.match.score || a.index - b.index)
    .map(({ entry }) => entry);
}

/** One change per item that moved up, with the terms that earned it the place. */
function movedUp<T>(
  before: ReadonlyArray<Scored<T>>,
  after: ReadonlyArray<Scored<T>>,
  idOf: (item: T) => string,
  describe: (id: string, from: number, to: number, terms: string[]) => TailorChange,
): TailorChange[] {
  const original = new Map(before.map((entry, index) => [idOf(entry.item), index]));
  return after.flatMap((entry, to) => {
    const id = idOf(entry.item);
    const from = original.get(id) ?? to;
    return to < from ? [describe(id, from + 1, to + 1, entry.match.terms.slice(0, EXPLAIN_TERMS))] : [];
  });
}

function combined(parts: readonly TermMatch[], score: number): TermMatch {
  return { score: round(score), terms: [...new Set(parts.flatMap((part) => part.terms))] };
}

type Scorer = {
  bullet: (bullet: ResumeBullet) => TermMatch;
  text: (texts: readonly string[]) => TermMatch;
};

function makeScorer(jobTerms: ReadonlyMap<string, JobTerm>, aliases: AliasMap, profile: Profile): Scorer {
  const factTags = new Map(profile.facts.map((fact) => [fact.id, fact.tags]));
  const text = (texts: readonly string[]) => scoreTerms(termSet(texts, aliases), jobTerms);
  return {
    text,
    // Tags and the tags of linked facts count as the bullet's terms; they are never printed.
    bullet: (bullet) => text([stripMetricMarkers(bullet.text), ...bullet.tags, ...bullet.factIds.flatMap((id) => factTags.get(id) ?? [])]),
  };
}

function tailorGroup(group: BulletGroup, place: string, scorer: Scorer): Tailored<Scored<BulletGroup>> {
  const before = group.bullets.map((bullet) => ({ item: bullet, match: scorer.bullet(bullet) }));
  const after = rank(before);
  const changes = movedUp(before, after, (bullet) => bullet.id, (id, from, to, terms) => ({
    kind: "bullet-moved",
    target: id,
    from,
    to,
    terms,
    message: `moved bullet "${id}" from ${from} to ${to} in ${place} > ${group.id} because of terms [${terms.join(", ")}]`,
  }));
  const scores = after.map((entry) => entry.match.score);
  const best = Math.max(0, ...scores);
  const mean = scores.reduce((sum, score) => sum + score, 0) / Math.max(1, scores.length);
  const label = scorer.text(group.label ? [group.label] : []);
  // The best bullet decides most of a group's place; the mean keeps one
  // strong bullet from carrying a group of weak ones.
  const match = combined([label, ...after.map((entry) => entry.match)], best + mean + label.score);
  return { value: { item: { ...group, bullets: after.map((entry) => entry.item) }, match }, changes };
}

function tailorRole(entry: ExperienceEntry, role: ResumeRole, scorer: Scorer): Tailored<ResumeRole> {
  const place = `${entry.organization} / ${role.title}`;
  const groups = role.groups.map((group) => tailorGroup(group, place, scorer));
  const before = groups.map((group) => group.value);
  const after = rank(before);
  const moves = movedUp(before, after, (group) => group.id, (id, from, to, terms) => ({
    kind: "group-moved",
    target: id,
    from,
    to,
    terms,
    message: `moved group "${id}" from ${from} to ${to} in ${place} because of terms [${terms.join(", ")}]`,
  }));
  return { value: { ...role, groups: after.map((group) => group.item) }, changes: [...moves, ...groups.flatMap((group) => group.changes)] };
}

function tailorCategory(category: SkillCategory, scorer: Scorer): Tailored<Scored<SkillCategory>> {
  const before = category.terms.map((term) => ({ item: term, match: scorer.text([term]) }));
  const after = rank(before);
  const changes = movedUp(before, after, (term) => term, (term, from, to, terms) => ({
    kind: "skill-term-moved",
    target: term,
    from,
    to,
    terms,
    message: `moved skill "${term}" from ${from} to ${to} in "${category.id}" because of terms [${terms.join(", ")}]`,
  }));
  const label = scorer.text(category.label ? [category.label] : []);
  const total = after.reduce((sum, entry) => sum + entry.match.score, label.score);
  const match = combined([label, ...after.map((entry) => entry.match)], total);
  return { value: { item: { ...category, terms: after.map((entry) => entry.item) }, match }, changes };
}

/** Reorders categories and the terms inside them. Terms are never removed. */
function tailorSkills(categories: readonly SkillCategory[], scorer: Scorer): Tailored<SkillCategory[]> {
  const scored = categories.map((category) => tailorCategory(category, scorer));
  const before = scored.map((category) => category.value);
  const after = rank(before);
  const moves = movedUp(before, after, (category) => category.id, (id, from, to, terms) => ({
    kind: "skills-moved",
    target: id,
    from,
    to,
    terms,
    message: `moved skill category "${id}" from ${from} to ${to} because of terms [${terms.join(", ")}]`,
  }));
  return { value: after.map((entry) => entry.item), changes: [...moves, ...scored.flatMap((category) => category.changes)] };
}

function withoutBullets(experience: readonly ExperienceEntry[], ids: ReadonlySet<string>): ExperienceEntry[] {
  return experience.map((entry) => ({
    ...entry,
    roles: entry.roles.map((role) => ({
      ...role,
      groups: role.groups
        .map((group) => ({ ...group, bullets: group.bullets.filter((bullet) => !ids.has(bullet.id)) }))
        .filter((group) => group.bullets.length > 0),
    })),
  }));
}

/**
 * The order bullets would be dropped in: always the least relevant bullet
 * that may go, the later one among equals, re-checking the per-role minimum
 * and the group's last bullet after every drop.
 */
export function dropOrder(experience: readonly ExperienceEntry[], scoreOf: (id: string) => number, minPerRole: number): string[] {
  const eligible = placedBullets({ experience }).filter((spot) => {
    const role = experience[spot.entry]?.roles[spot.role];
    const roleCount = role?.groups.reduce((sum, group) => sum + group.bullets.length, 0) ?? 0;
    const groupCount = role?.groups.find((group) => group.id === spot.groupId)?.bullets.length ?? 0;
    return roleCount > minPerRole && groupCount > 1;
  });
  if (eligible.length === 0) return [];
  const pick = eligible.reduce((worst, spot) => (scoreOf(spot.bullet.id) <= scoreOf(worst.bullet.id) ? spot : worst));
  return [pick.bullet.id, ...dropOrder(withoutBullets(experience, new Set([pick.bullet.id])), scoreOf, minPerRole)];
}

function chooseHeadline(base: ResumeDocument, fromVariant: boolean, source: ResumeSource, profile: Profile, override: string | undefined) {
  const supplied = override?.trim();
  if (supplied) {
    // No posting context: a headline may not borrow the target job's title.
    assertFacts(supplied, buildFactCorpus({ source, profile }), "the headline");
    return { text: supplied, source: "override" as const };
  }
  return { text: base.header.headline, source: fromVariant ? ("variant" as const) : ("source" as const) };
}

export function tailorResume(
  source: ResumeSource,
  variantId: string,
  job: Pick<Job, "title" | "descriptionText">,
  profile: Profile,
  options: TailorOptions = {},
): TailoredResume {
  const minPerRole = Math.max(0, Math.floor(options.minBulletsPerRole ?? DEFAULT_MIN_BULLETS_PER_ROLE));
  const dropCount = Math.max(0, Math.floor(options.dropBullets ?? 0));
  const { document: base, variantFound } = applyVariant(source, variantId);
  const aliases = aliasMap(profile);
  const jobTerms = extractJobTerms(job, aliases);
  const scorer = makeScorer(jobTerms, aliases, profile);

  const fromVariant = variantFound && Boolean(source.variants[variantId]?.headline);
  const headline = chooseHeadline(base, fromVariant, source, profile, options.headline);
  const roles = base.experience.map((entry) => entry.roles.map((role) => tailorRole(entry, role, scorer)));
  const reordered = base.experience.map((entry, index) => ({ ...entry, roles: (roles[index] ?? []).map((role) => role.value) }));
  const skills = tailorSkills(base.skills, scorer);

  const bulletScores = new Map(placedBullets({ experience: reordered }).map(({ bullet }) => [bullet.id, scorer.bullet(bullet)]));
  const scoreOf = (id: string) => bulletScores.get(id)?.score ?? 0;
  const droppable = dropOrder(reordered, scoreOf, minPerRole);
  const dropped = droppable.slice(0, dropCount);

  const changes: TailorChange[] = [
    ...(variantFound ? [] : [{ kind: "variant" as const, target: variantId, message: `resume.json has no variant "${variantId}"; started from the source order` }]),
    ...(headline.source === "override" && headline.text !== base.header.headline
      ? [{ kind: "headline" as const, target: "headline", message: `headline "${base.header.headline}" replaced by "${headline.text}", which passed the fact check` }]
      : []),
    ...roles.flat().flatMap((role) => role.changes),
    ...skills.changes,
    ...dropped.map((id) => ({ kind: "bullet-dropped" as const, target: id, message: `dropped bullet "${id}" (relevance ${scoreOf(id)}) to fit the page` })),
  ];

  return {
    variantId,
    variantFound,
    document: {
      ...base,
      header: { ...base.header, headline: headline.text },
      experience: dropped.length > 0 ? withoutBullets(reordered, new Set(dropped)) : reordered,
      skills: skills.value,
    },
    headline,
    changes,
    droppable,
    dropped,
    scores: [...bulletScores.entries()].map(([id, match]) => ({ id, score: match.score, terms: match.terms })),
    jobTerms: [...jobTerms.values()].slice(0, 15).map((term) => ({ term: term.display, weight: term.weight })),
  };
}
