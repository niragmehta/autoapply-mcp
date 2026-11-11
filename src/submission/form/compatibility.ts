import type { DraftAnswer } from "../../domain/job.js";
import { numberInputValue, valueShapeMismatch } from "../../drafting/valueShape.js";
import { sponsorshipIntentMismatch, tnSponsorshipMismatch } from "../../text/workPermission.js";
import { asksAbilityToMeetRequirement } from "../../text/requirementQuestion.js";
import { opensAsYesNo } from "../../text/yesNoQuestion.js";
import {
  aboutRelocation,
  acceptsRelocationInstead,
  relocationOption,
  residenceOnlyInCondition,
} from "../../text/questionIntent.js";
import { sourceAnswerMismatch } from "../sourceQuestion.js";
import { datePickerParts } from "../workdayDates.js";
import { BOOLEAN_ANSWER, DECLINE_ANSWER_PATTERN } from "./answerVocabulary.js";
import { normalizeLabel, offersOptions, signatureDateField, type FieldDescriptor } from "./fieldModel.js";
import { optionPolarityConflicts } from "./optionMatching.js";
import { AGE_QUESTION, BARE_NAME_FIELD, PARTIAL_NAME_ANSWER, withoutReasoningBased } from "./similarity.js";

const WHOLE_NAME_ANSWER = /^(?:your |applicant |candidate )?(?:full |legal )?name$/;
/** A field holding one part of a name, including the honorifics either side of it. */
const NAME_PART_FIELD = /\b(?:first|middle|last|given|family|sur)\s?name\b|^(?:name )?(?:prefix|suffix|salutation|honorific)$/;
const HONORIFIC_FIELD = /^(?:name )?(?:prefix|suffix|salutation|honorific)$/;
const HONORIFIC_VALUE = /^(?:mr|mrs|ms|miss|mx|dr|prof|sir|dame|rev|jr|sr|ii|iii|iv|v|esq|phd|md)\.?$/i;

const CONTACT_VALUE = /^[^\s@]+@[^\s@]+\.[a-z]{2,}$|^\+?[\d\s().-]{7,}$|^https?:\/\//i;
const ASKS_FOR_CONTACT =
  /\b(?:e-?mail|phone|number|url|link|linkedin|website|profile|address|github|gitlab|portfolio|page|site|handle|account)\b/i;
/**
 * Answers drawn from stored facts about the candidate rather than from a
 * decision. The bank's own "legal-name" entry counts: once the derived name was
 * refused, Breeze Airways' "Do the first and last names ... match your legal
 * name ...?" took it through the pattern "legal name".
 */
