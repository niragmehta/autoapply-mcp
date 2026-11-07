export const WD_PLACEHOLDER = /^(select one|select\.{0,3}|search|)$/i;

/**
 * Yes and no are too short to match on substrings: "no" appears inside "NOT",
 * and "Yes, no restriction" contains both. A bare polarity answer therefore
 * only takes an option that leads with the same word - the rule the option
 * matcher already applies everywhere else.
 */
const WD_POLARITY = /^(yes|no)$/;

/** Substring matching alone lets "no" hide inside "not" and answer the opposite. */
export function containsWord(haystack: string, needle: string): boolean {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(haystack);
}

/**
 * A word can be whole inside its own refusal: "acknowledged" is a word of "Not
 * acknowledged". An option that negates and a candidate that does not (or the
 * reverse) state opposite answers, whatever words they share.
 */
const WD_NEGATION = /\b(not|never|no|none|neither|decline|disagree)\b/;

export function negated(text: string): boolean {
  return WD_NEGATION.test(text.replace(/n['\u2019]t\b/g, " not"));
}

/** Folds typographic quotes into plain ones: CoStar writes "Bachelor’s Degree". */
export function plainQuotes(text: string): string {
  return text.replace(/[\u2018\u2019\u02bc]/g, "'").replace(/[\u201c\u201d]/g, '"');
}

/**
 * A first-person consent sentence: S&P Global's HiredScore question offers only
 * "I consent to ..." and "I DO NOT consent to ...", which a bare "Yes" or "No"
 * opens neither of, so the required field failed. A refusal answers "No" and
 * the plain consent answers "Yes"; the shared negation test keeps them apart.
 */
const CONSENT_SENTENCE = /^i\s+(?:(?:do\s+not|don't)\s+)?(?:consent|agree|authori[sz]e|accept|opt[\s-]?(?:in|out))\b/;

function consentPolarityMatches(option: string, wanted: string): boolean {
  if (!CONSENT_SENTENCE.test(option)) return false;
  const refuses = negated(option) || /\bopt[\s-]?out\b/.test(option);
  return wanted === "no" ? refuses : !refuses;
}

export function matches(optionText: string, candidate: string): boolean {
  const option = plainQuotes(optionText).replace(/\s+/g, " ").trim().toLowerCase();
  const wanted = plainQuotes(candidate).replace(/\s+/g, " ").trim().toLowerCase();
  if (!option || !wanted) return false;
  if (WD_PLACEHOLDER.test(option)) return false;
  if (isRefusal(option) && isRefusal(wanted)) return true;
  if (WD_POLARITY.test(wanted)) return new RegExp(`^${wanted}\\b`, "i").test(option) || consentPolarityMatches(option, wanted);
  // A bare "Yes" or "No" is a whole answer, so it stands only for a candidate
  // that opens with it: "No, I will not require sponsorship". Taken as a word
  // anywhere, SCAN's "No" answered "Not Applicable/No Driving Requirements"
  // and Unity's answered a declined disclosure through "no response".
  if (WD_POLARITY.test(option)) return new RegExp(`^${option}\\s*[,.;:!()\\u2013\\u2014-]`).test(wanted);
  if (negated(option) !== negated(wanted)) return false;
  return option === wanted || containsWord(option, wanted) || containsWord(wanted, option);
}

/**
 * Employers name the same choice differently, and a Workday prompt offers no
 * free text to fall back on, so a stored answer has to be tried under the
 * tenant's own vocabulary. NVIDIA lists a mobile number as "Home Cellular".
 */
export const WD_SYNONYMS: readonly (readonly string[])[] = [["mobile", "cell", "cellular"]];

/**
 * A refusal to answer, however it is spelled.
 *
 * NVIDIA alone offers three spellings on one step - "Decline to State" for
 * ethnicity and gender, "I DO NOT WISH TO SELF-IDENTIFY" for veteran status -
 * and the stored answer says "decline to self-identify". Chasing that with a
 * list of literals is a losing game, so both sides are recognised as refusals
 * instead. Both must be refusals for this to apply, so a real answer can never
 * be turned into a decline.
 */
const WD_REFUSAL =
  /(declined? to|prefer not to|do not wish to|don't wish to|do not want to|choose not to|rather not|wish not to|not to disclose|not to self.?identify|not wish self.?identify|no response|not declared|undeclared|not specified|unspecified|did not provide)/;

export function isRefusal(text: string): boolean {
  return WD_REFUSAL.test(text);
}

export function expand(candidate: string): string[] {
  const lower = candidate.toLowerCase();
  const group = WD_SYNONYMS.find((words) => words.some((word) => lower.includes(word)));
  if (!group) return [candidate];
  return [candidate, ...group.filter((word) => !lower.includes(word))];
}

export function sameOptions(before: readonly string[], after: readonly string[]): boolean {
  return before.length === after.length && before.every((text, index) => text === after[index]);
}

/** The same values in any order: a picker lists its pills in the order they were added. */
export function sameValueSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value) => b.includes(value));
}

/**
 * Whether the widget now holds a wanted answer it did not hold before.
 *
 * A picker adds a pill, so its count grows. A single-select replaces its value
 * in place: counting misses a legitimate replacement of a value an earlier run
 * left behind, and equally misses a probe that swapped a correct value for a
 * wrong one. A replaced value only counts when it is one of the wanted answers.
 */
export function tookAnswer(after: readonly string[], baseline: readonly string[], wanted: readonly string[]): boolean {
  if (after.length > baseline.length) return true;
  return after.some((value) => !baseline.includes(value) && wanted.some((candidate) => matches(value, candidate)));
}

export type RankedOption = { option: string; rank: number };

function normalizedText(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Orders two options that both answer a candidate. One that says exactly what
 * was approved wins; otherwise the least qualified does, so given "Cellular"
 * and "Work Cellular" the bare one is meant. Shortest-first alone preferred
 * "LinkedIn" to an approved "LinkedIn Job Posting" offered beside it.
 */
export function closerTo(candidate: string, a: string, b: string): number {
  const wanted = normalizedText(candidate);
  const exact = Number(normalizedText(b) === wanted) - Number(normalizedText(a) === wanted);
  return exact !== 0 ? exact : a.length - b.length;
}

/**
 * The option closest to the approved answer. Candidates arrive in order of
 * preference, so the earliest candidate an option answers is its rank. Among
 * equals `closerTo` decides, as it does in `clickMatch`.
 */
export function bestRanked(options: readonly string[], candidates: readonly string[]): RankedOption | undefined {
  let best: RankedOption | undefined;
  for (const option of options) {
    const rank = candidates.findIndex((candidate) => matches(option, candidate));
    if (rank < 0) continue;
    if (best === undefined || rank < best.rank || (rank === best.rank && closerTo(candidates[rank]!, option, best.option) < 0)) {
      best = { option, rank };
    }
  }
  return best;
}

export function textGained(before: string, after: string, candidate: string): boolean {
  const wanted = candidate.replace(/\s+/g, " ").trim().toLowerCase();
  if (!wanted) return false;
  return containsWord(after, wanted) && !containsWord(before, wanted);
}

/** How many values the widget says it holds: its screen-reader count or its checked rows. */
function announcedCount(state: string): number {
  const items = /(\d+)\s+items?\s+selected/i.exec(state);
  const checked = /checked=(\d+)$/.exec(state);
  return Math.max(items ? Number(items[1]) : 0, checked ? Number(checked[1]) : 0);
}

/**
 * Whether the widget announces more than it did before the click. A
 * single-select still holding an old value says "1 item selected" whether or
 * not the click landed, so only a count that grew is evidence of the click.
 */
export function announcesNewSelection(before: string, after: string): boolean {
  return announcedCount(after) > announcedCount(before);
}
