import type { Job } from "../domain/job.js";
import type { Profile } from "../domain/profile.js";
import { normalizeTerm } from "../text/words.js";
import { assertFacts, buildFactCorpus } from "./factCheck.js";
import { applyVariant, placedBullets, type ReserveBullet, type ResumeDocument } from "./model.js";
import {
  stripMetricMarkers,
  type BulletGroup,
  type ExperienceEntry,
  type ResumeBullet,
  type ResumeRole,
  type ResumeSource,
  type SkillCategory,
} from "./resumeSource.js";
import { aliasMap, extractJobTerms, namingTerms, round, scoreTerms, termSet, type AliasMap, type JobTerm, type TermMatch } from "./terms.js";

/**
 * Per-posting resume tailoring.
 *
 * Starting from the application's track variant, it moves the most relevant
 * bullet groups and bullets up within each role and the most relevant skills
 * forward, by weighted overlap with the posting's terms. It prints the
 * candidate's upgrades (reserve bullets that restate a printed bullet more
 * strongly) wherever they suit the posting at least as well, and when allowed
 * swaps in a few other reserve bullets, each only where it clearly suits the
 * posting better than the printed bullet it displaces. Bullets marked keep are
 * never displaced. It adds the reserve skills the posting names. When asked
 * to, it drops the least relevant bullets to fit the page, never a kept one,
 * never below a minimum per role and never a group's last bullet. It never
 * edits or rewords a bullet, and every change is logged with the terms that
 * caused it.
 */

const DEFAULT_MIN_BULLETS_PER_ROLE = 2;

/** A reserve must be worth at least this much to the posting before it displaces anything: about two requirement terms. */
const MIN_RESERVE_SCORE = 4;
/** ...and beat the bullet it displaces by at least this much: about one more requirement term. */
const SWAP_MARGIN = 2;

type TailorOptions = {
  /** Fewest bullets a role keeps when bullets are dropped to fit the page. */
  minBulletsPerRole?: number;
  /** How many of the least relevant bullets to drop; page fitting raises this one at a time. */
  dropBullets?: number;
  /** A headline written by the agent. It is used only if it passes the fact check. */
  headline?: string;
  /** Most reserve bullets to swap in for different printed work. Upgrades don't count. Defaults to 0. */
  maxSwaps?: number;
  /** Most reserve skill terms to add because the posting names them. Defaults to 0. */
  maxAddedSkills?: number;
};

type TailorChangeKind =
  | "variant"
  | "headline"
  | "bullet-swapped"
  | "group-moved"
  | "bullet-moved"
  | "bullet-dropped"
  | "skill-term-added"
  | "skills-moved"
  | "skill-term-moved";

export type TailorChange = { kind: TailorChangeKind; target: string; from?: number; to?: number; terms?: string[]; message: string };

type BulletScore = { id: string; score: number; terms: string[] };

type SwapSummary = { in: string; out: string; upgrade: boolean; inScore: number; outScore: number };

export type TailoredResume = {
  variantId: string;
  variantFound: boolean;
  document: ResumeDocument;
  headline: { text: string; source: "override" | "variant" | "source" };
  changes: TailorChange[];
  /** Reserve bullets printed instead of a printed bullet: upgrades, then swaps. */
  swaps: SwapSummary[];
  /** Reserve skill terms added because the posting names them. */
  addedSkills: string[];
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
  /** Only the posting terms that name this skill outright. */
  names: (skill: string) => TermMatch;
};

