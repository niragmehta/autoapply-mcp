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
  required: boolean;
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

const BARE_NAME_FIELD = /^(?:your |applicant |candidate )?(?:full |legal )?name$/;const PARTIAL_NAME_ANSWER = /^(?:first|last|middle|preferred|nick|given|family|sur)\s?name\b/;
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
const RESIDENCE_QUESTION = /\b(located|located in|reside|residing|live|living|based)\b/;
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
 */
function isIncompatible(field: FieldDescriptor, answer: DraftAnswer): boolean {
  const fieldLabel = normalizeLabel(field.label);
  const answerLabel = normalizeLabel(answer.label);
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
  if (namesDifferentPeriodEnd(fieldLabel, answerLabel)) {
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
  return field.type === "checkbox" && !field.optionLabel && !BOOLEAN_ANSWER.test(answer.answer.trim());
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
  if (
    /^(decline to self-identify|i (?:do not|don't) wish to answer|prefer not to (?:answer|say))$/i.test(
      answer.answer.trim(),
    )
  ) {
    return "wish to answer";
  }
  return answer.answer;
}

const DECLINE_ANSWER_PATTERN =
  /^(?:decline to (?:self[\s-]?identify|answer|state)|i (?:do not|don't) wish to answer|do not wish to answer|prefer not to (?:answer|say|disclose))$/i;

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
  const label = normalizeLabel(field.label);
  // "relocating" does not contain "relocate", so match the shared stem.
  if (!label.includes("relocat")) return [];
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

const BARE_POLARITY = /^(?:yes|no|true|false)$/;
const POSITIVE_LEAD = /^(?:yes|true|agree|agreed|accept|confirm|confirmed)$/;
const NEGATIVE_LEAD = /^(?:no|not|never|false|decline|disagree)$/;

/**
 * A bare "No" must not select an option that opens with "Yes". Datadog offers
 * "Yes, no restriction.", which contains "no" as a whole word, so a stored "No"
 * matched it and would have reported unrestricted work authorization to an
 * employer - the exact opposite of the stored answer. Whole-word containment is
 * not enough here: when the candidate is nothing but a polarity word, the
 * option's own leading polarity decides.
 */
function optionPolarityConflicts(optionText: string, candidate: string): boolean {
  const expected = normalizeOptionText(candidate);
  if (!BARE_POLARITY.test(expected)) return false;
  const lead = normalizeOptionText(optionText).split(" ")[0] ?? "";
  const candidatePositive = POSITIVE_LEAD.test(expected);
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
  }
  const band = pickNumericBandIndex(optionTexts, candidates);
  if (band >= 0) return band;
  if (optionTexts.length === 1 && SOLE_OPT_IN_OPTION.test(normalizeOptionText(optionTexts[0] ?? ""))) {    if (candidates.some((candidate) => AFFIRMATIVE_CANDIDATE.test(normalizeOptionText(candidate)))) {
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
  return -1;
}

/**
 * A bare "Yes" partially matches every option that opens with "Yes", so taking
 * the first one in document order is luck rather than logic. Datadog offers
 * "Yes, no restriction.", "Yes, but I will need sponsorship in the future." and
 * "No, I need sponsorship now."; a differently ordered board would have claimed
 * the candidate needs sponsorship. Prefer the least elaborated match, because a
 * stored answer of "Yes" means plain yes, not "yes, but".
 */
function leastQualifiedMatch(optionTexts: readonly string[], candidate: string): number {
  let best = -1;
  let bestLength = Number.POSITIVE_INFINITY;
  for (let index = 0; index < optionTexts.length; index += 1) {
    const text = optionTexts[index] ?? "";
    if (!optionTextMatches(text, candidate)) continue;
    if (optionNegatesCandidate(text, candidate)) continue;
    if (optionPolarityConflicts(text, candidate)) continue;
    if (optionContradictsDecline(text, candidate)) continue;
    const length = normalizeOptionText(text).length;
    if (length < bestLength) {
      best = index;
      bestLength = length;
    }
  }
  return best;
}

const SOLE_OPT_IN_OPTION = /^(?:i )?(?:acknowledge|agree|accept|consent|certify|confirm|understand)\b/;const AFFIRMATIVE_CANDIDATE = /^(?:yes|true|agreed?|i agree|acknowledged?|i acknowledge|accept|i accept|consent|i consent)\b/;
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

export function fallbackAnswersForFields(
  fields: readonly FieldDescriptor[],
  answers: readonly DraftAnswer[],
  bank: readonly ApprovedAnswerEntry[],
  resolvePersonalAnswer?: PersonalResolver,
  resolveNarrativeAnswer?: NarrativeResolver,
  resolveExperienceAnswer?: PersonalResolver,
): DraftAnswer[] {
  const eligible = bank.filter((entry) => entry.allowAutoFill && entry.answer.trim().length > 0);
  if (eligible.length === 0 && !resolvePersonalAnswer && !resolveNarrativeAnswer && !resolveExperienceAnswer) return [];

  const alreadyAnswered = new Set(answers.map((entry) => entry.questionKey));
  const matched = matchFields(fields, answers);
  const derived: DraftAnswer[] = [];
  const used = new Set<string>();

  for (const match of matched) {
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
    const experience = resolveExperienceAnswer?.(match.field.label);
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

    const entry = bestBankEntry(match.field, eligible);
    if (entry) {
      // The derived answer carries the live field label so it binds to this
      // field, which also means the compatibility rules can no longer see where
      // the answer came from. Check the entry's own label first: a bank pattern
      // as broad as "major" otherwise matches "major life activities" and
      // answers a disability question with a degree subject.
      if (isIncompatible(match.field, bankEntryAsAnswer(entry))) continue;
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
      if (spent) continue;
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

    const personal = resolvePersonalAnswer?.(match.field.label);
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
    const narrative = resolveNarrativeAnswer?.(match.field.label);
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

const CAPTCHA_CHALLENGE_MARKERS = [
  "verify you are human",
  "confirm you are human",
  "are you a robot",
  "please complete the captcha",
  "complete this captcha",
  "security challenge",
  "challenge in progress",
];

/** Detects active anti-bot challenge copy without flagging passive widget markup. */
export function detectCaptcha(pageText: string): boolean {
  const haystack = pageText.toLowerCase();
  return CAPTCHA_CHALLENGE_MARKERS.some((marker) => haystack.includes(marker));
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
 * Requires positive evidence before a run is recorded as submitted: either the
 * employer's own confirmation copy, or the ATS routing to its confirmation
 * page. Absence of both is still reported honestly as unverified.
 */
export function detectSubmissionConfirmation(pageText: string, finalUrl = ""): boolean {
  const haystack = pageText.toLowerCase();
  if (SUBMISSION_CONFIRMATION_MARKERS.some((marker) => haystack.includes(marker))) return true;
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

export type FillPlan = {
  toFill: FieldMatch[];
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
 * Radios arrive one descriptor per option. Reduce each group to the single
 * option that states the approved answer, and report an unfilled required group
 * once rather than once per option.
 */
function collapseRadioGroups(
  matches: readonly FieldMatch[],
  answers: readonly DraftAnswer[],
): FieldMatch[] {
  const groups = new Map<string, FieldMatch[]>();
  const out: FieldMatch[] = [];
  for (const match of matches) {
    const key = match.field.name;
    if (match.field.type !== "radio" || !match.field.optionLabel || key.length === 0) {
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

/** Builds a plan and reports required fields that nothing can safely fill. */
export function buildFillPlan(fields: readonly FieldDescriptor[], answers: readonly DraftAnswer[]): FillPlan {
  const matches = collapseRadioGroups(matchFields(fields, answers), answers);
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
    unmatchedRequired: unfilled.filter((match) => match.field.required).map((match) => match.field),
    unfilled: unfilled.map((match) => match.field),
    unusedAnswers: answers.filter((answer) => !used.has(answer.questionKey)),
  };
}
