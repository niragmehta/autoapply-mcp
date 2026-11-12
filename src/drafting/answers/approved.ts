import type { DraftAnswer } from "../../domain/job.js";
import type { Profile } from "../../domain/profile.js";
import { looksLikeEssay, withoutAsides } from "../blockedQuestions.js";
import { selectBestOption } from "../options.js";
import {
  CURRENT_RESIDENCE_QUESTION as SHARED_RESIDENCE_QUESTION,
  WORK_AUTHORITY_TEXT as SHARED_WORK_AUTHORITY_TEXT,
  namesCandidateLocation,
} from "../residence.js";
import {
  canonicalizeWorkPermission,
  sponsorshipIntentMismatch,
  workPermissionScopeMismatch,
} from "../../text/workPermission.js";
import {
  aboutRelocation,
  acceptsRelocationInstead,
  decidesRelocation,
  relocationAssistanceMismatch,
  relocationOption,
  writtenForChoiceList,
} from "../../text/questionIntent.js";
import { countsYearsAsLookback, statesUnrelatedExperience } from "../experienceSubject.js";
import { ratingSubjectMismatch } from "../ratingSubject.js";
import { DECLINE_ANSWER_PATTERN } from "../../submission/form/answerVocabulary.js";
import { isDeclinePhrase } from "../../submission/form/optionMatching.js";
import type { FormQuestion } from "./formQuestion.js";

/**
 * Finds the pre-approved answer whose pattern matches most specifically.
 *
 * Longest match wins rather than array order, because sponsorship questions
 * overlap: a generic "do you require sponsorship" answer must not pre-empt the
 * answer written for "...require sponsorship (e.g. H-1B, E-3, TN, O-1...)",
 * which names a route the candidate would in fact use.
 */
export function matchApprovedAnswer(profile: Profile, label: string, offered?: Pick<FormQuestion, "type" | "options">) {
  const haystack = canonicalizeWorkPermission(label.toLowerCase());
  const residenceAsked = CURRENT_RESIDENCE_QUESTION.test(haystack) && !WORK_AUTHORITY_TEXT.test(haystack);
  const asksAboutHome = residenceAsked && namesCandidateLocation(haystack, profile);
  // Watershed's "Are you located in, or willing to relocate to the SF area?" is
  // satisfied by either condition. On a bare Yes/No control the stored "No -
  // based in Vancouver, Canada and willing to relocate." keeps only its "No",
  // so the relocation decision answers instead. Free text keeps the qualified
  // denial, and a richer option list is left to the option matcher, because
  // "Yes" there may be the option claiming he already lives there.
  const relocationAnswers = residenceAsked && offersOnlyYesNo(offered) && acceptsRelocationInstead(haystack);
  const freeText = offered !== undefined && isFreeTextQuestion(offered);
  let best: { entry: Profile["answers"][number]; length: number } | null = null;
  for (const entry of profile.answers) {
    if (relocationAnswers) {
      // Only the residence denial is set aside here; a stored "No" to
      // relocating to the place named is the answer to this very question.
      if (deniesResidence(entry) && !aboutRelocation(entry)) continue;
      if (!statesWhereCandidateLives(entry) && !aboutRelocation(entry)) continue;
    } else if (residenceAsked && !statesWhereCandidateLives(entry)) continue;
    if (freeText && writtenForChoiceList(entry)) continue;
    if (relocationAssistanceMismatch(label, [entry.key, entry.label, ...entry.patterns])) continue;
    // A question naming a subject may only be answered by an entry naming the
    // same subject; see experienceSubject.ts.
    if (statesUnrelatedExperience(haystack, [entry.label, ...entry.patterns])) continue;
    if (countsYearsAsLookback(haystack, [entry.label, ...entry.patterns])) continue;
    if (ratingSubjectMismatch(haystack, [entry.label, ...entry.patterns])) continue;
    if (workPermissionScopeMismatch(haystack, [entry.label, ...entry.patterns])) continue;
    if (sponsorshipIntentMismatch(label, [entry.key, entry.label, ...entry.patterns])) continue;
    // "Are you located in <somewhere he is not>" is stored once, as a blanket
    // "No - based in Vancouver, Canada". That is true of everywhere except the
    // one place he actually lives, so when the question names Canada, British
    // Columbia or Vancouver the stored answer states the opposite of the truth.
    // Tailscale asked exactly that. A denial cannot answer a question about his
    // own location; resolvePersonal supplies the affirmative instead.
    if (asksAboutHome && deniesResidence(entry)) continue;
    for (const pattern of entry.patterns) {
      const needle = canonicalizeWorkPermission(pattern.toLowerCase());
      if (!haystack.includes(needle)) continue;
      if (!best || needle.length > best.length) best = { entry, length: needle.length };
    }
  }
  // Brex words the alternative "or plan to relocate to", which no stored pattern
  // covers; the question itself names relocation, so the standing decision applies.
  if (!best && relocationAnswers) return profile.answers.find((entry) => decidesRelocation(entry) && canAutoFill(entry));
  return best?.entry;
}