const STORED_FACT_ANSWER =
  /^(?:personal\.|identity\.|education\[|experience\[|location$|current[_-]location$|(?:derived-)?(?:legal|full)[-_]name$|first_name$|last_name$)/;
const POLAR_VALUE = /^\s*(?:yes|no|true|false)\b/i;

/**
 * A yes/no question that only mentions a contact detail is not asking for it.
 * Disney's consent question explains that "yes" means mail "to the email address
 * associated with your job applicant profile", and the stored address bound to
 * it as the answer. Only a question whose own first sentence asks for the
 * detail - "Can you share the best email address to reach you?" - may take it.
 */
function yesNoQuestionTakesContact(label: string, value: string): boolean {
  const question = label.split("?")[0] ?? label;
  return opensAsYesNo(label) && CONTACT_VALUE.test(value.trim()) && !ASKS_FOR_CONTACT.test(question);
}

/**
 * A stored answer filed under a bare field name - at most three words and no
 * question - whose value is neither a yes/no nor a refusal: "School: Example
 * State University", "Spoken languages: English". It records a fact, not a
 * decision about a yes/no question.
 */
function namesAFieldNotADecision(answer: DraftAnswer): boolean {
  const label = answer.label.trim();
  if (label.includes("?") || normalizeLabel(label).split(" ").filter(Boolean).length > 3) return false;
  const value = answer.answer.trim();
  return value.length > 0 && !POLAR_VALUE.test(value) && !BOOLEAN_ANSWER.test(value) && !DECLINE_ANSWER_PATTERN.test(value);
}
/**
 * Workday puts the phone number and its "Phone Device Type" side by side. Both
 * labels carry the word "phone", so the stored number won the type question and
 * the filler went looking for "+1 604..." in a Home/Home Cellular menu. Asking
 * which *kind* of contact detail this is is a different question from asking for
 * the detail, so only an answer that is itself about the kind may fill one.
 */
/**
 * The mirror of the residence guard. "Are you legally authorized to work in the
 * country where this position is located?" shares the word "country" with the
 * stored country answer, which outscored the work-authorization answer and put
 * "Canada" forward as the reply. On NVIDIA's Yes/No menu nothing matched and
 * the step simply failed; on a menu that happened to list countries it would
 * have answered a legal question with a place name. Only an answer that is
 * itself about authorization may fill one of these.
 */
const LOCATION_ANSWER_LABEL = /\b(country|location|city|province|state|address|region)\b/;

function workAuthorityTakesLocation(fieldLabel: string, answerLabel: string): boolean {
  return (
    WORK_AUTHORITY_TEXT.test(fieldLabel) &&
    LOCATION_ANSWER_LABEL.test(answerLabel) &&
    !WORK_AUTHORITY_TEXT.test(answerLabel)
  );
}

const CONTACT_KIND_QUESTION =
  /\b(device type|phone type|number type|contact type|email type|address type|type of (?:phone|number|contact))\b/;
const CONTACT_KIND_ANSWER = /\b(type|kind|mobile|cell|cellular|landline|home|work)\b/;

/**
 * A phone extension is a few digits dialled after the number, not the number.
 * Workday puts the two fields side by side, "extension" contains "phone" often
 * enough to match, and the review page then reads
 * "+1 (604) 5550142 x604-555-0142" - a number no employer can call.
 */
const PHONE_EXTENSION_QUESTION = /\b(extension|ext\.?)\b/;

function phoneExtensionTakesNumber(fieldLabel: string, answerLabel: string): boolean {
  return PHONE_EXTENSION_QUESTION.test(fieldLabel) && !PHONE_EXTENSION_QUESTION.test(answerLabel);
}

/**
 * A dialling code is chosen from a list of countries, not typed as a number.
 * Adobe's "Country Phone Code" matched the stored number on the word "phone";
 * hunting for "604-555-0142" among the countries replaced the correct
 * "Canada (+1)" with "Anguilla (+1)". The whole label has to be a code
 * question: "Phone number (including country code)" still wants the number.
 */
const PHONE_CODE_FIELD =
  /^(?:(?:country(?: region)?|international) )?(?:(?:phone|mobile|telephone) )?(?:(?:country|dialing|dialling|calling) )?code$/;
export const PHONE_COUNTRY_CODE_KEY = "derived-phone-country-code";

export function isPhoneCodeField(label: string): boolean {
  return label !== "code" && PHONE_CODE_FIELD.test(label);
}

/** Only the country the number is dialled in may answer a phone-code question. */
function phoneCodeMismatch(fieldLabel: string, answer: DraftAnswer, answerLabel: string): boolean {
  if (answer.questionKey === PHONE_COUNTRY_CODE_KEY) return !isPhoneCodeField(fieldLabel);
  return isPhoneCodeField(fieldLabel) && !isPhoneCodeField(answerLabel);
}

/** Rejects an answer that is a contact value where the field wants its kind. */
function contactKindMismatch(fieldLabel: string, answerLabel: string): boolean {
  return CONTACT_KIND_QUESTION.test(fieldLabel) && !CONTACT_KIND_ANSWER.test(answerLabel);
}

const RESIDENCE_QUESTION = /\b(located|located in|reside|residing|live|living|based)\b/;
/**
 * A question about where the candidate is *right now* is a claim of fact, not a
 * statement of willingness. Boards routinely ask it as a compound - "are you
 * currently based in the listed location and able to work in person 3 days per
 * week?" - and the second clause matched a willing-to-commute answer of "Yes",
 * which answered the residence half with the opposite of the truth. Only an
 * answer that is itself about where the candidate lives may fill one of these.
 */
const CURRENT_RESIDENCE_QUESTION =
  /\b(currently based|currently located|currently live|currently reside|currently residing|are you based|are you located|do you live|do you reside)\b/;
// Willingness to relocate is deliberately absent: "Open to relocation" is a
// statement about the future and says nothing about where the candidate is now.
const RESIDENCE_ANSWER = /\b(based|located|reside|residing|lives?|living)\b/;

/**
 * Snap asks "Do you currently live in or are you able to relocate to the
 * location this job is advertised in?", which either condition satisfies. On a
 * choice control the residence denial keeps only its "No", which also denies
 * relocating, so there the relocation decision answers instead. Takes a
 * normalized label.
 */
export function asksResidenceOrRelocation(fieldLabel: string): boolean {
  return (
    CURRENT_RESIDENCE_QUESTION.test(fieldLabel) &&
    !WORK_AUTHORITY_TEXT.test(fieldLabel) &&
    acceptsRelocationInstead(fieldLabel)
  );
}

/**
 * An answer that opens by denying residence and does not itself commit to
 * relocating: "No - based in Vancouver, Canada and willing to relocate." states
 * the relocation only after the "No" a choice control keeps. "No, but I am
 * willing to relocate" is the relocation decision and passes, as does a bare
 * "No", which may be a decision not to relocate.
 */
export function deniesResidenceOnly(value: string): boolean {
  return /^\s*no\b/i.test(value) && RESIDENCE_ANSWER.test(normalizeLabel(value)) && !relocationOption([value]);
}
// The synonyms canonicalizeWorkPermission folds together, plus the British
// "authorised": SCAN's "legally permitted to work in the country where this job
// is located" slipped past the location guard and took "Current Location".
const WORK_AUTHORITY_TEXT =
  /\b(authori[sz]|sponsor|visa|work permit|(?:eligible|entitled|permitted) to work|right to work|legally (?:(?:able|allowed|permitted) to )?work|able to work in the country)/;
const SELF_ID_QUESTION = /\b(disabilit|chronic condition|gender identity|racial|race ethnicity|ethnic background|veteran|protected veteran|sexual orientation|transgender|pronoun)/;
const SELF_ID_ANSWER = /\b(disabilit|chronic condition|gender|racial|race|ethnic|hispanic|latino|veteran|military|sexual orientation|transgender|pronoun|self identif|decline|prefer not)/;
const EXPERIENCE_ANSWER = /\byears of (?:relevant |professional |industry |software |engineering )?experience\b/;
const PERMISSION_QUESTION = /^(?:may|can|do) we\b|\bhave (?:our|your) permission\b|\bmay we contact\b/;
/**
 * Whether the candidate is bound by an agreement that restricts the work, which
 * is asked as a yes/no question however long it runs. T. Rowe Price asks "Do
 * you have a non-compete contract ... with a prior or current employer that
 * would ... restrict your ability to work for T. Rowe Price?", and the stored
 * current-company answer won on "current employer", the longest phrase that
 * matched, so the employer's name was offered to a Yes/No prompt.
 */
export const RESTRICTIVE_AGREEMENT_QUESTION =
  /\b(?:non[\s-]?compete|noncompetition|non[\s-]?solicit\w*|nonsolicitation|restrictive covenant|post[\s-]?employment restriction)/;
const SPECIFIC_LINK_SERVICES = ["linkedin", "github", "twitter", "dribbble", "behance"] as const;
const GENERIC_LINK_FIELDS = ["portfolio", "website", "blog", "personal site"] as const;

/**
 * Link fields sit together and differ by one word, so "LinkedIn Profile" scored
 * highly against "Portfolio URL" and "Other website" on the shared token "url"
 * and put a LinkedIn address into both. Naming a specific account is a claim
 * about which account it is, so an answer naming one service may not fill a
 * field asking for a different service or for a general personal site. A
 * generic answer such as "Website" is not a claim about any one account and is
 * left free to fill a portfolio field.
 */
function namesDifferentLinkService(fieldLabel: string, answerLabel: string): boolean {
  // "LinkedIn" normalizes to "linked in", so compare de-spaced forms or the
  // guard never sees the service name it exists to protect.
  const field = fieldLabel.replace(/\s+/g, "");
  const answer = answerLabel.replace(/\s+/g, "");
  const answerService = SPECIFIC_LINK_SERVICES.filter((service) => answer.includes(service));
  if (answerService.length === 0) return false;
  const fieldNames = [...SPECIFIC_LINK_SERVICES, ...GENERIC_LINK_FIELDS].filter((name) =>
    field.includes(name.replace(/\s+/g, "")),
  );
  if (fieldNames.length === 0) return false;
  return !fieldNames.some((name) => answerService.some((service) => service === name));
}
const DATE_COMPONENT_QUESTION = /\b(?:start|end|from|to)\s+date\s+(?:month|year|day)\b|^(?:start|end)\s+(?:month|year)\b/;
const DURATION_ANSWER = /\b(?:weeks?|months?|days?)\b.*\b(?:notice|offer|acceptance|start)\b|\bnotice period\b/;
/** Asks which place, in a normalized label: "which state will you reside in". */
const WHICH_PLACE_QUESTION = /\b(?:which|what)\s+(?:u\s?s\s+)?(?:state|province|country|city|town|region|territory|location)\b/;
const RESIDENCE_COUNTRY_FIELD = /^(?:(?:your|current|residence) )?country(?: (?:or )?(?:region|territory)| of(?: current)? residence)?$/;

/**
 * Which end of a period a date component belongs to, or null when the label is
 * not a date component at all.
 */
function datePeriodEnd(label: string): "start" | "end" | null {
  if (!DATE_COMPONENT_QUESTION.test(label)) return null;
  if (/\b(?:start|from)\b/.test(label)) return "start";
  if (/\b(?:end|to)\b/.test(label)) return "end";
  return null;
}

/**
 * "Start date month" and "End date month" differ by one word and sit next to
 * each other, so similarity let the start month fill the end month - which on a
 * past position states that the job began and ended in the same month. The two
 * ends of a period are never interchangeable.
 */
function namesDifferentPeriodEnd(fieldLabel: string, answerLabel: string): boolean {
  const field = datePeriodEnd(fieldLabel);
  const answer = datePeriodEnd(answerLabel);
  return field !== null && answer !== null && field !== answer;
}

const DATE_PART = /\b(?:start|end|from|to|graduation|completion)\s+(?:date\s+)?(month|year|day)\b/;

/**
 * "End date month" and "End date year" differ by one word, so similarity bound
 * a stored graduation year to the month select; no option read "2020" and the
 * required field aborted the submission. A month, a year and a day are never
 * interchangeable, whatever the rest of the label shares.
 */
function namesDifferentDatePart(fieldLabel: string, answerLabel: string): boolean {
  const field = DATE_PART.exec(fieldLabel)?.[1];
  const answer = DATE_PART.exec(answerLabel)?.[1];
  return field !== undefined && answer !== undefined && field !== answer;
}

/**
 * The number ending a label such as "Address Line 2" or "Employer 3".
 *
 * Only a trailing number counts. A number inside the text ("Top 10 skills",
 * "COVID-19") does not name a slot, and a year would be misread as one.
 */
function trailingOrdinal(normalizedLabel: string): number | null {
  const match = /\b(\d{1,2})$/.exec(normalizedLabel);
  if (!match) return null;
  return Number(match[1]);
}

/**
 * A form with one "Name" box wants the whole name. Left to plain similarity a
 * fragment such as "First Name" scores just as highly and silently submits half
 * a name, so fragments are ruled out for those fields entirely.
 *
 * A bare checkbox is a yes/no control, so an answer that is not yes/no cannot
 * express anything through it. Boards such as Ashby render these as button
 * pairs, where a non-boolean answer clicks nothing and would otherwise be
 * reported as filled while the question stays visibly blank.
 *
 * "Are you located in the United States?" and "Are you authorized to work in
 * the United States?" are nearly identical as text but opposite in fact for a
 * TN-eligible candidate living abroad, so a work-authorisation answer is never
 * allowed to stand in for a question about where someone lives. The test is
 * whether the question itself asks about authorisation: "are you authorized to
 * work in the location where this role is based" mentions location but is an
 * authorisation question, and must still receive the authorisation answer.
 *
 * Self-identification questions are held to the same rule for a blunter
 * reason. The EEOC disability wording asks about "1 or more of your major life
 * activities", and plain word overlap matched that against a stored degree
 * major, putting "Computer Science" into a disability field. Only an answer
 * that is itself about the protected characteristic may answer one.
 *
 * "At the time of application, are you 18+ years of age?" and "Do you have 6+
 * years of experience?" share only the word "years", but that was enough for
 * the experience answer to win the age question and declare an experienced
 * engineer a minor. An answer about length of experience can never answer a
 * question about age.
 *
 * "Address Line 1" and "Address Line 2" differ by a single character, so
 * similarity binds the street to both and the form repeats it. A trailing
 * ordinal names a distinct slot, so a numbered field never takes a differently
 * numbered answer.
 */
export function isIncompatible(field: FieldDescriptor, answer: DraftAnswer): boolean {
  const fieldLabel = normalizeLabel(field.label);
  const answerLabel = normalizeLabel(answer.label);
  // A signature is dated today by definition, so a signature date takes only
  // that answer. Tealium's disability form put a desired start date - six weeks
  // out - in its signature Date on the word "date", and the step would not save.
  if (signatureDateField(field) && !answer.questionKey.startsWith("signature-date")) return true;
  if (answer.questionKey === "derived-country" && !RESIDENCE_COUNTRY_FIELD.test(fieldLabel)) return true;
  if (phoneCodeMismatch(fieldLabel, answer, answerLabel)) return true;
  // An option named "website" is not evidence that a personal URL was the job source.
  if (sourceAnswerMismatch(fieldLabel, answerLabel)) return true;
  // "Address Line 1" and "Address Line 2" differ by a single character, so the
  // similarity score binds the street to both and the form repeats it. A
  // trailing ordinal names a distinct slot: line 2 holds the unit line 1 does
  // not, and employer 2 is a different employer. Only an equal ordinal may
  // match, so a numbered field never takes another number's answer.
  const fieldOrdinal = trailingOrdinal(fieldLabel);
  const answerOrdinal = trailingOrdinal(answerLabel);
  if (fieldOrdinal !== null && answerOrdinal !== null && fieldOrdinal !== answerOrdinal) {
    return true;
  }
  if (BARE_NAME_FIELD.test(fieldLabel) && PARTIAL_NAME_ANSWER.test(answerLabel)) {
    return true;
  }
  // Workday names each input in its legal-name block "legalName--<part>", so
  // the attribute shares "legal name" with the whole-name answer and put it in
  // Middle Name: Warner Bros. Discovery received "Casey Casey Moore Moore". A
  // field asking for one part of a name never takes the whole name, and nor do
  // the Prefix and Suffix dropdowns Disney's block puts either side of it.
  if (WHOLE_NAME_ANSWER.test(answerLabel) && NAME_PART_FIELD.test(fieldLabel) && !BARE_NAME_FIELD.test(fieldLabel)) {
    return true;
  }
  // A prefix or suffix holds an honorific and nothing else. Disney's Prefix and
  // Suffix sit under the heading "Legal Name", which the bank's "legal name"
  // entry matched; searching a suffix list for the whole name left "II" behind.
  // The placeholder itself is the one other answer, and it clears the field.
  if (
    HONORIFIC_FIELD.test(fieldLabel) &&
    !HONORIFIC_VALUE.test(answer.answer.trim()) &&
    !/^select one$/i.test(answer.answer.trim())
  ) {
    return true;
  }
  if (yesNoQuestionTakesContact(field.label, answer.answer)) return true;
  // A list of choices never takes a phone number, email address or URL.
  // Babylist's SMS-consent select opens "By providing your phone number...",
  // which put the stored number level with the question's own answer, and the
  // number won the tie.
  if (offersOptions(field) && CONTACT_VALUE.test(answer.answer.trim())) return true;
  // Nor is a yes/no question answered with a stored fact. Broadcom asked about
  // being "employed by any entity of the federal, state or local government",
  // and the stored province bound to it on the word "state"; Zendesk's "Are you
  // open to relocating to the location where this position is based?" took the
  // stored location on the word "location"; GEICO's "Do you have a high school
  // diploma or equivalent?" took the stored university on the word "school". A
  // fact that is itself a yes or no - "currently employed by Hooli?" - stands.
  // Intel numbers its questions, and Procore, Abbott and Breeze Airways open
  // theirs with a time phrase, a statement or a condition; see yesNoQuestion.ts.
  if (
    opensAsYesNo(field.label) &&
    STORED_FACT_ANSWER.test(answer.questionKey) &&
    !POLAR_VALUE.test(answer.answer)
  ) {
    return true;
  }
  // The answer bank keeps the same kind of fact under a bare field name -
  // "School", "Spoken languages" - and Frost Bank's "Do you have a High School
  // Diploma or equivalent?" took the stored university through the bank's
  // "school" pattern. On a list of choices such a fact can never be the option
  // picked; a free-text box that opens like a yes/no ("Do you have a preferred
  // name? If so, please share it.") may still take it.
  if (
    offersOptions(field) &&
    opensAsYesNo(field.label) &&
    namesAFieldNotADecision(answer)
  ) {
    return true;
  }
  // Sponsorship and authorization take opposite answers, so a question asking
  // whether sponsorship is required is only answered by an answer about
  // sponsorship - or by the drafted answer to that very question. The raw label
  // keeps the question mark that marks where the question ends.
  if (fieldLabel !== answerLabel && sponsorshipIntentMismatch(field.label, [answer.questionKey, answer.label])) {
    return true;
  }
  // A form that counts TN as sponsorship asks a different question from the
  // usual one and takes the opposite answer, so only an answer written for that
  // definition may answer it. Ashby packets carry just the baseline sponsorship
  // question, and its generic "No" bound to Persona's "(e.g., H-1B, ... TN)".
  if (
    fieldLabel !== answerLabel &&
    [field.label, field.questionLabel ?? ""].some((text) =>
      tnSponsorshipMismatch(text, [answer.questionKey, answer.label]))
  ) {
    return true;
  }
  // A question asking whether a requirement can be met may name disability only
  // to exempt it, as SCAN's tuberculosis screening does. It is not a
  // self-identification question, and no demographic answer can meet it.
  const requirementQuestion = asksAbilityToMeetRequirement(fieldLabel);
  if (SELF_ID_QUESTION.test(fieldLabel) && !requirementQuestion && !SELF_ID_ANSWER.test(answerLabel)) {
    return true;
  }
  if (requirementQuestion && SELF_ID_ANSWER.test(answerLabel) && !asksAbilityToMeetRequirement(answerLabel)) {
    return true;
  }
  if (AGE_QUESTION.test(fieldLabel) && EXPERIENCE_ANSWER.test(answerLabel)) {
    return true;
  }
  if (AGE_QUESTION.test(fieldLabel) && LOCATION_ANSWER_LABEL.test(answerLabel) && !AGE_QUESTION.test(answerLabel)) {
    return true;
  }
  // "May we contact your current employer?" is a yes/no permission question,
  // but it shares "current employer" with the stored employer name, so the
  // matcher tried to answer it with "Hooli". A permission question can only
  // take a yes/no answer; anything else is a category error, not a near miss.
  if (PERMISSION_QUESTION.test(fieldLabel) && !BOOLEAN_ANSWER.test(answer.answer.trim())) {
    return true;
  }
  // An answer naming a company or describing an agreement still opens with
  // its yes or no ("No, I don't have an agreement"), so only an answer that
  // opens otherwise is refused.
  if (RESTRICTIVE_AGREEMENT_QUESTION.test(fieldLabel) && !BOOLEAN_ANSWER.test(answer.answer.trim())) {
    return true;
  }
  if (namesDifferentLinkService(fieldLabel, answerLabel)) {
    return true;
  }
  // Employment-history blocks ask for "Start date month" and "End date month".
  // A notice period ("Approximately four weeks from offer acceptance") is about
  // a start date too, and won both selects on word overlap alone.
  if (DATE_COMPONENT_QUESTION.test(fieldLabel) && DURATION_ANSWER.test(answer.answer.trim())) {
    return true;
  }
  // Early Warning asked "As of your desired start date, which state will you
  // reside in permanently?", and the notice period won it on "start date": a
  // list of states was searched for "Approximately four weeks from offer
  // acceptance." A question asking which place never takes a length of time.
  if (WHICH_PLACE_QUESTION.test(fieldLabel) && DURATION_ANSWER.test(answer.answer.trim())) {
    return true;
  }
  // A date control accepts nothing but a date. Adobe's education block asks for
  // "From" and "To", which took the notice period and a bare "Yes" on word
  // overlap; the browser refused to type them, so the field stayed empty, the
  // step would not advance, and the run burned its whole step budget retrying.
  // A picker asking when the candidate can start is the exception: the notice
  // period says exactly that, and the fill turns it into a date.
  if (field.type === "date" && !(answer.notApplicable && !answer.answer.trim()) &&
      datePickerParts(answer.answer, field.domId, field.label) === null) {
    return true;
  }
  if (namesDifferentPeriodEnd(fieldLabel, answerLabel)) {
    return true;
  }
  if (namesDifferentDatePart(fieldLabel, answerLabel)) {
    return true;
  }
  if (workAuthorityTakesLocation(fieldLabel, answerLabel)) {
    return true;
  }
  if (contactKindMismatch(fieldLabel, answerLabel)) {
    return true;
  }
  if (phoneExtensionTakesNumber(fieldLabel, answerLabel)) {
    return true;
  }
  if (
    RESIDENCE_QUESTION.test(withoutReasoningBased(fieldLabel)) &&
    !WORK_AUTHORITY_TEXT.test(fieldLabel) &&
    !RESIDENCE_QUESTION.test(answerLabel) &&
    WORK_AUTHORITY_TEXT.test(answerLabel)
  ) {
    return true;
  }
  // Only choice questions: "Where are you based?" as a text field wants the
  // city itself, and the city answer is not phrased as a residence claim. A
  // question that relocating also satisfies may take the relocation decision.
  if (
    offersOptions(field) &&
    CURRENT_RESIDENCE_QUESTION.test(fieldLabel) &&
    !residenceOnlyInCondition(field.label) &&
    !WORK_AUTHORITY_TEXT.test(fieldLabel) &&
    !RESIDENCE_ANSWER.test(answerLabel) &&
    !(acceptsRelocationInstead(fieldLabel) && aboutRelocation({ key: answer.questionKey, label: answer.label }))
  ) {
    return true;
  }
  if (offersOptions(field) && asksResidenceOrRelocation(fieldLabel) && deniesResidenceOnly(answer.answer)) {
    return true;
  }
  // A radio or checkbox option is scored as its own field, so the polarity
  // guard that protects a list of options has no list to work on here. An
  // option stating the opposite of the answer can never be the right control,
  // however closely its wording matches.
  if (field.optionLabel && optionPolarityConflicts(field.optionLabel, answer.answer)) {
    return true;
  }
  if (contactFieldRejectsValue(field, answer.answer)) {
    return true;
  }
  return field.type === "checkbox" && !field.optionLabel && !BOOLEAN_ANSWER.test(answer.answer.trim());
}

/**
 * Ashby groups an SMS-consent radio pair under the same "Phone Number" legend
 * as the phone input itself, so the consent sentence and the phone number are
 * competing for a text box with identical labels. The sentence won, and Plaid
 * received "No - I do not consent to receiving text messages" where its phone
 * number should be while the real number went unused.
 *
 * A label cannot separate them, but the values are unmistakable: a phone box
 * takes digits, an email box takes an address, a year question takes a year,
 * and a one-line box cannot hold paragraphs. Judge by the shape of the value
 * rather than by wording nothing distinguishes; see valueShape.ts.
 *
 * A typed control says what it takes whatever its label says. Confluent's
 * "Mobile Phone" is a tel input whose help text asks for agreement "to receive
 * text message updates"; the consent answer matched that text, and since only
 * text boxes were judged, the tel box received the consent sentence.
 */
function contactFieldRejectsValue(field: FieldDescriptor, value: string): boolean {
  if (offersOptions(field) || field.optionLabel) return false;
  if (value.trim().length === 0) return false;
  // A phone-code question names a country. Workday's prompt is collected as its
  // bare search box, so the phone-number shape would reject "Canada" for not
  // being digits; phoneCodeMismatch already keeps the number itself out.
  if (isPhoneCodeField(normalizeLabel(field.label))) return false;
  if (field.type === "tel") return (value.match(/\d/g) ?? []).length < 7;
  if (field.type === "email") return !value.includes("@");
  if (field.type === "number") return numberInputValue(value) === null;
  if (field.type !== "text" && field.type !== "textarea") return false;
  const control = field.type === "textarea" ? "multi-line" : "single-line";
  return valueShapeMismatch(normalizeLabel(field.label), control, value) !== null;
}
