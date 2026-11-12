import { pickNumericBandIndex } from "../../drafting/numericBands.js";
import { BOOLEAN_ANSWER, DECLINE_ANSWER_PATTERN, DECLINE_OPTION_CANDIDATES } from "./answerVocabulary.js";

const BARE_POLARITY = /^(?:yes|no)$/;

/** True when an option label plausibly represents the requested value. */
export function optionTextMatches(optionText: string, value: string): boolean {
  if (isWebAddress(value)) return optionSpellsAddress(optionText, value);
  const option = normalizeOptionText(optionText);
  const expected = normalizeOptionText(value);
  if (option.length === 0 || expected.length === 0) return false;
  if (option === expected) return true;
  // A short token must appear as a whole word, in whichever direction the
  // containment runs. Without this an option of "No" matches the answer "I do
  // not wish to answer", because "no" sits inside "not" - turning a decline
  // into a substantive answer about a protected characteristic.
  if (expected.length <= 3) {
    return option.split(" ").includes(expected);
  }
  if (option.length <= 3) {
    // A bare "Yes" or "No" is a whole answer, so it stands only for an answer
    // that opens with it and then stops or punctuates: "No, I will not require
    // sponsorship". As a word anywhere, "No" took "Not applicable - no driving
    // requirement" and said the candidate could not meet the requirement.
    if (BARE_POLARITY.test(option)) {
      return new RegExp(`^\\s*${option}\\s*(?:[,.;:!()\\u2013\\u2014-]|$)`, "i").test(value);
    }
    return expected.split(" ").includes(option);
  }
  if (option.includes(expected) || expected.includes(option)) return true;
  const locality = normalizeOptionText(value.split(",")[0] ?? "");
  return locality.length > 1 && option.startsWith(locality);
}

const POSITIVE_LEAD = /^(?:yes|true|agree|agreed|accept|confirm|confirmed)$/;
const NEGATIVE_LEAD = /^(?:no|not|never|false|decline|disagree)$/;

/**
 * A "No" must not select an option that opens with "Yes". Datadog offers
 * "Yes, no restriction.", which contains "no" as a whole word, so a stored "No"
 * matched it and would have reported unrestricted work authorization to an
 * employer - the exact opposite of the stored answer. Whole-word containment is
 * not enough here: when a candidate opens with a polarity word, the option's own
 * leading polarity decides.
 *
 * The candidate does not have to be nothing but that word. "No - based in
 * Vancouver, Canada and willing to relocate." answering "are you currently based
 * in the listed location and able to work in person 3 days per week?" shares
 * almost all its wording with the option that begins "Yes, I'm based in this
 * location", and picked it on similarity alone - stating the opposite of the
 * stored fact about where the candidate lives.
 */
export function optionPolarityConflicts(optionText: string, candidate: string): boolean {
  const expected = normalizeOptionText(candidate);
  const candidateLead = expected.split(" ")[0] ?? "";
  const candidatePositive = POSITIVE_LEAD.test(candidateLead);
  const candidateNegative = NEGATIVE_LEAD.test(candidateLead);
  if (!candidatePositive && !candidateNegative) return false;
  const lead = normalizeOptionText(optionText).split(" ")[0] ?? "";
  const optionPositive = POSITIVE_LEAD.test(lead);
  const optionNegative = NEGATIVE_LEAD.test(lead);
  if (!optionPositive && !optionNegative) return false;
  return candidatePositive ? optionNegative : optionPositive;
}

/**
 * True when an option states the opposite of the candidate it otherwise
 * contains, e.g. "I am not willing to relocate" for "willing to relocate".
 * Decline phrasings are exempt because "I do not want to answer" is itself the
 * option we are looking for.
 */
function optionNegatesCandidate(optionText: string, candidate: string): boolean {
  const expected = normalizeOptionText(candidate);
  if (expected.length === 0 || expected.startsWith("not ")) return false;
  if (DECLINE_OPTION_CANDIDATES.some((decline) => normalizeOptionText(decline) === expected)) {
    return false;
  }
  return normalizeOptionText(optionText).includes(`not ${expected}`);
}