/** True when the answer opens by denying it, however it then qualifies itself. */
function deniesResidence(entry: Profile["answers"][number]): boolean {
  return /^\s*no\b/i.test(entry.answer.trim());
}

function offersOnlyYesNo(offered: Pick<FormQuestion, "options"> | undefined): boolean {
  const options = offered?.options ?? [];
  return options.length === 2 && options.every((option) => /^(?:yes|no)$/i.test(option.trim()));
}

function isFreeTextQuestion(offered: Pick<FormQuestion, "type" | "options">): boolean {
  return (offered.type === "input_text" || offered.type === "textarea") && !(offered.options?.length);
}

/**
 * Brex asks "Do you currently live in, or plan to relocate to, the specified
 * location?" and offers "Yes, I live here", "Yes, I plan to relocate" and "No".
 * Ridgeline asks whether he is "located in either area or open to relocation"
 * and offers "Yes, I am located in/near the Reno, NV area.", the same for San
 * Ramon, "I am open to relocation." and "I am not open to relocation.". Each
 * stored answer speaks to one half of such a question: the residence denial
 * took Brex's "No", telling the employer he would not relocate, and the bare
 * "Yes" of the based-or-relocating answer took Ridgeline's first option,
 * claiming he lives near Reno. Both were submitted.
 *
 * He lives in neither place and has decided to relocate, so the answer is the
 * option that commits to relocating without claiming residence, and a person
 * chooses when no single option does. A bare Yes/No list stays with
 * matchApprovedAnswer, as does a question naming where he lives.
 */
export function relocationChoice(
  question: FormQuestion,
  profile: Profile,
  category: string,
): Omit<DraftAnswer, "required"> | undefined {
  const options = question.options ?? [];
  if (options.length === 0 || offersOnlyYesNo(question) || isFreeTextQuestion(question)) return undefined;
  const haystack = canonicalizeWorkPermission(question.label.toLowerCase());
  if (!CURRENT_RESIDENCE_QUESTION.test(haystack) || WORK_AUTHORITY_TEXT.test(haystack)) return undefined;
  if (!acceptsRelocationInstead(haystack) || namesCandidateLocation(haystack, profile)) return undefined;
  const decision = profile.answers.find((entry) => decidesRelocation(entry) && canAutoFill(entry));
  const option = decision ? relocationOption(options) : undefined;
  if (!decision || !option) {
    return blocked(
      question,
      category,
      decision
        ? "residence-or-relocation question: no single option commits to relocating without claiming residence"
        : "residence-or-relocation question: no relocation decision on file",
      `Options: ${options.join(" | ")}`,
    );
  }
  return {
    questionKey: question.key,
    label: question.label,
    answer: option,
    source: "approved-answer",
    citation: `profile.answers.${decision.key}`,
    requiresHuman: false,
    category,
    guidance: "",
  };
}

