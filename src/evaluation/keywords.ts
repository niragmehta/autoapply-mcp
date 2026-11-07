import type { Campaign } from "../domain/campaign.js";
import type { Profile } from "../domain/profile.js";
import { findKnownTerms, findTechLikeTokens, mentionsTerm } from "../text/techTerms.js";
import { containsPhrase } from "../text/words.js";
import type { Importance, RequirementItem } from "./requirements.js";

/**
 * ATS keyword coverage: how much of the posting's important vocabulary the
 * candidate's document carries.
 *
 * Diagnostic only. A missing keyword the profile supports is safe to
 * emphasise (reword, never invent); a missing keyword the profile does not
 * support must not be added. Keywords are weighted by where they appear
 * (title, requirement items by importance, responsibilities) and how often.
 */

type KeywordEntry = { term: string; weight: number; present: boolean; supported: boolean };

export type KeywordCoverage = {
  /** Weighted share of keyword importance the document covers, 0-100. */
  coveragePercent: number;
  document: "resume-text" | "profile";
  keywords: KeywordEntry[];
  present: string[];
  /** Absent from the document but backed by the profile: safe to emphasise. */
  missingSupported: string[];
  /** Absent and unsupported: must not be added. */
  missingUnsupported: string[];
};

type KeywordInput = {
  title: string;
  jdText: string;
  requirements: readonly RequirementItem[];
  responsibilities: readonly string[];
  profile: Profile;
  campaign: Campaign;
  companyName?: string;
  /** The resume actually being sent; the profile corpus stands in when absent. */
  resumeText?: string;
};

const IMPORTANCE_WEIGHT: Readonly<Record<Importance, number>> = { required: 3, preferred: 1.5, bonus: 0.75 };
const MAX_KEYWORDS = 30;

type Keyword = { term: string; matches: (text: string) => boolean; trackWeight: number };

function keywordCandidates(input: KeywordInput): Keyword[] {
  const known: Keyword[] = findKnownTerms(input.jdText).map(({ term }) => ({
    term: term.term,
    matches: (text: string) => mentionsTerm(text, term),
    trackWeight: 0,
  }));
  const seen = new Set(known.map((keyword) => keyword.term.toLowerCase()));
  const track: Keyword[] = input.campaign.tracks
    .flatMap((entry) => entry.keywords)
    .filter((keyword) => [keyword.term, ...keyword.aliases].some((variant) => containsPhrase(input.jdText, variant)))
    .filter((keyword) => !seen.has(keyword.term.toLowerCase()))
    .map((keyword) => ({
      term: keyword.term,
      matches: (text: string) => [keyword.term, ...keyword.aliases].some((variant) => containsPhrase(text, variant)),
      trackWeight: keyword.weight,
    }));
  for (const keyword of track) seen.add(keyword.term.toLowerCase());
  const tokens: Keyword[] = findTechLikeTokens(input.requirements.map((item) => item.text).join("\n"), (input.companyName ?? "").split(/\s+/))
    .filter((token) => !seen.has(token.toLowerCase()))
    .slice(0, 10)
    .map((token) => ({ term: token, matches: (text: string) => containsPhrase(text, token), trackWeight: 0 }));
  // Track keywords can repeat across tracks; keep the heaviest.
  const merged = new Map<string, Keyword>();
  for (const keyword of [...known, ...track, ...tokens]) {
    const key = keyword.term.toLowerCase();
    const existing = merged.get(key);
    if (!existing || keyword.trackWeight > existing.trackWeight) merged.set(key, keyword);
  }
  return [...merged.values()];
}

function weightOf(keyword: Keyword, input: KeywordInput): number {
  let weight = 0;
  if (keyword.matches(input.title)) weight += 4;
  for (const item of input.requirements) {
    if (keyword.matches(item.text)) weight += IMPORTANCE_WEIGHT[item.importance] * (item.weightSource === "estimate" ? 0.5 : 1);
  }
  weight += Math.min(3, input.responsibilities.filter((line) => keyword.matches(line)).length);
  const frequency = input.jdText.split(/\n+/).filter((line) => keyword.matches(line)).length;
  weight += Math.min(5, frequency) * 0.5;
  weight += keyword.trackWeight * 0.5;
  return Math.round(weight * 10) / 10;
}

/** Everything the profile verifies, for deciding whether a missing keyword may be emphasised. */
function profileSupportCorpus(profile: Profile): string {
  return [
    profile.identity.headline,
    ...profile.skills.flatMap((skill) => [skill.name, ...skill.aliases, ...skill.tags]),
    ...profile.facts.flatMap((fact) => [fact.statement, ...fact.tags, ...fact.metrics]),
    ...profile.experience.flatMap((role) => [role.title, ...role.highlights]),
    ...profile.education.flatMap((entry) => [entry.credential, entry.field]),
  ].join("\n");
}

/** What a resume built from the profile would show: skills, facts and experience prose. */
function profileDocument(profile: Profile): string {
  return [
    profile.identity.headline,
    ...profile.skills.flatMap((skill) => [skill.name, ...skill.aliases]),
    ...profile.facts.map((fact) => fact.statement),
    ...profile.experience.flatMap((role) => [role.title, ...role.highlights]),
  ].join("\n");
}

export function keywordCoverage(input: KeywordInput): KeywordCoverage {
  const document = input.resumeText?.trim() ? input.resumeText : profileDocument(input.profile);
  const support = profileSupportCorpus(input.profile);
  const keywords = keywordCandidates(input)
    .map((keyword) => {
      const present = keyword.matches(document);
      return { term: keyword.term, weight: weightOf(keyword, input), present, supported: present || keyword.matches(support) };
    })
    .filter((keyword) => keyword.weight >= 1)
    .sort((a, b) => b.weight - a.weight || a.term.localeCompare(b.term))
    .slice(0, MAX_KEYWORDS);
  const total = keywords.reduce((sum, keyword) => sum + keyword.weight, 0);
  const covered = keywords.filter((keyword) => keyword.present).reduce((sum, keyword) => sum + keyword.weight, 0);
  return {
    coveragePercent: total > 0 ? Math.round((covered / total) * 100) : 0,
    document: input.resumeText?.trim() ? "resume-text" : "profile",
    keywords,
    present: keywords.filter((keyword) => keyword.present).map((keyword) => keyword.term),
    missingSupported: keywords.filter((keyword) => !keyword.present && keyword.supported).map((keyword) => keyword.term),
    missingUnsupported: keywords.filter((keyword) => !keyword.supported).map((keyword) => keyword.term),
  };
}
