import type { DraftAnswer } from "../domain/job.js";
import { pickNumericBandIndex } from "../drafting/numericBands.js";

/**
 * Field matching for web forms, kept free of browser APIs so it can be tested
 * directly.
 */

export function normalizeLabel(label: string): string {
  return label
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/\(required\)|\*/g, " ")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export type FieldDescriptor = {
  selectorIndex: number;
  label: string;
  type: string;
  name: string;
  /**
   * The control's DOM id. Greenhouse leaves `name` empty on its repeatable
   * education and employment blocks and carries the meaning in the id instead,
   * as in `school--0` and `end-year--0`, which is the only way to tell which
   * block an "End date year" belongs to.
   */
  domId?: string;
  required: boolean;
  /**
   * What the control already holds. A step the candidate has visited before, or
   * one an employer pre-fills, arrives with values in place: NVIDIA's disability
   * form ships with Language set to English. Reporting those as unanswered
   * stalls a wizard on a question that is already answered.
   */
  value?: string;
  role?: string;
  /**
   * For radios, the text of this single option. The `label` then carries the
   * question the whole group asks, so one approved answer selects one option.
   */
  optionLabel?: string;
  /**
   * Shared by every box of one multi-select question. Ticking any one of them
   * answers the question, so the group is judged together rather than each box
   * counting as its own unmet requirement.
   */
  groupKey?: string;
  /**
   * The question a control sits under, when the control's own label is only a
   * choice. A lone acknowledgement box is labelled "I understand", so without
   * the question above it there is no way to tell what is being agreed to.
   */
  questionLabel?: string;
};

export type FieldMatch = {
  field: FieldDescriptor;
  answer: DraftAnswer | null;
  confidence: number;
};

function tokens(value: string): string[] {
  return normalizeLabel(value).split(" ").filter((token) => token.length > 2);
}

function similarity(a: string, b: string): number {
  const left = normalizeLabel(a);
  const right = normalizeLabel(b);
  if (left.length === 0 || right.length === 0) return 0;
  if (left === right) return 1;
  if (left.includes(right) || right.includes(left)) return 0.85;
  const leftTokens = new Set(tokens(left));
  const rightTokens = tokens(right);
  if (leftTokens.size === 0 || rightTokens.length === 0) return 0;
  const overlap = rightTokens.filter((token) => leftTokens.has(token)).length;
  return overlap / Math.max(leftTokens.size, rightTokens.length);
}

function semanticSimilarity(field: FieldDescriptor, answer: DraftAnswer): number {
  const fieldLabel = normalizeLabel(field.label);
  const answerLabel = normalizeLabel(answer.label);
  if (fieldLabel === "country" && answerLabel.includes("location")) return 0.7;
  // "Legal First and Last Name" asks for the whole name, but shares only the
  // word "name" with the stored "Full Name" answer, so token overlap scores it
  // ~0.2 and the required field would be left blank once name fragments are
  // ruled out. Pair whole-name questions with the whole-name answer directly.
  if (BARE_NAME_FIELD.test(fieldLabel) && /^(?:your |applicant |candidate )?(?:full |legal )?name$/.test(answerLabel)) {
    return 0.95;
  }
  if (
    fieldLabel.includes("legally") &&
    fieldLabel.includes("work") &&
    answerLabel.includes("legally") &&
    answerLabel.includes("work") &&
    (fieldLabel.includes("eligible") || fieldLabel.includes("authorized")) &&
    (answerLabel.includes("eligible") || answerLabel.includes("authorized"))
  ) {
    return 0.8;
  }
  if (
    answerLabel.includes("location") &&
    /\b(locat(?:ed|ion)|reside|residing|based)\b/.test(fieldLabel) &&
    /\b(where|current|currently|reside|residing|based)\b/.test(fieldLabel)
  ) {
    return 0.7;
  }
  // Self-identification questions are asked in long statutory prose while the
  // stored answer is a two-word label such as "Disability Status", so token
  // overlap alone never clears the confidence floor. Pair them on the
  // characteristic each one is about instead.
  const characteristic = SELF_ID_CHARACTERISTICS.find(
    (test) => test.field.test(fieldLabel) && test.answer.test(answerLabel),
  );
  if (characteristic) return 0.8;
  // An age question and a stored age answer share almost no wording ("at the
  // time of application, are you 18+ years of age" vs "are you 18 years of age
  // or older"), and the surrounding boilerplate drags token overlap under the
  // floor. Pair them explicitly so the correct answer is reachable.
  if (AGE_QUESTION.test(fieldLabel) && AGE_QUESTION.test(answerLabel)) return 0.8;
  return 0;
}

/** Pairs a self-identification question with an answer about the same characteristic. */
const SELF_ID_CHARACTERISTICS: ReadonlyArray<{ field: RegExp; answer: RegExp }> = [
  { field: /\b(disabilit\w*|chronic condition)\b/, answer: /\b(disabilit\w*|chronic condition)\b/ },
  { field: /\bgender\b|\bpronoun/, answer: /\bgender\b|\bpronoun/ },
  { field: /\b(racial|race|ethnic\w*|hispanic|latino)\b/, answer: /\b(racial|race|ethnic\w*|hispanic|latino)\b/ },
  { field: /\b(veteran|military|armed forces)\b/, answer: /\b(veteran|military|armed forces)\b/ },
  { field: /\b(sexual orientation|lgbtq)\b/, answer: /\b(sexual orientation|lgbtq)\b/ },
  { field: /\btransgender\b/, answer: /\btransgender\b/ },
];

const MIN_CONFIDENCE = 0.6;

const BARE_NAME_FIELD =
  /^(?:your |applicant |candidate )?(?:full |legal )?name$|\bfirst\s+(?:and\s+|&\s*|\/\s*)?(?:middle\s+(?:and\s+)?)?last\s+name\b/;const PARTIAL_NAME_ANSWER = /^(?:first|last|middle|preferred|nick|given|family|sur)\s?name\b/;
const BOOLEAN_ANSWER = /^(yes|no|true|false|1|0|on|off|i agree|agree|i consent|consent|i acknowledge|acknowledge|i understand|understand|understood|i confirm|confirm|i accept|accept)\b/i;

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
 * "+1 (604) 6536919 x604-653-6919" - a number no employer can call.
 */
const PHONE_EXTENSION_QUESTION = /\b(extension|ext\.?)\b/;

