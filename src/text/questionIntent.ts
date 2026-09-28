/**
 * Tests of what a question actually asks, as opposed to which stored pattern
 * happens to occur somewhere in its text.
 *
 * Stored answers are matched as literal substrings and the longest hit wins, so
 * an answer can be selected by words that sit in a question's preamble or
 * condition rather than in the question itself. Each test here recognises one
 * way that went wrong on a live form.
 */

/**
 * The sentences that ask something. A question mark closes each one, and each
 * opens where the previous sentence ended, so a label's preamble ("This role is
 * based in San Francisco.") and its trailing remarks ("Retell AI offers
 * relocation assistance") are not part of the question. A label with no
 * question mark is read whole, as in "Relocation assistance required".
 */
export function askedSentences(question: string): string[] {
  const pieces = question.split(/(?<=\?)/).filter((piece) => piece.includes("?"));
  if (pieces.length === 0) return [question];
  return pieces.map((piece) => {
    // Sentence ends are only taken before a capital, so "the U.S. office" stays whole.
    const sentences = piece.split(/(?<=[.!])\s+(?=[A-Z])/);
    return sentences[sentences.length - 1] ?? piece;
  });
}

const RELOCATION_ASSISTANCE =
  /\breloca\w*[\s-]+(?:assistance|support|package|benefits?|stipend|reimbursement|bonus)\b/;

/**
 * Retell AI asks "Are you open to working in-office 5x per week in the San
 * Francisco area? Retell AI offers relocation assistance to help make the move
 * easier". The only stored pattern in that label was "relocation assistance",
 * from the answer to whether the candidate needs assistance, so the employer
 * was told "No": he will not work onsite. An answer about relocation assistance
 * may only answer a question that asks about relocation assistance.
 */
export function relocationAssistanceMismatch(question: string, descriptions: readonly string[]): boolean {
  if (!descriptions.some((description) => RELOCATION_ASSISTANCE.test(description.toLowerCase()))) return false;
  return !askedSentences(question).some((sentence) => RELOCATION_ASSISTANCE.test(sentence.toLowerCase()));
}

const RELOCATION_ALTERNATIVE =
  /\bor\b[^?]{0,60}?\b(?:willing|open|ready|able|plan(?:ning)?|happy|prepared|intend(?:ing)?)\s+(?:to\s+)?(?:relocat\w*|move\b|be\b)/i;

/**
 * Whether a residence question also accepts a willingness to relocate, as in
 * Watershed's "Are you located in, or willing to relocate to the SF area?" or
 * Brex's "Do you currently live in, or plan to relocate to, the specified
 * location?". Either condition satisfies it, so a candidate who will relocate
 * answers "Yes" wherever he lives today.
 */
export function acceptsRelocationInstead(question: string): boolean {
  return RELOCATION_ALTERNATIVE.test(question);
}

const NOT_RESIDENT = String.raw`\bif\s+(?:you\s+)?(?:are|do)?\s*(?:not|n['\u2019\s]?t)\s+(?:currently\s+)?(?:located|based|living|residing|live|reside)\b`;
const WILLING_TO_RELOCATE = String.raw`\b(?:willing|open|ready|able|happy|prepared)\s+(?:to\s+)?relocat\w*`;
const RESIDENCE_AS_CONDITION = new RegExp(
  `${NOT_RESIDENT}[^?]*?${WILLING_TO_RELOCATE}|${WILLING_TO_RELOCATE}[^?]*?${NOT_RESIDENT}`,
  "i",
);

/**
 * Juicebox asks "If you are not currently located in the San Francisco Bay
 * Area, would you be willing to relocate?". The residence words are the
 * condition, not the question: only the willingness to relocate is asked, so
 * the guards that keep a residence claim from being answered with a relocation
 * decision do not apply. A question that also asks where he lives - "Are you
 * located there? If not, ..." - has no residence in its condition.
 */
export function residenceOnlyInCondition(question: string): boolean {
  return askedSentences(question).every((sentence) => RESIDENCE_AS_CONDITION.test(sentence));
}

const RELOCATION_SUPPORT = /assist|package|support|stipend|reimburs/i;

/** A decision about relocating, as opposed to relocation assistance. */
export function aboutRelocation(entry: { key: string; label: string }): boolean {
  const about = `${entry.key} ${entry.label}`;
  return /relocat/i.test(about) && !RELOCATION_SUPPORT.test(about);
}

/** An affirmative decision to relocate, judged from the entry's own wording. */
export function decidesRelocation(entry: { key: string; label: string; answer: string }): boolean {
  return aboutRelocation(entry) && /^\s*yes\b/i.test(entry.answer.trim());
}

const RELOCATION_TERM = /\b(?:relocat\w*|move|moving)\b/i;
// A negation up to three words ahead: "I am not open to relocation.", "Unable to move".
const REFUSED_RELOCATION =
  /\b(?:not|never|unable|unwilling|cannot|can['\u2019]?t|won['\u2019]?t|don['\u2019]?t)\b(?:\s+\S+){0,3}?\s+(?:relocat\w*|move|moving)\b/i;
const RESIDENCE_CLAIM =
  /\b(?:i\s+(?:currently\s+|already\s+)?(?:live|reside)|live here|live there|i\s+am\s+(?:currently\s+|already\s+)?(?:located|based)|i['\u2019]m\s+(?:currently\s+|already\s+)?(?:located|based)|(?:located|based|living|residing)\s+(?:in|near|within))\b/gi;

/**
 * Whether an option states that the candidate lives somewhere. Harvey's "No,
 * I'm not based in this location but willing to relocate" denies it, so a claim
 * directly preceded by a negation does not count.
 */
function claimsResidence(option: string): boolean {
  const text = option.replace(/n['\u2019]t\b/gi, " not");
  return [...text.matchAll(RESIDENCE_CLAIM)].some((match) => {
    const at = match.index ?? 0;
    return !/\bnot\s+(?:\S+\s+)?$/i.test(text.slice(Math.max(0, at - 24), at));
  });
}

/**
 * The one option that commits to relocating without claiming a residence.
 *
 * Brex offers "Yes, I live here", "Yes, I plan to relocate" and "No"; Ridgeline
 * offers "Yes, I am located in/near the Reno, NV area.", the same for San
 * Ramon, "I am open to relocation." and "I am not open to relocation.". An
 * option refusing to move, or asking for relocation support, is not such a
 * commitment. Undefined unless exactly one option qualifies, so an ambiguous
 * list goes to a person rather than to the first plausible option.
 */
export function relocationOption(options: readonly string[]): string | undefined {
  const fits = options.filter(
    (option) =>
      RELOCATION_TERM.test(option) &&
      !REFUSED_RELOCATION.test(option) &&
      !claimsResidence(option) &&
      !RELOCATION_SUPPORT.test(option),
  );
  return fits.length === 1 ? fits[0] : undefined;
}

const CHOICE_LIST_INSTRUCTION =
  /\((?:please\s+)?(?:select|choose|check|pick|tick)\b[^)]*\)|\b(?:select|choose|check|pick|tick)\s+(?:all|one|any|up\s+to|\d+)\b/i;

/**
 * An answer recorded for a choice list is one of that list's options. Abby Care
 * asks "Why are you interested in working at Abby Care? We read every single
 * answer" in a free-text box, and the stored pick for a "Why are you interested
 * in working here? (select all that apply)" list matched it, so the essay box
 * received the bare phrase "Products & Technical Innovation". Such an answer
 * only ever answers a question that offers choices.
 */
export function writtenForChoiceList(entry: { label: string }): boolean {
  return CHOICE_LIST_INSTRUCTION.test(entry.label);
}
