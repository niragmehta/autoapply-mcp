import type { Job } from "../domain/job.js";
import type { Profile } from "../domain/profile.js";
import { normalizeForMatch } from "../text/html.js";
import { readJdLines, type SectionKind } from "../text/jobDescription.js";
import { foldAcronymPlurals, normalizeTerm, normalizeWord, STOP_WORDS } from "../text/words.js";

/**
 * Weighted posting terms for document tailoring.
 *
 * It finds the terms a posting stresses and weighs them by where they appear:
 * the title and the requirements count most, the company boilerplate not at
 * all. Matching is on normalized words and two- or three-word phrases, with
 * the profile's skill aliases folded onto one canonical form ("k8s" counts as
 * "kubernetes") and a hyphen between letters read as a space. Everything is
 * deterministic so a reordering can be explained.
 */

/** Where a term appears: a section of the description, or the job title. */
type TermPlace = SectionKind | "title";

export type JobTerm = { term: string; display: string; weight: number; sections: TermPlace[] };

/** Normalized alias -> normalized canonical term. */
export type AliasMap = ReadonlyMap<string, string>;

export const SECTION_WEIGHT: Readonly<Record<TermPlace, number>> = {
  title: 3,
  requirements: 2,
  responsibilities: 1.5,
  preferred: 1,
  other: 1,
  about: 0,
  benefits: 0,
  compensation: 0,
  legal: 0,
};

const REPEAT_BONUS = 0.5;
const MAX_REPEATS = 4;
const PHRASE_BONUS = 1.5;

// Verbs, adjectives and seniority words: never a term and never part of a
// phrase, so "operating kafka" or "deep experience" is not one. "build" stays
// a word because it is a noun in "build times" and "build systems".
const LEAD_WORDS = new Set(
  (
    "strong solid deep proven excellent good great outstanding high highly large complex multiple various related relevant " +
    "equivalent ideal ideally minimum basic bonus nice key core senior junior staff principal fast paced passionate familiar " +
    "proficient work working worked building built develop developing developed lead leading led drive driving owning create " +
    "creating created help helping ensure ensuring support supporting deliver delivering delivered improve improving improved " +
    "implement implementing implemented manage managing managed partner partnering collaborate collaborating use using used " +
    "make making write writing run running operate operating join looking want seeking hiring"
  ).split(" "),
);

// Generic posting and resume nouns: never a term alone, but part of a phrase
// with a real term ("distributed systems", "application security").
const GENERIC_WORDS = new Set(
  (
    "experience experienced year skill knowledge understanding team role responsibility requirement qualification " +
    "preferred required candidate opportunity company development engineer engineering system time environment world " +
    "class best impact impactful day field degree passion familiarity proficiency hand scale scaling collaboration " +
    "application technology technical information issue decision improvement associate solution product business level " +
    "process project full production enterprise design action hour detail quality need way area part"
  ).split(" "),
);

