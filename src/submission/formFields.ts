import type { DraftAnswer } from "../domain/job.js";

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
  return 0;
}

const MIN_CONFIDENCE = 0.6;

const BARE_NAME_FIELD = /^(?:your |applicant |candidate )?(?:full |legal )?name$/;
const PARTIAL_NAME_ANSWER = /^(?:first|last|middle|preferred|nick|given|family|sur)\s?name\b/;
const BOOLEAN_ANSWER = /^(yes|no|true|false|1|0|on|off|i agree|agree|i consent|consent|i acknowledge|acknowledge)\b/i;
const RESIDENCE_QUESTION = /\b(located|located in|reside|residing|live|living|based)\b/;
const WORK_AUTHORITY_TEXT = /\b(authoriz|sponsor|visa|work permit|eligible to work)/;

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
 */
function isIncompatible(field: FieldDescriptor, answer: DraftAnswer): boolean {
  const fieldLabel = normalizeLabel(field.label);
  const answerLabel = normalizeLabel(answer.label);
  if (BARE_NAME_FIELD.test(fieldLabel) && PARTIAL_NAME_ANSWER.test(answerLabel)) {
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
  const relocation = relocationCandidates(field, value);
  if (relocation.length > 0) return [value, ...relocation];
  const locality = value.split(",")[0]?.trim() ?? "";
  return locality.length > 1 && locality !== value ? [value, locality] : [value];
}

const SOURCE_QUESTION = /how did you (?:hear|find)|how were you referred|where did you (?:hear|learn)|referral source/;

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
function relocationCandidates(field: FieldDescriptor, value: string): string[] {
  const label = normalizeLabel(field.label);
  if (!label.includes("relocate") && !label.includes("relocation")) return [];
  if (/^(yes|true|1)$/i.test(value.trim())) return ["willing to relocate"];
  if (/^(no|false|0)$/i.test(value.trim())) return ["not willing to relocate"];
  return [];
}

/** True when an option label plausibly represents the requested value. */
export function optionTextMatches(optionText: string, value: string): boolean {
  const option = normalizeOptionText(optionText);
  const expected = normalizeOptionText(value);
  if (option.length === 0 || expected.length === 0) return false;
  if (option === expected) return true;
  // Short values like "no" would otherwise match inside unrelated words.
  if (expected.length <= 3) {
    return option.split(" ").includes(expected);
  }
  if (option.includes(expected) || expected.includes(option)) return true;
  const locality = normalizeOptionText(value.split(",")[0] ?? "");
  return locality.length > 1 && option.startsWith(locality);
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

/** Index of the option best matching any candidate, or -1 when none match. */
export function pickOptionIndex(
  optionTexts: readonly string[],
  candidates: readonly string[],
): number {
  for (const candidate of candidates) {
    const expected = normalizeOptionText(candidate);
    const exact = optionTexts.findIndex((text) => normalizeOptionText(text) === expected);
    if (exact >= 0) return exact;
    const partial = optionTexts.findIndex(
      (text) => optionTextMatches(text, candidate) && !optionNegatesCandidate(text, candidate),
    );
    if (partial >= 0) return partial;
  }
  if (optionTexts.length === 1 && SOLE_OPT_IN_OPTION.test(normalizeOptionText(optionTexts[0] ?? ""))) {
    if (candidates.some((candidate) => AFFIRMATIVE_CANDIDATE.test(normalizeOptionText(candidate)))) {
      return 0;
    }
  }
  return -1;
}

const SOLE_OPT_IN_OPTION = /^(?:i )?(?:acknowledge|agree|accept|consent|certify|confirm|understand)\b/;
const AFFIRMATIVE_CANDIDATE = /^(?:yes|true|agreed?|i agree|acknowledged?|i acknowledge|accept|i accept|consent|i consent)\b/;

function normalizeOptionText(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
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
 */
export function fallbackAnswersForFields(
  fields: readonly FieldDescriptor[],
  answers: readonly DraftAnswer[],
  bank: readonly ApprovedAnswerEntry[],
  resolvePersonalAnswer?: PersonalResolver,
  resolveNarrativeAnswer?: NarrativeResolver,
): DraftAnswer[] {
  const eligible = bank.filter((entry) => entry.allowAutoFill && entry.answer.trim().length > 0);
  if (eligible.length === 0 && !resolvePersonalAnswer && !resolveNarrativeAnswer) return [];

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
    const entry = bestBankEntry(match.field, eligible);
    if (entry) {
      // Radio options arrive one field per option, so a bank answer may only be
      // spent once across them. Standalone controls are independent, and forms
      // do repeat them - two acknowledgement boxes, or "LinkedIn" alongside
      // "LinkedIn Profile" - so there the same answer may serve each field.
      const usedKey = match.field.optionLabel ? entry.key : `${entry.key}#${match.field.selectorIndex}`;
      if (used.has(usedKey) || alreadyAnswered.has(entry.key)) continue;
      used.add(usedKey);
      derived.push({
        questionKey: entry.key,
        // The live label guarantees this answer binds to the field it was chosen for.
        label: match.field.label,
        answer: entry.answer,
        source: "approved-answer",
        citation: `profile.answers.${entry.key}`,
        requiresHuman: false,
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
  const candidates = [haystack, optionText].filter((value) => value.length > 0);
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
];

/** Requires positive ATS confirmation copy before a run is recorded as submitted. */
export function detectSubmissionConfirmation(pageText: string): boolean {
  const haystack = pageText.toLowerCase();
  return SUBMISSION_CONFIRMATION_MARKERS.some((marker) => haystack.includes(marker));
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
