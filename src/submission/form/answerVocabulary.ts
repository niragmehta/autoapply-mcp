import type { DraftAnswer } from "../../domain/job.js";
import type { FieldDescriptor } from "./fieldModel.js";

export const BOOLEAN_ANSWER = /^(yes|no|true|false|1|0|on|off|i agree|agree|i consent|consent|i acknowledge|acknowledge|i understand|understand|understood|i confirm|confirm|i accept|accept)\b/i;

/**
 * Boards word the same consent a dozen ways, and the box itself is often
 * labelled with nothing but the phrase it wants back. Matching and ticking read
 * this one list so a control can never be judged answerable and then left clear.
 */
const AFFIRMATIVE_ANSWER =
  /^(yes|true|1|on|agree|i agree|consent|i consent|acknowledge|i acknowledge|understand|i understand|understood|confirm|i confirm|accept|i accept|acknowledge\/confirm)\b/i;

export function isAffirmativeAnswer(value: string): boolean {
  return AFFIRMATIVE_ANSWER.test(value.trim());
}

/**
 * Anchored at the start but deliberately open at the end: boards attach the
 * subject to the option itself, as in "I decline to self-identify for
 * protected veteran status". Requiring an exact match would leave those
 * fields on their default, which for a veteran question means answering it.
 */
export const DECLINE_ANSWER_PATTERN =
  /^(?:i\s+)?(?:decline to (?:self[\s-]?identify|answer|state)|(?:do not|don't) wish to (?:answer|self[\s-]?identify)|wish not to (?:answer|self[\s-]?identify|disclose)|prefer not to (?:answer|say|disclose))\b/i;

/**
 * A label telling the candidate to decline by selecting nothing. Thomson
 * Reuters asks "Please select your gender; if you would prefer not to specify
 * your gender, do not select any option or chose the "select one" option." and
 * offers only Female and Male, so no decline wording can ever be found there.
 */
const LEAVE_UNSELECTED_TO_DECLINE =
  /\b(?:do not|don['\u2019]t)\s+select\s+any\s+(?:option|answer|response)s?\b|\bcho{1,2}se\s+the\s+["'\u201C\u201D]?select one["'\u201C\u201D]?\s+option\b|\bleave\s+(?:this|it|the\s+(?:field|question))\s+blank\b/i;

/** An optional question that the form itself says is declined by selecting nothing. */
export function declinesByLeavingBlank(field: FieldDescriptor, answer: DraftAnswer): boolean {
  return !field.required && DECLINE_ANSWER_PATTERN.test(answer.answer.trim()) && LEAVE_UNSELECTED_TO_DECLINE.test(field.label);
}

/**
 * Boards word the "decline to answer" option differently — Greenhouse alone
 * ships "Decline to self identify", "I don't wish to answer" and "Prefer not to
 * say" across customers. Offer every phrasing so one approved answer works
 * everywhere.
 *
 * Some boards state the decline as an outcome rather than a refusal: Pinecone's
 * pronouns question offers "she/her", "he/him", "they/them" and "did not
 * provide". Nothing there says "prefer" or "decline", so a stored decline
 * matched no option and blocked the whole application over the one field whose
 * answer was already settled. Entries are matched as substrings after
 * punctuation is normalized away, so "not to disclose" covers "choose not to",
 * "prefer not to" and "decline to disclose" in one line.
 */
export const DECLINE_OPTION_CANDIDATES = [
  "wish to answer",
  "want to answer",
  // Palo Alto Networks words the refusal as a wish: "Wish Not To Answer (United
  // States of America)". None of the entries above is a substring of it, so a
  // decline could not recognise its own option and the race list stayed empty.
  "wish not to answer",
  // Negated: "wish to self identify" is also a substring of the affirmative
  // "I wish to self-identify", which a decline then selected.
  "not wish to self identify",
  "Decline to self identify",
  "Decline to self-identify",
  "Prefer not to say",
  "Prefer not to answer",
  "Decline to answer",
  "did not provide",
  "not provided",
  "not to disclose",
  "not wish to disclose",
  "not to self identify",
  // Global Payments (TSYS) drops the "to": "I do not wish self-identify". Kept
  // negated so the affirmative "I wish to self-identify" can never match it.
  "not wish self identify",
  "rather not say",
  // Adobe states the decline as a status rather than a refusal: its gender
  // prompt offers only "Female", "Male" and "Not declared". Nothing there
  // reads as declining, so every refusal-shaped candidate missed and the
  // field failed even though the intended answer was sitting in the list.
  "not declared",
  "undeclared",
  "not specified",
  "unspecified",
  "no response",
  // Adobe's ethnicity prompt words the decline in the past tense, as
  // "Declined to State (United States of America)".
  "declined to state",
  // Riot Games' Greenhouse race and gender questions offer "Decline to state",
  // which the past tense above is not a substring of, so a required race
  // question failed with the decline sitting in its own list.
  "Decline to state",
  // Trend Micro's veteran prompt offers only "Yes", "No" and "Opt-Out".
  "Opt-Out",
  "Opt out",
];

/** Whether a candidate list is the decline search `optionSearchCandidates` builds. */
export function isDeclineSearch(candidates: readonly string[]): boolean {
  return DECLINE_OPTION_CANDIDATES.every((decline) => candidates.includes(decline));
}