// Punctuation that ends a phrase; a "." only when it ends a sentence, so
// "node.js" and ".net" survive.
const CHUNK_BREAK = /[,;:()[\]{}|!?\u2022\u00b7\u2013\u2014"\u201c\u201d]|\s-\s|\.(?=\s|$)/;

const isNumeric = (word: string) => /^[\d.,%+]+$/.test(word);

function isTermWord(word: string): boolean {
  return word.length >= 2 && !STOP_WORDS.has(word) && !LEAD_WORDS.has(word) && !GENERIC_WORDS.has(word) && !isNumeric(word);
}

/** Two or three words with no stop words or verbs and at least one real term: "distributed systems", "build times". */
function isPhrase(slice: readonly string[]): boolean {
  if (slice.some((word) => word.length < 2 || STOP_WORDS.has(word) || LEAD_WORDS.has(word) || isNumeric(word))) return false;
  return slice.some(isTermWord);
}

type RawTerm = { term: string; display: string; size: number };

// A hyphen between letters reads as a space, so "least-privilege" and "least
// privilege" are one term. "gpt-4o" and "sha-256" stay whole.
const LETTER_HYPHEN = /([a-z])-(?=[a-z])/g;

/** Terms in one piece of text: single words and two- or three-word phrases, aliases folded in. */
export function textTerms(text: string, aliases: AliasMap = new Map()): RawTerm[] {
  const found = new Map<string, RawTerm>();
  const add = (term: string, display: string, size: number) => {
    if (!found.has(term)) found.set(term, { term, display, size });
    const canonical = aliases.get(term);
    if (canonical && !found.has(canonical)) found.set(canonical, { term: canonical, display: canonical, size: canonical.split(" ").length });
  };
  for (const chunk of foldAcronymPlurals(text).split(CHUNK_BREAK)) {
    const surface = normalizeForMatch(chunk)
      .replace(LETTER_HYPHEN, "$1 ")
      .split(" ")
      .filter((word) => word.length > 0);
    const normal = surface.map(normalizeWord);
    normal.forEach((word, index) => {
      if (isTermWord(word) || aliases.has(word)) add(word, surface[index] ?? word, 1);
      // A compound also names its parts: "Python/Go" is evidence of Python.
      for (const part of /[-/]/.test(word) ? word.split(/[-/]/).map(normalizeWord) : []) {
        if (part.length >= 3 && (isTermWord(part) || aliases.has(part))) add(part, part, 1);
      }
      for (const size of [2, 3]) {
        const slice = normal.slice(index, index + size);
        if (slice.length === size && isPhrase(slice)) add(slice.join(" "), surface.slice(index, index + size).join(" "), size);
      }
    });
  }
  return [...found.values()];
}

/**
 * The terms that name a skill outright: its two- and three-word phrases, or
 * its words when it has no phrase ("Rust"; "Key Vault", whose "key" is
 * filler). "Azure Data Explorer" is named by "data explorer", never by "data".
 */
export function namingTerms(skill: string, aliases: AliasMap = new Map()): string[] {
  const terms = textTerms(skill, aliases);
  const phrases = terms.filter((entry) => entry.size > 1);
  return (phrases.length > 0 ? phrases : terms).map((entry) => entry.term);
}

/** Every normalized term in `text`, for set intersection. */
export function termSet(texts: readonly string[], aliases: AliasMap = new Map()): Set<string> {
  return new Set(texts.flatMap((text) => textTerms(text, aliases).map((entry) => entry.term)));
}

/** Folds each skill alias onto its skill's name, so either spelling matches the other. */
export function aliasMap(profile: Pick<Profile, "skills">): Map<string, string> {
  const map = new Map<string, string>();
  for (const skill of profile.skills) {
    const canonical = normalizeTerm(skill.name);
    if (canonical.length === 0) continue;
    for (const alias of skill.aliases) {
      const key = normalizeTerm(alias);
      if (key.length > 0 && key !== canonical) map.set(key, canonical);
    }
  }
  return map;
}

/**
 * The posting's terms with weights. A term is worth the weight of the most
 * important section it appears in, half as much again for each further line that
 * repeats it (up to four), and half as much again when it is a phrase. Where
 * a term appears matters more than how often: repetition through a long
 * posting cannot outweigh a single mention in the requirements.
 */
export function extractJobTerms(job: Pick<Job, "title" | "descriptionText">, aliases: AliasMap = new Map()): Map<string, JobTerm> {
  const lines: Array<{ text: string; place: TermPlace }> = [
    { text: job.title, place: "title" },
    ...readJdLines(job.descriptionText)
      .filter((line) => !line.heading)
      .map((line) => ({ text: line.text, place: line.section })),
  ];
  const totals = new Map<string, { display: string; size: number; best: number; lines: number; sections: Set<TermPlace> }>();
  for (const line of lines) {
    const weight = SECTION_WEIGHT[line.place];
    if (weight === 0) continue;
    for (const entry of textTerms(line.text, aliases)) {
      const current = totals.get(entry.term) ?? { display: entry.display, size: entry.size, best: 0, lines: 0, sections: new Set<TermPlace>() };
      totals.set(entry.term, {
        ...current,
        best: Math.max(current.best, weight),
        lines: current.lines + 1,
        sections: new Set([...current.sections, line.place]),
      });
    }
  }
  const weighted = [...totals.entries()].map(([term, value]) => ({
    term,
    display: value.display,
    weight: round(value.best * (1 + REPEAT_BONUS * Math.min(value.lines - 1, MAX_REPEATS)) * (value.size > 1 ? PHRASE_BONUS : 1)),
    sections: [...value.sections],
  }));
  return new Map(weighted.sort((a, b) => b.weight - a.weight || a.term.localeCompare(b.term)).map((entry) => [entry.term, entry]));
}

export type TermMatch = { score: number; terms: string[] };

function insidePhrase(longer: string, shorter: string): boolean {
  return longer !== shorter && ` ${longer} `.includes(` ${shorter} `);
}

/**
 * Weighted overlap between a candidate's terms and the posting's. A word or
 * phrase inside a longer matched phrase is the same evidence, so only the
 * longest match counts.
 */
export function scoreTerms(candidate: ReadonlySet<string>, jobTerms: ReadonlyMap<string, JobTerm>): TermMatch {
  const matched = [...candidate].filter((term) => jobTerms.has(term));
  const kept = matched.filter((term) => !matched.some((other) => insidePhrase(other, term)));
  const ranked = kept
    .map((term) => jobTerms.get(term))
    .filter((entry): entry is JobTerm => entry !== undefined)
    .sort((a, b) => b.weight - a.weight || a.term.localeCompare(b.term));
  return { score: round(ranked.reduce((sum, entry) => sum + entry.weight, 0)), terms: ranked.map((entry) => entry.display) };
}

export function round(value: number): number {
  return Math.round(value * 100) / 100;
}
