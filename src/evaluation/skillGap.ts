import type { Profile } from "../domain/profile.js";
import { skillBearingText } from "../text/jobDescription.js";
import { findKnownTerms, findTechLikeTokens, lookupTerm, mentionsTerm } from "../text/techTerms.js";
import type { TechCategory, TechTerm } from "../text/techVocabulary.js";
import { containsPhrase, shortQuote } from "../text/words.js";
import type { Importance, RequirementItem } from "./requirements.js";

/**
 * The posting's skill terms in three buckets, so a resume can be tailored
 * honestly (after career-ops' jd-skill-gap, MIT):
 *
 * - `existing`: named in profile.skills, by name or alias.
 * - `supportedByProfile`: not a listed skill, but verified facts or experience
 *   highlights mention it - safe to surface.
 * - `gap`: nothing in the profile mentions it. Never claim these.
 *
 * Terms come from a curated dictionary plus technical-looking tokens in the
 * requirement items. Nothing is ever added to the profile.
 */

type SkillGapEntry = {
  term: string;
  category: TechCategory | "other";
  mentions: number;
  /** Highest importance among requirement items naming the term; null when only named elsewhere. */
  importance: Importance | null;
};

export type SkillGap = {
  existing: Array<SkillGapEntry & { skill: string; level: string }>;
  supportedByProfile: Array<SkillGapEntry & { citations: Array<{ ref: string; quote: string }> }>;
  gap: SkillGapEntry[];
};

const IMPORTANCE_RANK: Readonly<Record<Importance, number>> = { required: 3, preferred: 2, bonus: 1 };

type Candidate = { term: string; category: TechCategory | "other"; mentions: number; matches: (text: string) => boolean; entry: TechTerm | null };

function candidates(jdText: string, requirements: readonly RequirementItem[], companyName: string): Candidate[] {
  const known: Candidate[] = findKnownTerms(jdText).map(({ term, count }) => ({
    term: term.term,
    category: term.category,
    mentions: count,
    matches: (text: string) => mentionsTerm(text, term),
    entry: term,
  }));
  const requirementText = requirements.map((item) => item.text).join("\n");
  const extra: Candidate[] = findTechLikeTokens(requirementText, companyName.split(/\s+/)).map((token) => ({
    term: token,
    category: "other",
    mentions: requirements.filter((item) => containsPhrase(item.text, token)).length,
    matches: (text: string) => containsPhrase(text, token),
    entry: null,
  }));
  return [...known, ...extra.slice(0, 15)];
}

function importanceOf(candidate: Candidate, requirements: readonly RequirementItem[]): Importance | null {
  return requirements
    .filter((item) => candidate.matches(item.text))
    .reduce<Importance | null>((best, item) => (best === null || IMPORTANCE_RANK[item.importance] > IMPORTANCE_RANK[best] ? item.importance : best), null);
}

export function analyzeSkillGap(
  jdText: string,
  requirements: readonly RequirementItem[],
  profile: Profile,
  companyName = "",
): SkillGap {
  const result: SkillGap = { existing: [], supportedByProfile: [], gap: [] };
  const prose = [
    ...profile.facts.map((fact) => ({ ref: fact.id, text: [fact.statement, ...fact.tags, ...fact.metrics].join(" ") })),
    ...profile.experience.flatMap((role, index) =>
      [role.title, ...role.highlights].map((text) => ({ ref: `experience[${index}] ${role.title}, ${role.company}`, text })),
    ),
  ];

  for (const candidate of candidates(skillBearingText(jdText), requirements, companyName)) {
    const base: SkillGapEntry = {
      term: candidate.term,
      category: candidate.category,
      mentions: candidate.mentions,
      importance: importanceOf(candidate, requirements),
    };
    const skill = profile.skills.find((entry) =>
      [entry.name, ...entry.aliases].some(
        (name) => candidate.matches(name) || (candidate.entry !== null && lookupTerm(name)?.term === candidate.entry.term),
      ),
    );
    if (skill) {
      result.existing.push({ ...base, skill: skill.name, level: skill.level });
      continue;
    }
    const supporting = prose.filter((entry) => candidate.matches(entry.text)).slice(0, 3);
    if (supporting.length > 0) {
      result.supportedByProfile.push({ ...base, citations: supporting.map((entry) => ({ ref: entry.ref, quote: shortQuote(entry.text) })) });
      continue;
    }
    result.gap.push(base);
  }

  const rank = (entry: SkillGapEntry) => (entry.importance === null ? 0 : IMPORTANCE_RANK[entry.importance]);
  const order = (a: SkillGapEntry, b: SkillGapEntry) => rank(b) - rank(a) || b.mentions - a.mentions || a.term.localeCompare(b.term);
  return {
    existing: [...result.existing].sort(order),
    supportedByProfile: [...result.supportedByProfile].sort(order),
    gap: [...result.gap].sort(order),
  };
}