function phoneExtensionTakesNumber(fieldLabel: string, answerLabel: string): boolean {
  return PHONE_EXTENSION_QUESTION.test(fieldLabel) && !PHONE_EXTENSION_QUESTION.test(answerLabel);
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
const WORK_AUTHORITY_TEXT = /\b(authoriz|sponsor|visa|work permit|eligible to work)/;
const SELF_ID_QUESTION = /\b(disabilit|chronic condition|gender identity|racial|race ethnicity|ethnic background|veteran|protected veteran|sexual orientation|transgender|pronoun)/;
const SELF_ID_ANSWER = /\b(disabilit|chronic condition|gender|racial|race|ethnic|hispanic|latino|veteran|military|sexual orientation|transgender|pronoun|self identif|decline|prefer not)/;
const AGE_QUESTION = /\b(years of age|age of \d|old enough|legal working age|18 or older|18 years or older)\b/;
const EXPERIENCE_ANSWER = /\byears of (?:relevant |professional |industry |software |engineering )?experience\b/;
const PERMISSION_QUESTION = /^(?:may|can|do) we\b|\bhave (?:our|your) permission\b|\bmay we contact\b/;
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
/** A date control needs a real date: at least a month, a day and a year. */
const DATE_ANSWER = /^\D*\d{1,4}\D+\d{1,2}\D+\d{1,4}\D*$/;

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
function isIncompatible(field: FieldDescriptor, answer: DraftAnswer): boolean {
  const fieldLabel = normalizeLabel(field.label);
  const answerLabel = normalizeLabel(answer.label);
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
  if (SELF_ID_QUESTION.test(fieldLabel) && !SELF_ID_ANSWER.test(answerLabel)) {
    return true;
  }
  if (AGE_QUESTION.test(fieldLabel) && EXPERIENCE_ANSWER.test(answerLabel)) {
    return true;
  }
  // "May we contact your current employer?" is a yes/no permission question,
  // but it shares "current employer" with the stored employer name, so the
  // matcher tried to answer it with "Microsoft". A permission question can only
  // take a yes/no answer; anything else is a category error, not a near miss.
  if (PERMISSION_QUESTION.test(fieldLabel) && !BOOLEAN_ANSWER.test(answer.answer.trim())) {
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
  // A date control accepts nothing but a date. Adobe's education block asks for
  // "From" and "To", which took the notice period and a bare "Yes" on word
  // overlap; the browser refused to type them, so the field stayed empty, the
  // step would not advance, and the run burned its whole step budget retrying.
  if (field.type === "date" && !DATE_ANSWER.test(answer.answer.trim())) {
    return true;
  }
  if (namesDifferentPeriodEnd(fieldLabel, answerLabel)) {
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
    RESIDENCE_QUESTION.test(fieldLabel) &&
    !WORK_AUTHORITY_TEXT.test(fieldLabel) &&
    !RESIDENCE_QUESTION.test(answerLabel) &&
    WORK_AUTHORITY_TEXT.test(answerLabel)
  ) {
    return true;
  }
  // Only choice questions: "Where are you based?" as a text field wants the
  // city itself, and the city answer is not phrased as a residence claim.
  if (
    offersOptions(field) &&
    CURRENT_RESIDENCE_QUESTION.test(fieldLabel) &&
    !WORK_AUTHORITY_TEXT.test(fieldLabel) &&
    !RESIDENCE_ANSWER.test(answerLabel)
  ) {
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
 * takes digits, an email box takes an address, a URL box takes a link. Judge by
 * the shape of the value rather than by wording nothing distinguishes.
 */
const PHONE_FIELD = /\b(phone|mobile|cell)\b/;
const EMAIL_FIELD = /\be-?mail\b/;

function contactFieldRejectsValue(field: FieldDescriptor, value: string): boolean {
  if (offersOptions(field) || field.optionLabel) return false;
  if (field.type !== "text" && field.type !== "textarea") return false;
  const label = normalizeLabel(field.label);
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  if (PHONE_FIELD.test(label)) {
    return (trimmed.match(/\d/g) ?? []).length < 7;
  }
  if (EMAIL_FIELD.test(label)) {
    return !trimmed.includes("@");
  }
  return false;
}

/** Pairs each detected form field with the best matching drafted answer. */
export function matchFields(fields: readonly FieldDescriptor[], answers: readonly DraftAnswer[]): FieldMatch[] {
  return fields.map((field) => {
    const scored = answers
      .filter((answer) => !isIncompatible(field, answer))
      .map((answer) => ({
        answer,
        confidence: Math.max(
          similarity(field.label, answer.label),
          similarity(field.name, answer.questionKey),
          semanticSimilarity(field, answer),
        ),
      }))
      .sort((a, b) => b.confidence - a.confidence);

    const best = scored[0];
    if (!best || best.confidence < MIN_CONFIDENCE) {
      return { field, answer: null, confidence: best?.confidence ?? 0 };
    }
    return { field, answer: best.answer, confidence: best.confidence };
  });
}

/** Resolves deterministic field-specific representations from the approved answer. */
export function answerValueForField(field: FieldDescriptor, answer: DraftAnswer): string {
  const fieldLabel = normalizeLabel(field.label);
  const answerLabel = normalizeLabel(answer.label);
  if (fieldLabel === "country" && answerLabel.includes("location")) {
    return answer.answer.split(",").at(-1)?.trim() ?? answer.answer;
  }
  if (fieldLabel.includes("i agree") && /^(yes|true|1)$/i.test(answer.answer.trim())) {
    return "I agree";
  }
  if (offersOptions(field) && DECLINE_ANSWER_PATTERN.test(answer.answer.trim())) {
    return "wish to answer";
  }
  return answer.answer;
}

/**
 * "wish to answer" is a *search key* for finding a decline option in a list,
 * not a value anyone would type. Harvey's Ashby form renders Pronouns as a
 * plain text box, so returning the key unconditionally typed the literal words
 * "wish to answer" into the field and reported it filled. Only controls that
 * offer options can use a search key; a free-text box takes the answer as
 * written.
 */
const OPTION_BEARING_TYPE = /^(?:select|select-one|select-multiple|radio|checkbox)$/;
const OPTION_BEARING_ROLE = /^(?:combobox|listbox|radiogroup|menu)$/;

function offersOptions(field: FieldDescriptor): boolean {
  return (
    OPTION_BEARING_TYPE.test(field.type) ||
    field.optionLabel !== undefined ||
    (field.role !== undefined && OPTION_BEARING_ROLE.test(field.role))
  );
}

/**
 * Anchored at the start but deliberately open at the end: boards attach the
 * subject to the option itself, as in "I decline to self-identify for
 * protected veteran status". Requiring an exact match would leave those
 * fields on their default, which for a veteran question means answering it.
 */
const DECLINE_ANSWER_PATTERN =
  /^(?:i\s+)?(?:decline to (?:self[\s-]?identify|answer|state)|(?:do not|don't) wish to (?:answer|self[\s-]?identify)|prefer not to (?:answer|say|disclose))\b/i;

/**
 * Boards word the "decline to answer" option differently — Greenhouse alone
 * ships "Decline to self identify", "I don't wish to answer" and "Prefer not to
 * say" across customers. Offer every phrasing so one approved answer works
 * everywhere.
 */
const DECLINE_OPTION_CANDIDATES = [
  "wish to answer",
  "want to answer",
  "Decline to self identify",
  "Decline to self-identify",
  "Prefer not to say",
  "Prefer not to answer",
  "Decline to answer",
];

/** Ordered search strings to try when driving a typeahead combobox. */
export function optionSearchCandidates(field: FieldDescriptor, answer: DraftAnswer): string[] {
  if (DECLINE_ANSWER_PATTERN.test(answer.answer.trim())) {
    return [...DECLINE_OPTION_CANDIDATES];
  }
  const value = answerValueForField(field, answer);
  const veteran = veteranCandidates(value);
  if (veteran.length > 0) return veteran;
  const source = sourceCandidates(field, value);
  if (source.length > 0) return source;
  const degree = degreeCandidates(field, value);
  if (degree.length > 0) return degree;
  const month = monthCandidates(value);
  if (month.length > 0) return month;
  const productUsage = productUsageCandidates(field, value);
  if (productUsage.length > 0) return productUsage;
  const relocation = relocationCandidates(field, value);
  if (relocation.length > 0) return [value, ...relocation];
  const locality = value.split(",")[0]?.trim() ?? "";
  return locality.length > 1 && locality !== value ? [value, locality] : [value];
}

const SOURCE_QUESTION = /how did you (?:hear|find)|how were you referred|where did you (?:hear|learn)|referral source/;

const MONTH_NAMES = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
] as const;

/**
 * Employment-history blocks render the month as a closed list, and boards do
 * not agree on how to write it: "February", "Feb", "02" and "2" all occur. The
 * profile states a month, so offer every spelling of that same month rather
 * than leaving a required select empty. Nothing here changes which month is
 * being claimed.
 */
function monthCandidates(value: string): string[] {
  const index = MONTH_NAMES.indexOf(normalizeLabel(value) as (typeof MONTH_NAMES)[number]);
  const name = MONTH_NAMES[index];
  if (!name) return [];
  const padded = String(index + 1).padStart(2, "0");
  return [value, name.slice(0, 3), padded, String(index + 1)];
}

const DEGREE_QUESTION = /\b(degree|level of education|education level|highest (?:level of )?education)\b/;

const PRODUCT_USAGE_QUESTION = /\bhave you (?:ever )?used\b|\bare you a (?:user|customer) of\b|\bdo you use\b/;

/**
 * "Have you used our product?" is rarely a yes/no list. Tailscale offers three
 * flavours of yes and "I haven't used it, but I'm excited to learn more!", so a
 * stored "No" matched nothing and blocked a required field. Offer phrasings of
 * the same negative answer so the honest option is reachable. Only the negative
 * is expanded: a stored "Yes" is never widened into a claim about where or how
 * the product was used.
 */
function productUsageCandidates(field: FieldDescriptor, value: string): string[] {
  if (!PRODUCT_USAGE_QUESTION.test(normalizeLabel(field.label))) return [];
  if (!/^(?:no|not yet|never)\b/i.test(value.trim())) return [];
  return [value, "I have not used it", "I haven't used it", "Have not used", "Not yet", "No"];
}

/**
 * Boards render the degree field as a closed list in the platform's own
 * vocabulary ("Bachelor's Degree"), while a profile states the credential as
 * awarded ("Bachelor of Science (BSc)"). Neither string contains the other, so
 * an accurate answer found no option at all. Walk from the exact credential to
 * the platform's wording for the same level, most specific first, so nothing
 * broader than the degree actually held is ever selected.
 */
function degreeCandidates(field: FieldDescriptor, value: string): string[] {
  if (!DEGREE_QUESTION.test(normalizeLabel(field.label))) return [];
  const normalized = normalizeOptionText(value);
  const level = DEGREE_LEVELS.find((entry) => entry.test.test(normalized));
  return level ? [value, ...level.candidates] : [];
}

const DEGREE_LEVELS: ReadonlyArray<{ test: RegExp; candidates: readonly string[] }> = [
  {
    test: /\b(phd|ph d|doctor of philosophy|doctorate|doctoral)\b/,
    candidates: ["Doctor of Philosophy (Ph.D.)", "Doctorate", "Ph.D.", "PhD"],
  },
  {
    test: /\bm b a\b|\bmba\b|master of business administration/,
    candidates: ["Master of Business Administration (M.B.A.)", "MBA", "Master's Degree"],
  },
  {
    test: /\b(masters?|m sc|msc|m s|m eng|meng|master of)\b/,
    candidates: ["Master's Degree", "Masters Degree", "Master's", "Master"],
  },
  {
    test: /\b(bachelors?|b sc|bsc|b s|b eng|beng|b a|ba|bachelor of)\b/,
    candidates: ["Bachelor's Degree", "Bachelors Degree", "Bachelor's", "Bachelor"],
  },
  {
    test: /\b(associates?|a a|a s)\b/,
    candidates: ["Associate's Degree", "Associates Degree", "Associate's"],
  },
  {
    test: /\bhigh school|secondary school|ged\b/,
    candidates: ["High School", "High School Diploma", "GED"],
  },
];

/**
 * "How did you hear about us?" is a closed list that differs on every board, and
 * the preferred answer is frequently absent — Notion offers neither "Friend" nor
 * a generic "Referral". Rather than leave a required question blank, walk the
 * candidate's stated order of preference until an option exists. Options naming
 * a specific person or employee are not substituted in, because selecting one
 * would assert a referral that did not happen.
 */
function sourceCandidates(field: FieldDescriptor, value: string): string[] {
  if (!SOURCE_QUESTION.test(normalizeLabel(field.label))) return [];
  return [value, "Friend", "Referral", "Careers page", "Company website", "Website", "LinkedIn", "Other"];
}

/**
 * Boards ask about military service either in EEOC "protected veteran" terms or
 * as a plain "have you served?" question. These phrasings all assert the same
 * fact, so an approved not-a-protected-veteran answer can select any of them.
 */
function veteranCandidates(value: string): string[] {
  if (!/^i am not a protected veteran$/i.test(value.trim())) return [];
  return [
    "I am not a protected veteran",
    "I am not a veteran",
    "not a veteran",
    "I have not served in the military",
    "No",
  ];
}

/**
 * Some boards replace Yes/No on relocation questions with full sentences such
 * as "I am willing to relocate to this job's location." Offer the phrase so an
 * approved yes/no answer still selects the truthful option.
 */
/**
 * Relocation questions are rarely a yes/no list. Lyft offers three sentences,
 * none of which is "Yes", so a stored decision reached none of them.
 *
 * The affirmative candidate carries "am" deliberately: "willing to relocate" is
 * a substring of "I am **not** willing to relocate before starting employment.",
 * so the looser phrase could select the exact opposite of the stored answer.
 * "am willing to relocate" cannot match the negated sentence.
 *
 * Nothing here widens a stored answer into a claim about where the candidate
 * already lives - an option such as "I already reside within commutable
 * distance" is a statement of fact the profile has not made.
 */
function relocationCandidates(field: FieldDescriptor, value: string): string[] {
  // A relocation question does not always say so in its label. Abridge asks
  // "Where in the United States will you be working from?" and puts the
  // decision in the options ("I am willing to relocate within 6 months"), so
  // reading the label alone left a required question unanswerable. The option
  // text is part of the question being asked, so it counts too.
  // "relocating" does not contain "relocate", so match the shared stem.
  const haystack = `${normalizeLabel(field.label)} ${normalizeOptionText(field.optionLabel ?? "")}`;
  if (!haystack.includes("relocat")) return [];
  if (/^(yes|true|1)$/i.test(value.trim())) return ["am willing to relocate", "open to relocating"];
  if (/^(no|false|0)$/i.test(value.trim())) return ["not willing to relocate", "not open to relocating"];
  return [];
}

/** True when an option label plausibly represents the requested value. */
export function optionTextMatches(optionText: string, value: string): boolean {
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
function optionPolarityConflicts(optionText: string, candidate: string): boolean {
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

function isDeclinePhrase(text: string): boolean {
  const normalized = normalizeOptionText(text);
  if (normalized.length === 0) return false;
  if (DECLINE_ANSWER_PATTERN.test(text.trim())) return true;
  return DECLINE_OPTION_CANDIDATES.some((decline) => normalized.includes(normalizeOptionText(decline)));
}

/** Index of the option best matching any candidate, or -1 when none match. */
export function pickOptionIndex(
  optionTexts: readonly string[],
  candidates: readonly string[],
): number {
  for (const candidate of candidates) {
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
    // a stored current-employer answer of "Microsoft"; that is not an
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
  const escape = normalized.findIndex((text) => OUTSIDE_US_OPTION.test(text));
  if (escape < 0) return -1;
  // Only a candidate that names a place may take the escape. A yes/no or a
  // decline reaching here means the answer was never about where he lives.
  const namesAPlace = candidates.some((candidate) => {
    const value = normalizeOptionText(candidate);
    if (value.length === 0) return false;
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
 * is never an acceptable substitute for it.
 */
const NEGATION = /\b(not|never|no|none|neither|decline)\b/;

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
const AFFIRMATIVE_CANDIDATE = /^(?:yes|true|agreed?|i agree|acknowledged?|i acknowledge|accept|i accept|consent|i consent)\b/;

/** Whether a lone option is pure agreement, in either of the two wordings. */
function isSoleOptIn(normalizedOption: string): boolean {
  return SOLE_OPT_IN_OPTION.test(normalizedOption) || OPT_IN_ATTESTATION.test(normalizedOption);
}
const NEGATIVE_CANDIDATE = /^(?:no|false|i do not|i don t|not |never|disagree|i disagree|decline|i decline)\b/;

function normalizeOptionText(input: string): string {
  return expandContractions(input.toLowerCase()).replace(/[^a-z0-9]+/g, " ").trim();
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

/** A pre-approved answer from the profile answer bank. */
export type ApprovedAnswerEntry = {
  key: string;
  label: string;
  patterns: readonly string[];
  answer: string;
  allowAutoFill: boolean;
};

/** Resolves a stored personal answer for a live field label. */
export type PersonalResolver = (label: string) => {
  answer: string;
  citation: string;
  category: string;
  /** Whether the candidate opted this field in for automatic use. */
  authorized: boolean;
} | null;

/** Renders an approved narrative template for an open-ended question. */
export type NarrativeResolver = (label: string) => {
  answer: string;
  citation: string;
  authorized: boolean;
} | null;

/**
 * Only Greenhouse publishes a question schema, so Ashby and Lever packets are
 * drafted against a baseline field set and omit questions the live page does in
 * fact ask. Draw those extra answers from the pre-approved bank, matched by the
 * same patterns drafting uses, so the reviewer is handed a complete form.
 *
 * Longest pattern wins, mirroring drafting, so a specific entry is never
 * pre-empted by a generic one.
 *//** Views a bank entry as a draft answer so shared compatibility rules apply. */
function bankEntryAsAnswer(entry: ApprovedAnswerEntry): DraftAnswer {
  return {
    questionKey: entry.key,
    label: entry.label,
    answer: entry.answer,
    source: "approved-answer",
    citation: `profile.answers.${entry.key}`,
    requiresHuman: false,
    required: true,
    category: "general",
    guidance: "",
  };
}

/**
 * Greenhouse renders education and employment as repeatable blocks whose
 * controls share one label vocabulary: both call the graduation year and the
 * year a job ended "End date year". Affirm's form aborted on that field with
 * the answer sitting in the profile the whole time, because no resolver pattern
 * matches "End date year" and matching it loosely would put a graduation year
 * into a job history.
 *
 * The block is only identifiable from the DOM id, where the trailing index ties
 * a date control to the `school--N` or `company--N` it belongs to. A date is
 * only re-labelled when its own index has a school and no company, so a form
 * that numbers both blocks alike is left alone rather than answered wrongly.
 */
const EDUCATION_DATE_ID = /^end-year--(\d+)$/;

export function educationDateLabels(fields: readonly FieldDescriptor[]): Map<number, string> {
  const blocks = new Set<string>();
  const employment = new Set<string>();
  for (const field of fields) {
    const id = field.domId ?? "";
    const school = /^school--(\d+)$/.exec(id);
    if (school) blocks.add(school[1]!);
    const company = /^company--(\d+)$/.exec(id);
    if (company) employment.add(company[1]!);
  }
  const overrides = new Map<number, string>();
  for (const field of fields) {
    const match = EDUCATION_DATE_ID.exec(field.domId ?? "");
    if (!match) continue;
    const index = match[1]!;
    if (!blocks.has(index) || employment.has(index)) continue;
    overrides.set(field.selectorIndex, "Graduation year");
  }
  return overrides;
}

/**
 * A date the candidate signs, as opposed to one they remember.
 *
 * Only the field's own machine name decides this. "Start date" and "End date"
 * are history and belong to the profile; a signature date is today by
 * definition, and no stored answer can ever supply it.
 */
function signatureDateField(field: FieldDescriptor): boolean {
  if (field.type !== "date") return false;
  const hints = `${field.name} ${field.questionLabel ?? ""}`.toLowerCase();
  return /sign/.test(hints);
}

function todayForSignature(): string {
  const now = new Date();
  const pad = (part: number): string => String(part).padStart(2, "0");
  return `${pad(now.getMonth() + 1)}/${pad(now.getDate())}/${now.getFullYear()}`;
}

export function fallbackAnswersForFields(  fields: readonly FieldDescriptor[],
  answers: readonly DraftAnswer[],
  bank: readonly ApprovedAnswerEntry[],
  resolvePersonalAnswer?: PersonalResolver,
  resolveNarrativeAnswer?: NarrativeResolver,
  resolveExperienceAnswer?: PersonalResolver,
): DraftAnswer[] {
  const eligible = bank.filter((entry) => entry.allowAutoFill && entry.answer.trim().length > 0);
  // A signature date needs no bank entry - it is today by definition - so the
  // shortcut below must not skip a form that has one.
  if (
    eligible.length === 0 &&
    !resolvePersonalAnswer &&
    !resolveNarrativeAnswer &&
    !resolveExperienceAnswer &&
    !fields.some(signatureDateField)
  )
    return [];

  const alreadyAnswered = new Set(answers.map((entry) => entry.questionKey));
  const matched = matchFields(fields, answers);
  const resolverLabels = educationDateLabels(fields);
  const derived: DraftAnswer[] = [];
  const used = new Set<string>();

  for (const match of matched) {
    // The resolvers only ever see a label, so an ambiguous one is replaced by
    // the question the control actually asks. The derived answer keeps the live
    // label so it still binds to this field.
    const resolverLabel = resolverLabels.get(match.field.selectorIndex) ?? match.field.label;
    if (match.answer !== null && match.answer.answer.trim().length > 0) {
      // A radio option counts as answered only if the matched answer actually
      // names it. Ashby's consent radios are labelled "Phone Number", so the
      // phone number matches them without selecting anything.
      const isOption = match.field.type === "radio" && Boolean(match.field.optionLabel);
      const names =
        !isOption ||
        pickOptionIndex([match.field.optionLabel ?? ""], optionSearchCandidates(match.field, match.answer)) >= 0;
      if (names) continue;
    }
    // Employment history first: these labels are exact, and they name the
    // position being left rather than the one being applied for, so no broader
    // bank pattern should be able to win them.
    const experience = resolveExperienceAnswer?.(resolverLabel);
    if (experience && experience.authorized && experience.answer.trim().length > 0) {
      // Start month and start year cite the same profile value, so the citation
      // alone would let one control spend the other's answer.
      const usedKey = `${experience.citation}#${match.field.selectorIndex}`;
      if (!used.has(usedKey)) {
        used.add(usedKey);
        derived.push({
          questionKey: experience.citation,
          label: match.field.label,
          answer: experience.answer,
          source: "profile",
          citation: experience.citation,
          requiresHuman: false,
          required: match.field.required ?? true,
          category: experience.category,
          guidance: "",
        });
      }
      continue;
    }

    // A form the candidate signs carries the date it was signed, which is today
    // and nothing else. No stored answer can supply it, and leaving it blank
    // stops the disability form from saving.
    if (signatureDateField(match.field)) {
      derived.push({
        questionKey: `signature-date#${match.field.selectorIndex}`,
        label: match.field.label,
        answer: todayForSignature(),
        source: "profile",
        citation: "system.today",
        requiresHuman: false,
        required: match.field.required ?? true,
        category: "general",
        guidance: "",
      });
      continue;
    }

    const entry = bestBankEntry(match.field, eligible);
    // A bank entry that cannot serve this field is no reason to leave the field
    // blank - the personal and narrative resolvers below may still hold the
    // right answer. Abridge asks "Which state do you currently reside in?"; a
    // bank entry matched and was correctly rejected as a work-authority answer
    // to a residence question, but the `continue` that followed also discarded
    // personal.address.region, which is exactly the answer wanted. The required
    // field went unanswered and the submission aborted with nothing to show for
    // it. Rejecting a candidate answer must fall through to the next source, not
    // veto the field.
    if (entry && !isIncompatible(match.field, bankEntryAsAnswer(entry))) {
      // Radio options arrive one field per option, so a bank answer may only be
      // spent once across them. Standalone controls are independent, and forms
      // do repeat them - two acknowledgement boxes, or "LinkedIn" alongside
      // "LinkedIn Profile" - so there the same answer may serve each field.
      const usedKey = match.field.optionLabel ? entry.key : `${entry.key}#${match.field.selectorIndex}`;
      // For a standalone control this loop is only reached when the field is
      // still empty, so the packet already holding this key is not a reason to
      // leave it that way. Ashby's baseline field set labels the entry
      // "LinkedIn Profile" while the live page asks for "LinkedIn URL"; the
      // packet answer bound to nothing, and treating the key as spent left a
      // required field blank and aborted the submission. Option groups keep the
      // stricter rule, where spending a bank answer twice can contradict the
      // packet.
      const spent = match.field.optionLabel ? used.has(usedKey) || alreadyAnswered.has(entry.key) : used.has(usedKey);
      if (!spent) {
        used.add(usedKey);
        derived.push({
          questionKey: entry.key,
          // The live label guarantees this answer binds to the field it was chosen for.
          label: match.field.label,
          answer: entry.answer,
          source: "approved-answer",
          citation: `profile.answers.${entry.key}`,
          requiresHuman: false,
          required: match.field.required ?? true,
          category: "general",
          guidance: "",
        });
        continue;
      }
    }

    const personal = resolvePersonalAnswer?.(resolverLabel);
    if (personal && personal.authorized && personal.answer.trim().length > 0) {
      // Radios arrive one field per option, so key on the citation to answer once.
      if (used.has(personal.citation) || alreadyAnswered.has(personal.citation)) continue;
      used.add(personal.citation);
      derived.push({
        questionKey: personal.citation,
        label: match.field.label,
        answer: personal.answer,
        source: "profile",
        citation: personal.citation,
        requiresHuman: false,
        required: match.field.required ?? true,
        category: personal.category,
        guidance: "",
      });
      continue;
    }

    // Open-ended questions only ever reach a text box, never an option list.
    if (match.field.optionLabel) continue;
    const narrative = resolveNarrativeAnswer?.(resolverLabel);
    if (!narrative || !narrative.authorized || narrative.answer.trim().length === 0) continue;
    if (used.has(narrative.citation) || alreadyAnswered.has(narrative.citation)) continue;
    used.add(narrative.citation);
    derived.push({
      questionKey: narrative.citation,
      label: match.field.label,
      answer: narrative.answer,
      source: "profile",
      citation: narrative.citation,
      requiresHuman: false,
      required: match.field.required ?? true,
      category: "narrative",
      guidance: "",
    });
  }
  return derived;
}

/**
 * Employers ask the sponsorship question without ever writing the word. NVIDIA
 * asks "Will you require employer support to obtain or maintain authorization
 * to work in that country? e.g. (work permit)" - the same question thirteen
 * stored patterns cover, phrased so none of them matches. A decision already on
 * file went unasked and the wizard stalled on a blank required field.
 *
 * This only routes the stored answer to a question that means the same thing;
 * it never invents one. A form that defines sponsorship by naming an
 * immigration class is deliberately excluded, because this candidate answers
 * that one the other way: TN needs no petition but does need a support letter.
 */
const NAMED_IMMIGRATION_CLASS_IN_FIELD =
  /\b(h-?1-?b|e-?3|tn|o-?1|l-?1|f-?1|j-?1|usmca|nafta|opt|cpt|green card|permanent residen)/;

function asksForSponsorship(label: string): boolean {
  if (NAMED_IMMIGRATION_CLASS_IN_FIELD.test(label)) return false;
  if (/\b(employer|immigration|visa)[- ]?(related )?support\b/.test(label)) return true;
  if (/\bwork permit\b/.test(label)) return true;
  return /\bsupport\b/.test(label) && /\b(obtain|maintain)\b/.test(label) && /authoriz/.test(label);
}

/** The candidate's standing yes/no sponsorship answer, if one is on file. */
function sponsorshipBankEntry(
  bank: readonly ApprovedAnswerEntry[],
): ApprovedAnswerEntry | undefined {
  return bank.find(
    (entry) =>
      /sponsor/.test(normalizeLabel(entry.key)) &&
      BOOLEAN_ANSWER.test(entry.answer.trim()) &&
      !NAMED_IMMIGRATION_CLASS_IN_FIELD.test(normalizeLabel(entry.label)) &&
      !entry.patterns.some((pattern) => NAMED_IMMIGRATION_CLASS_IN_FIELD.test(normalizeLabel(pattern))),
  );
}

function bestBankEntry(
  field: FieldDescriptor,
  bank: readonly ApprovedAnswerEntry[],
): ApprovedAnswerEntry | undefined {
  const haystack = normalizeLabel(field.label);
  // Ashby labels a consent radio group after the field above it, so the real
  // question is only readable from the options themselves.
  const optionText = field.optionLabel ? normalizeLabel(field.optionLabel) : "";
  // The question a control sits under is the most precise description of what
  // it asks. A background-check box reads only "I understand" on its own, which
  // matches no stored pattern and leaves a required box clear.
  const questionText = field.questionLabel ? normalizeLabel(field.questionLabel) : "";
  const candidates = [haystack, optionText, questionText].filter((value) => value.length > 0);
  if (candidates.length === 0) return undefined;
  // "GitHub" normalizes to "git hub", so a stored pattern of "github" would
  // never match. Compare de-spaced forms too, scoring on the original length.
  const squashed = candidates.map((value) => value.replace(/\s+/g, ""));
  let best: { entry: ApprovedAnswerEntry; length: number } | undefined;
  for (const entry of bank) {
    for (const pattern of entry.patterns) {
      const needle = normalizeLabel(pattern);
      if (needle.length === 0) continue;
      const squashedNeedle = needle.replace(/\s+/g, "");
      const hit =
        candidates.some((value) => value.includes(needle)) ||
        squashed.some((value) => value.includes(squashedNeedle));
      if (!hit) continue;
      if (!best || needle.length > best.length) best = { entry, length: needle.length };
    }
  }
  if (!best && candidates.some((value) => asksForSponsorship(value))) {
    return sponsorshipBankEntry(bank);
  }
  return best?.entry;
}

/** Adds deterministic browser-only aliases derived from already approved answers. */
export function augmentAnswersForBrowser(
  answers: readonly DraftAnswer[],
  candidateCountry?: string,
): DraftAnswer[] {
  const firstName = answers.find((answer) => normalizeLabel(answer.label) === "first name");
  const lastName = answers.find((answer) => normalizeLabel(answer.label) === "last name");
  const hasLegalName = answers.some((answer) => normalizeLabel(answer.label) === "legal name");
  const derived: DraftAnswer[] = [];
  if (
    !hasLegalName &&
    firstName &&
    lastName &&
    firstName.answer.trim().length > 0 &&
    lastName.answer.trim().length > 0
  ) {
    const whole = `${firstName.answer.trim()} ${lastName.answer.trim()}`;
    const citation = [firstName.citation, lastName.citation].filter(Boolean).join("; ");
    derived.push({
      ...firstName,
      questionKey: "derived-legal-name",
      label: "Legal Name",
      answer: whole,
      citation,
    });
    derived.push({
      ...firstName,
      questionKey: "derived-full-name",
      label: "Full Name",
      answer: whole,
      citation,
    });
  }

  const hasCountry = answers.some((answer) => normalizeLabel(answer.label) === "country");
  if (!hasCountry && candidateCountry?.trim()) {
    derived.push({
      questionKey: "derived-country",
      label: "Country",
      answer: candidateCountry.trim(),
      source: "profile",
      citation: "identity.location.country",
      requiresHuman: false,
      required: true,
      category: "contact",
      guidance: "",
    });
  }

  const declinesDemographics = answers.some(
    (answer) => answer.category === "demographic" && DECLINE_ANSWER_PATTERN.test(answer.answer.trim()),
  );
  if (declinesDemographics) {
    derived.push({
      questionKey: "derived-demographic-consent",
      label: "I consent to collecting, storing, and processing my responses to the demographic data surveys",
      answer: "Yes",
      source: "profile",
      citation: "candidate approval 2026-07-31; every demographic response is decline to self-identify",
      requiresHuman: false,
      required: true,
      category: "demographic",
      guidance: "",
    });
  }

  return [...answers, ...derived];
}

/**
 * Whole-phrase patterns, not substrings. A bare "security challenge" matched
 * inside "enterprise security challenges", which is ordinary prose in almost
 * every security job advert, so a correct posting was reported as an anti-bot
 * wall. A challenge marker has to be copy that asks the reader to act.
 */
const CAPTCHA_CHALLENGE_PATTERNS = [
  /\b(?:verify|verifying|confirm|confirming)\s+(?:that\s+)?you\s+are\s+(?:a\s+)?human\b/,
  /\bare\s+you\s+a\s+robot\b/,
  /\b(?:please\s+)?complete\s+(?:the|this)\s+(?:captcha|security\s+(?:challenge|check))\b/,
  /\bchallenge\s+in\s+progress\b/,
  /\bchecking\s+(?:if\s+the\s+site\s+connection\s+is\s+secure|your\s+browser)\b/,
  /\bunusual\s+traffic\s+from\s+your\s+(?:computer|network)\b/,
];

/** Detects active anti-bot challenge copy without flagging passive widget markup. */
export function detectCaptcha(pageText: string): boolean {
  const haystack = pageText.toLowerCase();
  return CAPTCHA_CHALLENGE_PATTERNS.some((pattern) => pattern.test(haystack));
}

const SUBMISSION_CONFIRMATION_MARKERS = [
  "thank you for applying",
  "thanks for applying",
  "your application has been submitted",
  "your application was submitted",
  "application submitted",
  "we received your application",
  "we've received your application",
  "we have received your application",
  "your application is in",
  "your application has been received",
  "we've got your application",
  "we have your application",
];

/**
 * Employers write the same confirmation with an adverb in the middle - Ashby
 * renders "Your application was successfully submitted" - which no literal
 * marker matches. A run that really did submit is then reported as unverified,
 * and the obvious response, submitting again, sends a duplicate. These patterns
 * allow one optional adverb between the verb and its participle; the subject
 * and participle are still both required, so unrelated page copy cannot pass.
 */
const SUBMISSION_CONFIRMATION_PATTERNS = [
  /\byour application (?:was|has been|is)(?: \w+ly)? (?:submitted|received|sent|complete[d]?)\b/,
  /\bapplication (?:was|has been)(?: \w+ly)? (?:submitted|received)\b/,
  /\b(?:successfully|already) (?:submitted|applied)\b/,
];

/**
 * ATS platforms route to a dedicated confirmation URL only after a submission
 * is accepted, so the path is a stronger signal than employer copy. Pinterest
 * writes "Good news: your application is in!" and Greenhouse still landed on
 * /job_app/confirmation, which no marker list would have covered in advance.
 * The check is anchored to a whole path segment so a posting that merely
 * mentions the word cannot pass.
 */
const CONFIRMATION_URL_PATTERN =
  /(?:^|[/?&#])(?:confirmation|confirmed|application[_-]?(?:submitted|complete|received)|thank[_-]?you|success)(?:$|[/?&#])/i;

/** True when the ATS itself routed to a post-submission confirmation page. */
export function isConfirmationUrl(url: string): boolean {
  if (!url) return false;
  try {
    const parsed = new URL(url);
    return CONFIRMATION_URL_PATTERN.test(`${parsed.pathname}${parsed.search}${parsed.hash}`);
  } catch {
    return false;
  }
}

/**
 * An ATS that refuses a submission says so plainly, but it says it in a page
 * banner rather than a field error, so readValidationErrors does not see it and
 * the run fell back to "no confirmation was detected; verify this application
 * manually". Those two outcomes call for opposite responses. An unconfirmed
 * submission might have gone through, so the safe move is to check before
 * resubmitting and risk a duplicate. An explicit refusal means nothing was
 * submitted at all and the application still needs sending by hand. Ashby
 * rejects headless runs with "Your application submission was flagged as
 * possible spam", which read as the former and was in fact the latter.
 */
const SUBMISSION_REJECTED_MARKERS = [
  "couldn't submit your application",
  "could not submit your application",
  "unable to submit your application",
  "flagged as possible spam",
  "your application was not submitted",
  "we were unable to process your application",
];

/** True when the page states outright that it refused the submission. */
export function detectSubmissionRejection(pageText: string): boolean {
  const haystack = pageText.toLowerCase();
  return SUBMISSION_REJECTED_MARKERS.some((marker) => haystack.includes(marker));
}

/**
 * Requires positive evidence before a run is recorded as submitted: either the
 * employer's own confirmation copy, or the ATS routing to its confirmation
 * page. Absence of both is still reported honestly as unverified.
 */
export function detectSubmissionConfirmation(pageText: string, finalUrl = ""): boolean {
  const haystack = pageText.toLowerCase();
  // A page that says it refused the submission cannot also be confirming one.
  // Ashby's rejection banner sits on the job page, whose URL can still look
  // like a confirmation route, so the refusal has to win over every signal.
  if (detectSubmissionRejection(haystack)) return false;
  if (SUBMISSION_CONFIRMATION_MARKERS.some((marker) => haystack.includes(marker))) return true;
  if (SUBMISSION_CONFIRMATION_PATTERNS.some((pattern) => pattern.test(haystack))) return true;
  return isConfirmationUrl(finalUrl);
}

const CORE_APPLICATION_FIELD = /\b(e-?mail|resume|resum|cv|first name|last name|full name|your name)\b/;

/**
 * A removed posting does not 404 on Greenhouse or Ashby; it quietly redirects to
 * the company's job index, which still exposes inputs such as "Search" and
 * "Department". Filling nothing there and reporting "prepared" reads as success,
 * so a run is only treated as a real application form when a core applicant
 * field is present.
 */
export function looksLikeApplicationForm(fields: readonly FieldDescriptor[]): boolean {
  return fields.some(
    (field) => field.type === "file" || CORE_APPLICATION_FIELD.test(normalizeLabel(field.label)),
  );
}

/**
 * True when the control already holds a real answer.
 *
 * A required field that arrives filled needs nothing from us, and demanding an
 * answer for it stops a wizard on a question the employer already answered.
 * Placeholder text is not an answer.
 */
const FIELD_PLACEHOLDER_VALUE = /^(select(\.{0,3}| one)?|choose(\.{0,3}| one)?|search|none|-+|[my]{2}\/[dm]{2}\/[dy]{4}|[dy]{4}\/[md]{2}\/[dm]{2})$/i;

function alreadyAnswered(field: FieldDescriptor): boolean {
  // A segmented date control reports its parts on separate lines ("MM\n/\nDD"),
  // so the value is collapsed before it is compared against placeholder text.
  const value = (field.value ?? "")
    .replace(/\s*\/\s*/g, "/")
    .replace(/\s+/g, " ")
    .trim();
  if (value.length === 0) return false;
  return !FIELD_PLACEHOLDER_VALUE.test(value);
}

export type FillPlan = {  toFill: FieldMatch[];
  unmatchedRequired: FieldDescriptor[];
  /** Every visible field nothing filled, so a reviewer knows what is left. */
  unfilled: FieldDescriptor[];
  unusedAnswers: DraftAnswer[];
};

/** Fills controls that may re-render the form only after stable text inputs. */
export function orderFieldsForBrowser(matches: readonly FieldMatch[]): FieldMatch[] {
  return [...matches].sort((left, right) => {
    const leftStateful = left.field.type === "checkbox" || left.field.type === "radio" ? 1 : 0;
    const rightStateful = right.field.type === "checkbox" || right.field.type === "radio" ? 1 : 0;
    return leftStateful - rightStateful;
  });
}

/**
 * Radios arrive one descriptor per option, and grouped checkboxes do too. Reduce
 * each group to the single option that states the approved answer, and report an
 * unfilled required group once rather than once per option.
 *
 * Checkboxes have to be collapsed for a stronger reason than tidiness. Nothing
 * stops several options in one "select all that apply" group from each matching
 * the same answer on their shared question label, and every one of them was then
 * ticked: a demographic survey came back claiming every ethnicity and every
 * orientation at once, alongside both "None of the above" and "I prefer not to
 * answer". A single stored answer names a single option, so exactly one is
 * selected - over-ticking a group states things about the candidate that are not
 * true.
 */
function collapseOptionGroups(
  matches: readonly FieldMatch[],
  answers: readonly DraftAnswer[],
): FieldMatch[] {
  const groups = new Map<string, FieldMatch[]>();
  const out: FieldMatch[] = [];
  for (const match of matches) {
    const key = groupIdentity(match.field);
    if (!key) {
      out.push(match);
      continue;
    }
    const existing = groups.get(key);
    if (existing) existing.push(match);
    else groups.set(key, [match]);
  }

  for (const group of groups.values()) {
    const optionLabels = group.map((match) => match.field.optionLabel ?? "");
    const head = group[0]!;
    const matched = group.find((match) => match.answer !== null)?.answer ?? null;

    // A group's answer has to name one of its options. Ashby labels the SMS
    // consent radios "Phone Number", so the phone number itself matches first
    // and selects nothing; fall through to answers that do name an option.
    const candidates: DraftAnswer[] = [];
    if (matched) candidates.push(matched);
    for (const answer of answers) {
      if (answer === matched) continue;
      if (similarity(head.field.label, answer.label) < MIN_CONFIDENCE) continue;
      candidates.push(answer);
    }

    let selected: { index: number; answer: DraftAnswer } | undefined;
    for (const answer of candidates) {
      const index = pickOptionIndex(optionLabels, optionSearchCandidates(head.field, answer));
      if (index >= 0) {
        selected = { index, answer };
        break;
      }
    }

    if (!selected) {
      out.push({ ...head, answer: null });
      continue;
    }
    out.push({
      ...group[selected.index]!,
      answer: selected.answer,
      confidence: similarity(head.field.label, selected.answer.label),
    });
  }
  return out;
}

/**
 * Identifies the option group a control belongs to, or nothing when it stands
 * alone. Radios are grouped by their shared `name`, which the browser already
 * enforces; checkboxes have independent names, so they are grouped by the
 * structural `groupKey` derived from the surrounding question.
 */
function groupIdentity(field: FieldDescriptor): string | undefined {
  if (!field.optionLabel) return undefined;
  if (field.type === "radio") return field.name.length > 0 ? `radio:${field.name}` : undefined;
  if (field.type === "checkbox") return field.groupKey ? `checkbox:${field.groupKey}` : undefined;
  return undefined;
}

/** Builds a plan and reports required fields that nothing can safely fill. */
export function buildFillPlan(fields: readonly FieldDescriptor[], answers: readonly DraftAnswer[]): FillPlan {
  const matches = collapseOptionGroups(matchFields(fields, answers), answers);
  const used = new Set(
    matches.filter((match) => match.answer !== null).map((match) => match.answer!.questionKey),
  );
  const unfilled = matches.filter(
    (match) =>
      match.field.type !== "file" &&
      (match.answer === null || match.answer.answer.trim().length === 0),
  );
  return {
    toFill: matches.filter((match) => match.answer !== null && match.answer.answer.trim().length > 0),
    // A field marked notApplicable is finished, not missing. "If yes, please
    // describe" after a "No" has nothing to describe, and reporting it as
    // unfillable aborted an application that was in fact complete.
    unmatchedRequired: unfilled
      .filter((match) => match.field.required && match.answer?.notApplicable !== true)
      .filter((match) => !alreadyAnswered(match.field))
      .map((match) => match.field),
    unfilled: unfilled.map((match) => match.field),
    unusedAnswers: answers.filter((answer) => !used.has(answer.questionKey)),
  };
}