/**
 * True when the candidate declines to answer but the option states something
 * substantive. Declining is a refusal to disclose, so it may only ever select
 * an option that is itself a decline; anything else would put words in the
 * candidate's mouth about a protected characteristic.
 */
function optionContradictsDecline(optionText: string, candidate: string): boolean {
  if (!isDeclinePhrase(candidate)) return false;
  return !isDeclinePhrase(optionText);
}

export function isDeclinePhrase(text: string): boolean {
  const normalized = normalizeOptionText(text);
  if (normalized.length === 0) return false;
  if (DECLINE_ANSWER_PATTERN.test(text.trim())) return true;
  return DECLINE_OPTION_CANDIDATES.some((decline) => normalized.includes(normalizeOptionText(decline)));
}

/**
 * A choice list that counts TN as sponsorship asks something the generic
 * authorization answers were not written for. Lyft offered "I require/will
 * require Lyft's sponsorship ... (e.g. H-1B, TN, etc.)" beside "I am authorized
 * to work for any employer", and the stored statement selected the latter.
 * Only an answer that itself names TN may choose from such a list; otherwise
 * the field is left for a person.
 */
const TN_NAMED = /\b(?:tn|usmca|nafta)\b/i;

function countsTnAsSponsorship(optionTexts: readonly string[]): boolean {
  return optionTexts.some((text) => TN_NAMED.test(text) && /sponsor/i.test(text));
}

/** Wording that claims US citizenship or US permanent residency outright. */
const US_STATUS_CLAIM =
  /\b(?:u\.?\s?s\.?\s+citizen|citizen of the (?:united states|u\.?\s?s\.?)|american citizen|green\s?card|(?:lawful\s+)?permanent\s+resident)/i;
/** A choice that denies the status, such as "No, I am not a US citizen", claims nothing. */
const DENIES_US_STATUS = /\b(?:not|neither|nor)\s+(?:a\s+|an\s+)?(?:u\.?\s?s\.?\s+)?(?:citizen|permanent resident|green\s?card)/i;

/** Index of the option best matching any candidate, or -1 when none match. */
export function pickOptionIndex(
  optionTexts: readonly string[],
  candidates: readonly string[],
): number {
  if (countsTnAsSponsorship(optionTexts) && !candidates.some((candidate) => TN_NAMED.test(candidate))) {
    return -1;
  }
  // A stored "Yes" says the candidate is authorized, not how. Lists offering
  // "Yes - US Citizen", "Yes - Permanent Resident" and "Yes - Visa holder" let
  // the bare word take the first, claiming a status nobody stated, so such a
  // choice is only open to an answer that names the status itself.
  const namesStatus = candidates.some((candidate) => US_STATUS_CLAIM.test(candidate));
  const offered = optionTexts
    .map((text, index) => ({ text, index }))
    .filter(({ text }) => namesStatus || !US_STATUS_CLAIM.test(text) || DENIES_US_STATUS.test(text));
  const picked = pickAmongOptions(
    offered.map(({ text }) => text),
    candidates,
  );
  return picked >= 0 ? (offered[picked]?.index ?? -1) : -1;
}