function makeScorer(jobTerms: ReadonlyMap<string, JobTerm>, aliases: AliasMap, profile: Profile): Scorer {
  const factTags = new Map(profile.facts.map((fact) => [fact.id, fact.tags]));
  const text = (texts: readonly string[]) => scoreTerms(termSet(texts, aliases), jobTerms);
  return {
    text,
    // Tags and the tags of linked facts count as the bullet's terms; they are never printed.
    bullet: (bullet) => text([stripMetricMarkers(bullet.text), ...bullet.tags, ...bullet.factIds.flatMap((id) => factTags.get(id) ?? [])]),
    names: (skill) => scoreTerms(new Set(namingTerms(skill, aliases)), jobTerms),
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

/**
 * Adds the reserve skill terms the posting names (by a phrase of the skill,
 * not a word it shares), the most relevant first, up to the limit.
 */
function addReserveSkills(categories: readonly SkillCategory[], scorer: Scorer, limit: number): Tailored<SkillCategory[]> {
  if (limit <= 0) return { value: [...categories], changes: [] };
  const printed = new Set(categories.flatMap((category) => category.terms.map(normalizeTerm)));
  const picks = categories
    .flatMap((category) => category.reserve.map((term) => ({ category: category.id, term, match: scorer.names(term) })))
    .map((pick, order) => ({ ...pick, order }))
    .filter((pick) => pick.match.score > 0 && !printed.has(normalizeTerm(pick.term)))
    .sort((a, b) => b.match.score - a.match.score || a.order - b.order)
    .slice(0, limit);
  const added = new Map<string, string[]>();
  for (const pick of picks) added.set(pick.category, [...(added.get(pick.category) ?? []), pick.term]);
  return {
    value: categories.map((category) => ({ ...category, terms: [...category.terms, ...(added.get(category.id) ?? [])] })),
    changes: picks.map((pick) => ({
      kind: "skill-term-added",
      target: pick.term,
      terms: pick.match.terms.slice(0, EXPLAIN_TERMS),
      message: `added reserve skill "${pick.term}" to "${pick.category}" because the posting names [${pick.match.terms.join(", ")}]`,
    })),
  };
}

type PrintedBullet = ReturnType<typeof placedBullets>[number];

type Swap = { reserve: ReserveBullet; out: PrintedBullet; inScore: number; outScore: number; upgrade: boolean; terms: string[] };

const groupKey = (spot: { entry: number; role: number; groupId: string }) => `${spot.entry}/${spot.role}/${spot.groupId}`;

/**
 * The upgrade each printed bullet gets: the most relevant reserve that
 * restates it, when that suits the posting at least as well. Upgrades cost
 * nothing against the swap limit, because the same work stays on the page.
 */
function chooseUpgrades(printed: readonly PrintedBullet[], reserves: readonly ReserveBullet[], scorer: Scorer): Map<string, Swap> {
  const byId = new Map(printed.map((spot) => [spot.bullet.id, spot]));
  const chosen = new Map<string, Swap>();
  for (const reserve of reserves) {
    const out = reserve.bullet.upgrade ? byId.get(reserve.bullet.replaces[0] ?? "") : undefined;
    if (!out) continue;
    const match = scorer.bullet(reserve.bullet);
    const outScore = scorer.bullet(out.bullet).score;
    const current = chosen.get(out.bullet.id);
    if (match.score >= outScore && (!current || match.score > current.inScore)) {
      chosen.set(out.bullet.id, { reserve, out, inScore: match.score, outScore, upgrade: true, terms: match.terms.slice(0, EXPLAIN_TERMS) });
    }
  }
  return chosen;
}

/**
 * Picks the reserve bullets to swap in for different work. A reserve may
 * displace a printed bullet in its own role that is not kept (only the ones it
 * names in `replaces`, when it names any) if it is clearly more relevant to
 * the posting. The biggest gains go first, no bullet is swapped twice and no
 * group is left empty.
 */
function chooseTopicSwaps(
  printed: readonly PrintedBullet[],
  reserves: readonly ReserveBullet[],
  scorer: Scorer,
  limit: number,
  scoreOf: (spot: PrintedBullet) => number,
): Swap[] {
  if (limit <= 0) return [];
  const candidates = reserves.flatMap((reserve, reserveOrder) => {
    const match = scorer.bullet(reserve.bullet);
    if (match.score < MIN_RESERVE_SCORE) return [];
    const named = reserve.bullet.replaces;
    return printed
      .filter((spot) => spot.entry === reserve.entry && spot.role === reserve.role && !spot.bullet.keep && (named.length === 0 || named.includes(spot.bullet.id)))
      .flatMap((out, outOrder) => {
        const outScore = scoreOf(out);
        return match.score - outScore >= SWAP_MARGIN
          ? [{ reserve, out, inScore: match.score, outScore, upgrade: false, terms: match.terms.slice(0, EXPLAIN_TERMS), reserveOrder, outOrder }]
          : [];
      });
  });
  candidates.sort((a, b) => b.inScore - b.outScore - (a.inScore - a.outScore) || a.reserveOrder - b.reserveOrder || b.outOrder - a.outOrder);

  const sizes = new Map<string, number>();
  for (const spot of printed) sizes.set(groupKey(spot), (sizes.get(groupKey(spot)) ?? 0) + 1);
  const usedIn = new Set<string>();
  const usedOut = new Set<string>();
  const chosen: Swap[] = [];
  for (const candidate of candidates) {
    if (chosen.length >= limit) break;
    if (usedIn.has(candidate.reserve.bullet.id) || usedOut.has(candidate.out.bullet.id)) continue;
    const from = groupKey(candidate.out);
    const into = groupKey(candidate.reserve);
    if (from !== into && (sizes.get(from) ?? 0) <= 1) continue;
    usedIn.add(candidate.reserve.bullet.id);
    usedOut.add(candidate.out.bullet.id);
    sizes.set(from, (sizes.get(from) ?? 0) - 1);
    sizes.set(into, (sizes.get(into) ?? 0) + 1);
    const { reserve, out, inScore, outScore, upgrade, terms } = candidate;
    chosen.push({ reserve, out, inScore, outScore, upgrade, terms });
  }
  return chosen;
}

/**
 * Upgrades, then swaps. A swap is judged against the strongest statement of
 * the work it would displace, so a bullet with an upgrade is weighed as its
 * upgrade; when a swap does displace it, its upgrade is moot and dropped.
 */
function chooseSwaps(experience: readonly ExperienceEntry[], reserves: readonly ReserveBullet[], scorer: Scorer, limit: number): Swap[] {
  if (reserves.length === 0) return [];
  const printed = placedBullets({ experience });
  const upgrades = chooseUpgrades(printed, reserves, scorer);
  const strongest = (spot: PrintedBullet) => upgrades.get(spot.bullet.id)?.inScore ?? scorer.bullet(spot.bullet).score;
  const swaps = chooseTopicSwaps(
    printed,
    reserves.filter((reserve) => !reserve.bullet.upgrade),
    scorer,
    limit,
    strongest,
  );
  const displaced = new Set(swaps.map((swap) => swap.out.bullet.id));
  return [...[...upgrades.values()].filter((upgrade) => !displaced.has(upgrade.out.bullet.id)), ...swaps];
}

/**
 * Puts each chosen reserve into its own group, where the bullet it displaced
 * stood when they share a group, so an upgrade prints exactly where the
 * original did and stays kept if the original was. A reserve whose group
 * prints nothing yet brings it back.
 */
function applySwaps(experience: readonly ExperienceEntry[], swaps: readonly Swap[]): ExperienceEntry[] {
  if (swaps.length === 0) return [...experience];
  return experience.map((entry, e) => ({
    ...entry,
    roles: entry.roles.map((role, r) => {
      const here = swaps.filter((swap) => swap.reserve.entry === e && swap.reserve.role === r);
      if (here.length === 0) return role;
      const replacing = new Map(here.filter((swap) => swap.out.groupId === swap.reserve.groupId).map((swap) => [swap.out.bullet.id, swap.reserve.bullet]));
      const removed = new Set(here.map((swap) => swap.out.bullet.id));
      const groups = role.groups.map((group) => {
        const kept = group.bullets.flatMap((bullet) => {
          const replacement = replacing.get(bullet.id);
          if (replacement) return [{ ...replacement, keep: replacement.keep || bullet.keep }];
          return removed.has(bullet.id) ? [] : [bullet];
        });
        const joining = here
          .filter((swap) => swap.reserve.groupId === group.id && swap.out.groupId !== group.id)
          .map((swap) => swap.reserve.bullet);
        return { ...group, bullets: [...kept, ...joining] };
      });
      const missing = here.filter((swap) => !role.groups.some((group) => group.id === swap.reserve.groupId));
      const added = missing.reduce<BulletGroup[]>((built, swap) => {
        const index = built.findIndex((group) => group.id === swap.reserve.groupId);
        if (index >= 0) return built.map((group, i) => (i === index ? { ...group, bullets: [...group.bullets, swap.reserve.bullet] } : group));
        return [...built, { id: swap.reserve.groupId, ...(swap.reserve.groupLabel ? { label: swap.reserve.groupLabel } : {}), bullets: [swap.reserve.bullet] }];
      }, []);
      return { ...role, groups: [...groups, ...added].filter((group) => group.bullets.length > 0) };
    }),
  }));
}

function swapChange(swap: Swap): TailorChange {
  const scores = `relevance ${swap.inScore} vs ${swap.outScore}`;
  return {
    kind: "bullet-swapped",
    target: swap.reserve.bullet.id,
    terms: swap.terms,
    message: swap.upgrade
      ? `replaced "${swap.out.bullet.id}" with reserve "${swap.reserve.bullet.id}", a stronger statement of the same work (${scores})`
      : `swapped reserve "${swap.reserve.bullet.id}" in for "${swap.out.bullet.id}" (${scores}) because of terms [${swap.terms.join(", ")}]`,
  };
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
 * and the group's last bullet after every drop. A kept bullet never goes.
 */
export function dropOrder(experience: readonly ExperienceEntry[], scoreOf: (id: string) => number, minPerRole: number): string[] {
  const eligible = placedBullets({ experience }).filter((spot) => {
    const role = experience[spot.entry]?.roles[spot.role];
    const roleCount = role?.groups.reduce((sum, group) => sum + group.bullets.length, 0) ?? 0;
    const groupCount = role?.groups.find((group) => group.id === spot.groupId)?.bullets.length ?? 0;
    return !spot.bullet.keep && roleCount > minPerRole && groupCount > 1;
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
  const { document: base, variantFound, reserves } = applyVariant(source, variantId);
  const aliases = aliasMap(profile);
  const jobTerms = extractJobTerms(job, aliases);
  const scorer = makeScorer(jobTerms, aliases, profile);

  const fromVariant = variantFound && Boolean(source.variants[variantId]?.headline);
  const headline = chooseHeadline(base, fromVariant, source, profile, options.headline);
  const swaps = chooseSwaps(base.experience, reserves, scorer, Math.max(0, Math.floor(options.maxSwaps ?? 0)));
  const swapped = applySwaps(base.experience, swaps);
  const roles = swapped.map((entry) => entry.roles.map((role) => tailorRole(entry, role, scorer)));
  const reordered = swapped.map((entry, index) => ({ ...entry, roles: (roles[index] ?? []).map((role) => role.value) }));
  const withAddedSkills = addReserveSkills(base.skills, scorer, Math.max(0, Math.floor(options.maxAddedSkills ?? 0)));
  const skills = tailorSkills(withAddedSkills.value, scorer);

  const bulletScores = new Map(placedBullets({ experience: reordered }).map(({ bullet }) => [bullet.id, scorer.bullet(bullet)]));
  const scoreOf = (id: string) => bulletScores.get(id)?.score ?? 0;
  const droppable = dropOrder(reordered, scoreOf, minPerRole);
  const dropped = droppable.slice(0, dropCount);

  const changes: TailorChange[] = [
    ...(variantFound ? [] : [{ kind: "variant" as const, target: variantId, message: `resume.json has no variant "${variantId}"; started from the source order` }]),
    ...(headline.source === "override" && headline.text !== base.header.headline
      ? [{ kind: "headline" as const, target: "headline", message: `headline "${base.header.headline}" replaced by "${headline.text}", which passed the fact check` }]
      : []),
    ...swaps.map(swapChange),
    ...roles.flat().flatMap((role) => role.changes),
    ...withAddedSkills.changes,
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
    swaps: swaps.map((swap) => ({ in: swap.reserve.bullet.id, out: swap.out.bullet.id, upgrade: swap.upgrade, inScore: swap.inScore, outScore: swap.outScore })),
    addedSkills: withAddedSkills.changes.map((change) => change.target),
    droppable,
    dropped,
    scores: [...bulletScores.entries()].map(([id, match]) => ({ id, score: match.score, terms: match.terms })),
    jobTerms: [...jobTerms.values()].slice(0, 15).map((term) => ({ term: term.display, weight: term.weight })),
  };
}
