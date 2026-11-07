import { normalizeForMatch } from "./html.js";

/**
 * Words and the normalised forms every comparison uses, shared by document
 * tailoring, evaluation, the career suite and analytics so that "Systems" and
 * "system", or "APIs" and "API", are the same word in every feature.
 */

const wordList = (text: string): ReadonlySet<string> => new Set(text.trim().split(/\s+/));

/** Function words: never a term on their own and never part of a phrase. */
export const STOP_WORDS = wordList(`
  a an the and or nor but if then than so as at by for from in into of on onto to with without within across over under
  about after before between during through via per vs etc e.g i.e eg ie is are was were be been being am do does did
  have has had having will would shall should can could may might must not no yes it its this that these those there
  here we us our ours you your yours they them their he she his her i me my who whom whose which what when where why
  how all any each every some such more most other another both either neither few many much own same very also just
  well like including include includes included based able ability new plus up out off while only upon whether until
  unless since i'm i've i'd i'll you're you've you'd you'll we're we've we'd we'll they're they've don't doesn't didn't
  won't can't isn't aren't
`);

/**
 * Posting and resume filler that says nothing about a skill ("strong",
 * "experience", "teams"), for loose overlap matching. Document tailoring
 * keeps finer lists of its own because it weighs phrases.
 */
const FILLER_WORDS = wordList(`
  experience experienced strong solid proven deep excellent good great high highly skill skills knowledge understanding
  familiarity role team teams preferred required requirement requirements qualification qualifications responsibility
  responsibilities responsible ideal ideally candidate candidates join help make makes way ways least minimum related
  relevant equivalent similar various multiple ensure ensuring looking want need needs get one two three time part work
  working works year years use using used abilities build building built
`);

/** Short terms worth keeping despite the three-letter floor of `contentTerms`. */
const SHORT_TERMS = wordList("ai ml ui ux qa ci cd bi os ar vr ip pm hr");

/** Singular "-che" words, whose plural must not lose its "e" as "matches" does. */
const CHE_SINGULARS = wordList("cache niche headache avalanche cliche quiche moustache psyche");

/** Words ending in "s" that are not plurals. */
const INVARIANT = wordList("series species news");

/**
 * Folds a plural onto its singular: "policies" to "policy", "processes" to
 * "process", "systems" to "system". Only plain lowercase words of four or
 * more letters change, so "aws", "k8s" and "node.js" pass through.
 */
export function singular(word: string): string {
  if (!/^[a-z]{4,}$/.test(word) || INVARIANT.has(word)) return word;
  if (word.endsWith("ies")) return word.length > 4 ? `${word.slice(0, -3)}y` : word.slice(0, -1);
  if (/(?:ss|x|ch|sh|zz)es$/.test(word) && !CHE_SINGULARS.has(word.slice(0, -1))) return word.slice(0, -2);
  if (/(?:ss|us|is)$/.test(word) || !word.endsWith("s")) return word;
  return word.slice(0, -1);
}

/**
 * A loose stem for overlap matching: the singular, then a trailing "-ing" or
 * "-ed" removed, so "guardrails" meets "guardrail" and "building" meets
 * "build". Tokens with digits or symbols (c++, node.js, k8s) pass through.
 */
export function stem(word: string): string {
  const base = singular(word);
  if (base.length <= 3 || /[^a-z]/.test(base)) return base;
  if (base.endsWith("ing") && base.length > 6) return base.slice(0, -3);
  if (base.endsWith("ed") && base.length > 5) return base.slice(0, -2);
  return base;
}

/** Edge punctuation and a possessive "'s" removed; ".net" keeps its dot. */
function trimToken(raw: string): string {
  return raw
    .replace(/(?:'|\u2019)s$/, "")
    .replace(/^['"/-]+/, "")
    .replace(/^\.(?![a-z])/, "")
    .replace(/['"./-]+$/, "");
}

/** Lowercase tokens in order, technical characters kept ("c#", ".net", "ci/cd", "kafka-backed"). */
export function tokens(text: string): string[] {
  return normalizeForMatch(text)
    .split(" ")
    .map(trimToken)
    .filter((token) => token.length > 0);
}

/** One normalised word: lowercase, edge punctuation trimmed, plural folded. */
export function normalizeWord(raw: string): string {
  return singular(trimToken(raw.toLowerCase()));
}

/** "APIs" and "KPIs" fold to their acronym before lowercasing hides that they are plurals. */
export function foldAcronymPlurals(text: string): string {
  return text.replace(/\b([A-Z][A-Z0-9]+)s\b/g, "$1");
}

/** Normalised words of `text` in order. */
export function words(text: string): string[] {
  return tokens(foldAcronymPlurals(text)).map(singular);
}

/** A phrase in the normalised form every comparison uses. */
export function normalizeTerm(phrase: string): string {
  return words(phrase).join(" ");
}

/**
 * Distinct stemmed content words of `text`, in first-seen order: stop words
 * and filler dropped, short technical terms ("ai", "ci") kept.
 */
export function contentTerms(text: string): string[] {
  const found = new Set<string>();
  for (const token of tokens(text)) {
    if (SHORT_TERMS.has(token)) {
      found.add(token);
      continue;
    }
    if (token.length < 3 || STOP_WORDS.has(token) || FILLER_WORDS.has(token) || !/[a-z]/.test(token)) continue;
    const stemmed = stem(token);
    if (!FILLER_WORDS.has(stemmed)) found.add(stemmed);
  }
  return [...found];
}

/**
 * Distinct content words of four letters or more, unstemmed, with compounds
 * split ("Kafka-backed" gives "kafka" and "backed"): the words two texts can
 * be counted as sharing.
 */
export function significantWords(text: string): string[] {
  const parts = tokens(text).flatMap((token) => token.split(/[-/.']+/));
  return [
    ...new Set(parts.filter((word) => word.length >= 4 && !STOP_WORDS.has(word) && !FILLER_WORDS.has(word) && !/^\d+$/.test(word))),
  ];
}

/** Words in `text`: whitespace-separated runs holding a letter or digit, so a dash or a bullet is not a word. */
export function wordCount(text: string): number {
  return text.split(/\s+/).filter((word) => /[\p{L}\p{N}]/u.test(word)).length;
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Case-insensitive phrase match on word boundaries ("go" never matches "going", "C++" still matches). */
export function containsPhrase(text: string, phrase: string): boolean {
  const needle = phrase.trim();
  if (needle.length === 0) return false;
  return new RegExp(`(?<![A-Za-z0-9])${escapeRegExp(needle)}(?![A-Za-z0-9])`, "i").test(text);
}

/** Text flattened to one line and cut at a word boundary with an ellipsis when longer than `max`. */
export function shortQuote(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  if (flat.length <= max) return flat;
  const cut = flat.slice(0, max - 1);
  const space = cut.lastIndexOf(" ");
  return `${(space > max / 2 ? cut.slice(0, space) : cut).replace(/[,;:\s]+$/, "")}\u2026`;
}