function pickAmongOptions(optionTexts: readonly string[], candidates: readonly string[]): number {
  for (const candidate of candidates) {
    if (isWebAddress(candidate)) {
      const spelled = optionTexts.findIndex((text) => optionSpellsAddress(text, candidate));
      if (spelled >= 0) return spelled;
      continue;
    }
    const expected = normalizeOptionText(candidate);
    const exact = optionTexts.findIndex((text) => normalizeOptionText(text) === expected);
    if (exact >= 0) return exact;
    const partial = leastQualifiedMatch(optionTexts, candidate);
    if (partial >= 0) return partial;
    const overlap = bestCoverageMatch(optionTexts, candidate);
    if (overlap >= 0) return overlap;
  }
  const band = pickNumericBandIndex(optionTexts, candidates);
  if (band >= 0) return band;
  if (optionTexts.length === 1 && isSoleOptIn(normalizeOptionText(optionTexts[0] ?? ""))) {
    if (candidates.some((candidate) => AFFIRMATIVE_CANDIDATE.test(normalizeOptionText(candidate)))) {
      return 0;
    }
    // A required choice offering exactly one consent option carries no
    // decision - there is nothing else to select, so the only alternatives are
    // consent or an unsubmittable form. Block's interview-expectations block
    // runs to 700 characters and mentions "previous employers", which pulled in
    // a stored current-employer answer of "Hooli"; that is not an
    // affirmative, but consenting is still the only available action. An
    // explicit refusal or decline is honoured rather than overridden.
    const refused = candidates.some((candidate) => {
      const normalized = normalizeOptionText(candidate);
      return NEGATIVE_CANDIDATE.test(normalized) || isDeclinePhrase(normalized);
    });
    if (!refused) return 0;
  }
  const outsideUs = outsideUsOptionIndex(optionTexts, candidates);
  if (outsideUs >= 0) return outsideUs;
  return -1;
}

/**
 * US state lists used to check a residence question against a known member, so
 * a list of American states can be told apart from any other set of choices.
 * Only enough states to be certain are listed; the check needs a quorum, not a
 * complete gazetteer.
 */
const US_STATES = [
  "alabama", "alaska", "arizona", "arkansas", "california", "colorado", "connecticut",
  "delaware", "florida", "georgia", "hawaii", "idaho", "illinois", "indiana", "iowa",
  "kansas", "kentucky", "louisiana", "maine", "maryland", "massachusetts", "michigan",
  "minnesota", "mississippi", "missouri", "montana", "nebraska", "nevada", "new york",
  "ohio", "oklahoma", "oregon", "pennsylvania", "tennessee", "texas", "utah", "vermont",
  "virginia", "washington", "wisconsin", "wyoming",
];

/** An option meaning "I do not live in a US state". */
const OUTSIDE_US_OPTION =
  /^(?:not (?:in|based in|located in|a resident of) the us(?:a)?|not in the united states|outside (?:the )?(?:us|usa|united states)|non us|international|i do not reside in the us)\b/;

/**
 * An option meaning "somewhere not listed". Garner lists every state and
 * Washington, D.C., then only "Other", so a province matched nothing and the
 * question was left unanswered. It is the escape only when no option says
 * "outside the US" outright.
 */
const UNLISTED_PLACE_OPTION = /^(?:other|none of the above)$/;

/**
 * Faire asks for a state of residence and offers "Not in the US" for everyone
 * else. The stored province is "British Columbia", which is a real answer to
 * the question asked but matches no option, so the fill stage refused a
 * complete application over the one field whose answer was already known.
 *
 * Failing to match any US state is itself the fact the question is asking
 * about, so the escape option is taken. The list has to look like US states
 * for this to mean anything, and a candidate who does live in a state matches
 * it directly long before reaching here.
 */