/**
 * Boards ask where the candidate is *now* as a compound: "Are you currently
 * located in the San Francisco Bay Area and able to work from our Santa Clara
 * HQ up to 1-2 days weekly?". Only the second clause matched a stored
 * willingness-to-commute "Yes", so Netskope was told the candidate already
 * lives in the Bay Area. He lives in Vancouver. Willingness is a statement
 * about the future and can never answer a question of present fact, so a
 * residence question may only be filled by an answer that is itself about
 * where the candidate lives; anything else leaves it for a person to decide.
 *
 * The equivalent guard in the form-filling layer cannot catch this, because by
 * then the answer carries the question's own label and so looks like a
 * residence answer to any test applied to it.
 */
const CURRENT_RESIDENCE_QUESTION = SHARED_RESIDENCE_QUESTION;
/** Work authorization is phrased as location but asks about legal status. */
const WORK_AUTHORITY_TEXT = SHARED_WORK_AUTHORITY_TEXT;
const RESIDENCE_ANSWER = /\b(based|located|reside|residing|lives?|living)\b/;

/** Judged from the entry's own wording, never from the question it matched. */
function statesWhereCandidateLives(entry: Profile["answers"][number]): boolean {
  return RESIDENCE_ANSWER.test(entry.label.toLowerCase()) || RESIDENCE_ANSWER.test(entry.answer.toLowerCase());
}

/**
 * An answer may be auto-filled when it is authorized and non-empty, or when it
 * is explicitly marked to be skipped. A blank entry that is neither records
 * that a question is known and still needs a decision.
 */
export function canAutoFill(entry: { answer: string; allowAutoFill: boolean; skip?: boolean }): boolean {
  if (entry.skip === true) return true;
  return entry.allowAutoFill && entry.answer.trim().length > 0;
}

/** A sentence in the label that is itself a yes/no question. */
const YES_NO_QUESTION = /(?:^|[.!?:;\u2014]\s*)(?:do|does|did|are|is|was|were|have|has|had|will|would|can|could|should)\s[^?]*\?/i;

/**
 * Asks which place the candidate is in rather than whether he is in one.
 * Nanit's free-text "What city and state are you currently based in?" matched
 * the stored "No - based in Vancouver, Canada and willing to relocate." on its
 * wording, and a free-text box offers no list that could have refused it, so
 * the employer was told his city and state were "No - ...".
 */
const ASKS_WHICH_PLACE =
  /\b(?:what|which)\b[^?]*\b(?:city|town|state|province|region|country|location|metro(?:politan)? area)\b|\bwhere\s+(?:are|do|is)\s+you\b/i;

/** A stored answer that opens with yes or no cannot name a place. */
export function polarAnswerToWhichPlace(label: string, answer: string): boolean {
  const asked = withoutAsides(label);
  return /^\s*(?:yes|no)\b/i.test(answer) && ASKS_WHICH_PLACE.test(asked) && !YES_NO_QUESTION.test(asked);
}