function outsideUsOptionIndex(optionTexts: readonly string[], candidates: readonly string[]): number {
  const normalized = optionTexts.map((text) => normalizeOptionText(text));
  const stateCount = normalized.filter((text) => US_STATES.includes(text)).length;
  if (stateCount < 10) return -1;
  const explicit = normalized.findIndex((text) => OUTSIDE_US_OPTION.test(text));
  const escape = explicit >= 0 ? explicit : normalized.findIndex((text) => UNLISTED_PLACE_OPTION.test(text));
  if (escape < 0) return -1;
  // Only a candidate that names a place may take the escape. A yes/no or a
  // decline reaching here means the answer was never about where he lives, and
  // a two-letter code may be a state's own abbreviation.
  const namesAPlace = candidates.some((candidate) => {
    const value = normalizeOptionText(candidate);
    if (value.length <= 2) return false;
    if (BOOLEAN_ANSWER.test(value) || isDeclinePhrase(value)) return false;
    return /^[a-z][a-z .'-]*$/.test(value) && value.split(" ").length <= 4;
  });
  return namesAPlace ? escape : -1;
}

/**
 * A bare "Yes" partially matches every option that opens with "Yes", so taking
 * the first one in document order is luck rather than logic. Datadog offers
 * "Yes, no restriction.", "Yes, but I will need sponsorship in the future." and
 * "No, I need sponsorship now."; a differently ordered board would have claimed
 * the candidate needs sponsorship. Prefer the least elaborated match, because a
 * stored answer of "Yes" means plain yes, not "yes, but".
 *
 * Shortness only settles it when the answer says nothing beyond its polarity.
 * "No - based in Vancouver, Canada and willing to relocate." matches both "No,
 * I'm not based in this location but willing to relocate" and the shorter "No,
 * I'm only able to work remotely", and shortness alone picked the second - a
 * claim the candidate never made and would not want made for him. An option
 * that carries more of what the answer actually says therefore wins first, and
 * shortness breaks the remaining ties.
 */
function leastQualifiedMatch(optionTexts: readonly string[], candidate: string): number {
  const wanted = answerContentWords(candidate);
  let best = -1;
  let bestCoverage = -1;
  let bestLength = Number.POSITIVE_INFINITY;
  for (let index = 0; index < optionTexts.length; index += 1) {
    const text = optionTexts[index] ?? "";
    if (!optionTextMatches(text, candidate)) continue;
    if (optionNegatesCandidate(text, candidate)) continue;
    if (optionPolarityConflicts(text, candidate)) continue;
    if (optionContradictsDecline(text, candidate)) continue;
    const normalized = normalizeOptionText(text);
    const words = new Set(normalized.split(" "));
    const coverage = wanted.filter((word) => words.has(word)).length;
    const length = normalized.length;
    if (coverage > bestCoverage || (coverage === bestCoverage && length < bestLength)) {
      best = index;
      bestCoverage = coverage;
      bestLength = length;
    }
  }
  return best;
}

/**
 * The words an answer contributes beyond its polarity. Short words and the
 * connective vocabulary every option shares carry no signal about which option
 * was meant, so counting them would make every option look equally close.
 */
const OPTION_STOPWORDS = new Set([
  "yes",
  "true",
  "not",
  "false",
  "and",
  "the",
  "for",
  "are",
  "you",
  "this",
  "that",
  "with",
  "will",
  "have",
  "been",
  "from",
  "your",
  "our",
  "was",
  "but",
  "can",
  "does",
  "did",
  "currently",
  "other",
]);

function answerContentWords(candidate: string): string[] {
  return normalizeOptionText(candidate)
    .split(" ")
    .filter((word) => word.length > 3 && !OPTION_STOPWORDS.has(word));
}

/**
 * Containment cannot match a stored answer written as a sentence against an
 * option written as a different sentence. "No - based in Vancouver, Canada and
 * willing to relocate." is neither a substring of "No, I'm not based in this
 * location but willing to relocate" nor the reverse, so the option list matched
 * nothing and a required question was left blank with its answer in hand.
 *
 * Overlap is only consulted after exact and containment matching have failed,
 * needs at least two shared content words so a single incidental word cannot
 * decide, and still obeys polarity - an option opening with the opposite
 * polarity is never eligible however much vocabulary it shares.
 */
const MIN_OVERLAP_WORDS = 2;

/**
 * Overlap counts vocabulary without reading grammar, so "I am a veteran" and "I
 * am not a protected veteran" look similar to it. An option that disagrees with
 * the answer about negation states the opposite of what the candidate said and
 * is never an acceptable substitute for it. "Unable", "cannot" and "unwilling"
 * negate as surely as "not" does: "Yes - happy to commute to the downtown
 * office" shares three content words with "I am unable to commute to the
 * downtown office" and says the reverse.
 */
const NEGATION = /\b(not|never|no|none|neither|decline|cannot|unable|unwilling)\b/;

function negationDiffers(optionText: string, candidate: string): boolean {
  return NEGATION.test(normalizeOptionText(optionText)) !== NEGATION.test(normalizeOptionText(candidate));
}

function bestCoverageMatch(optionTexts: readonly string[], candidate: string): number {
  const wanted = answerContentWords(candidate);
  if (wanted.length < MIN_OVERLAP_WORDS) return -1;
  let best = -1;
  let bestCoverage = MIN_OVERLAP_WORDS - 1;
  let bestLength = Number.POSITIVE_INFINITY;
  for (let index = 0; index < optionTexts.length; index += 1) {
    const text = optionTexts[index] ?? "";
    if (optionNegatesCandidate(text, candidate)) continue;
    if (negationDiffers(text, candidate)) continue;
    if (optionPolarityConflicts(text, candidate)) continue;
    if (optionContradictsDecline(text, candidate)) continue;
    const normalized = normalizeOptionText(text);
    const words = new Set(normalized.split(" "));
    const coverage = wanted.filter((word) => words.has(word)).length;
    // The tie rule below would otherwise accept an option sharing a single
    // word: "Company Careers Page" chose "Company Recruiter" on "company".
    if (coverage < MIN_OVERLAP_WORDS) continue;
    if (coverage > bestCoverage || (coverage === bestCoverage && normalized.length < bestLength)) {
      best = index;
      bestCoverage = coverage;
      bestLength = normalized.length;
    }
  }
  return best;
}

const SOLE_OPT_IN_OPTION =
  /^(?:i )?(?:acknowledged?|agreed?|accepts?|accepted|consented?|certif(?:y|ied)|confirmed?|understands?|understood)\b/;
/**
 * The same formality written as a first-person sentence that puts the verb
 * after a preamble: Vercel's sole option reads "I have reviewed and confirmed
 * that all the information provided is accurate and complete". Without this the
 * drafter resolves the field and the fill stage then refuses it, aborting a
 * fully prepared application over a box with only one possible value.
 */
const OPT_IN_ATTESTATION =
  /^i\b.{0,40}\b(?:acknowledged?|agreed?|accepted|consented?|certified|confirmed?|understood)\b/;
export const AFFIRMATIVE_CANDIDATE = /^(?:yes|true|agreed?|i agree|acknowledged?|i acknowledge|accept|i accept|consent|i consent)\b/;

/** Whether a lone option is pure agreement, in either of the two wordings. */
function isSoleOptIn(normalizedOption: string): boolean {
  return SOLE_OPT_IN_OPTION.test(normalizedOption) || OPT_IN_ATTESTATION.test(normalizedOption);
}
export const NEGATIVE_CANDIDATE = /^(?:no|false|i do not|i don t|not |never|disagree|i disagree|decline|i decline)\b/;

export function normalizeOptionText(input: string): string {
  return expandContractions(input.toLowerCase()).replace(/[^a-z0-9]+/g, " ").trim();
}

/**
 * A web address names exactly one site. Normalized, "adobe.com" reads "adobe
 * com", which partial matching finds inside "Adobe Community Forum", so an
 * address only ever matches an option that spells the same address out.
 */
const WEB_ADDRESS = /^[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:com|org|net|io|ai|co|dev|app|tech|jobs)$/i;

function isWebAddress(candidate: string): boolean {
  return WEB_ADDRESS.test(candidate.trim());
}

function optionSpellsAddress(optionText: string, address: string): boolean {
  const escaped = address.trim().toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[^a-z0-9.])(?:www\\.)?${escaped}(?:$|[^a-z0-9])`).test(optionText.toLowerCase());
}

/**
 * Boards write the same decline both ways - "I don't wish to answer" and "I do
 * not wish to answer". Stripping punctuation alone leaves "don t" and "do not",
 * which never compare equal, so expand contractions before normalizing.
 */
function expandContractions(input: string): string {
  return input
    .replace(/\bcan['\u2019]t\b/g, "cannot")
    .replace(/\bwon['\u2019]t\b/g, "will not")
    .replace(/\bshan['\u2019]t\b/g, "shall not")
    .replace(/n['\u2019]t\b/g, " not");
}