/** A choice that lets the candidate decline to self-identify. */
export const OFFERS_DECLINE =
  /\b(?:decline|prefer not|rather not|not (?:wish|want) to|don'?t (?:wish|want) to|choose not to|not to (?:say|answer|disclose|self[- ]?identify))/i;

/**
 * A free-text prompt asking for prose cannot be answered "Yes" or "No".
 * Accordion's "Describe a specific AI-assisted workflow you've built or refined
 * in the last 6 months - what it does, what you tried that didn't work..."
 * matched a stored "No" written for "Have you applied in the last 6 months?" on
 * its trailing clause, and the whole essay went out as that one word. A text
 * box that does pose a yes/no question - "Do you have a non-compete? If so,
 * please describe." - still takes the stored answer.
 */
export function yesNoForEssay(question: FormQuestion, answer: string): boolean {
  return (
    looksLikeEssay(question.label, question.type) &&
    /^(?:yes|no)[.!]?$/i.test(answer.trim()) &&
    !YES_NO_QUESTION.test(withoutAsides(question.label))
  );
}

/** Choice wording that claims US citizenship, or US permanent residency, outright. */
const US_CITIZENSHIP_CLAIM = /\b(?:u\.?\s?s\.?\s+citizen|citizen of the (?:united states|u\.?\s?s\.?)|american citizen)/i;
const US_PERMANENT_RESIDENCY_CLAIM = /\b(?:green\s?card|(?:lawful\s+)?permanent\s+resident)/i;
/** A choice that denies the status, such as "No, I am not a US citizen", claims nothing. */
const DENIES_US_STATUS = /\b(?:not|neither|nor)\s+(?:a\s+|an\s+)?(?:u\.?\s?s\.?\s+)?(?:citizen|permanent resident|green\s?card)/i;
const US_COUNTRY = /^(?:us|usa|u\.s\.(?:a\.)?|united states(?: of america)?)$/i;

/**
 * The offered choices the candidate may select given the status the profile
 * records. SeatGeek lists "Yes, I have US work authorization as a US Citizen or
 * US Permanent Resident/Green Card Holder" ahead of "Yes, ... via a
 * non-immigrant visa (... TN ...)", and a stored "Yes" took the first - telling
 * the employer a Canadian citizen holds US citizenship. Citizenship is read
 * from the recorded citizenships; permanent residency implies authorization to
 * work in the US, so a profile not authorized there never claims it.
 */
function claimableOptions(options: readonly string[], profile: Profile): string[] {
  const { citizenships, authorizedIn } = profile.workAuthorization;
  const usCitizen = citizenships.some((country) => US_COUNTRY.test(country.trim()));
  const usAuthorized = usCitizen || authorizedIn.some((country) => US_COUNTRY.test(country.trim()));
  return options.filter((option) => {
    if (DENIES_US_STATUS.test(option)) return true;
    if (!usCitizen && US_CITIZENSHIP_CLAIM.test(option)) return false;
    return usAuthorized || !US_PERMANENT_RESIDENCY_CLAIM.test(option);
  });
}

/**
 * Resolves a stored answer against the choices a question actually offers.
 * Falls back to the plain answer when the question is free text.
 */
export function resolveApprovedValue(
  entry: { answer: string; alternatives: string[] },
  question: FormQuestion,
  profile?: Profile,
): { value: string; unmatchedChoice: boolean } {
  const hadOptions = (question.options?.length ?? 0) > 0;
  // Declaring no alternatives used to skip option matching entirely, so a
  // stored value was handed to a closed dropdown that might not list it - the
  // form would reject it, or worse, the fill would land on a near neighbour.
  // Whether the answer needs matching is a property of the question, not of how
  // many fallbacks happen to be stored.
  if (!hadOptions) {
    return { value: entry.answer, unmatchedChoice: false };
  }
  const preferences = [entry.answer, ...entry.alternatives].filter((value) => value.trim().length > 0);
  const options = profile ? claimableOptions(question.options ?? [], profile) : question.options;
  const match = selectBestOption(preferences, options);
  if (!match.matchedOption) {
    const decline = offeredDecline(entry.answer, options ?? []);
    if (decline) return { value: decline, unmatchedChoice: false };
  }
  return { value: match.value, unmatchedChoice: !match.matchedOption };
}

/**
 * A stored refusal to disclose is carried by any offered refusal, however it is
 * worded. Sand's required Gender list offered "Prefer not to answer", which
 * none of the stored decline wordings spells exactly, so a settled answer went
 * to a person. The fill step already searches this way; drafting now agrees
 * with it. Only an option that itself declines may be taken.
 */
function offeredDecline(answer: string, options: readonly string[]): string | undefined {
  if (!DECLINE_ANSWER_PATTERN.test(answer.trim())) return undefined;
  return options.find((option) => isDeclinePhrase(option));
}

export function blocked(
  question: FormQuestion,
  category: string,
  reason: string,
  guidance = "",
): Omit<DraftAnswer, "required"> {
  return {
    questionKey: question.key,
    label: question.label,
    answer: "",
    source: "blocked",
    citation: reason,
    requiresHuman: true,
    category,
    guidance,
  };
}
