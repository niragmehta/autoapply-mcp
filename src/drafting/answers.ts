import type { Campaign } from "../domain/campaign.js";
import type { DraftAnswer } from "../domain/job.js";
import type { Profile } from "../domain/profile.js";
import { classifyQuestion, isBlockedCategory, looksLikeEssay } from "./blockedQuestions.js";
import { resolveNarrative, type NarrativeContext } from "./narrative.js";
import { selectBestOption } from "./options.js";
import { resolvePersonal } from "./personal.js";

/**
 * Answer policy engine.
 *
 * Answers may only come from verified profile data or a pre-approved answer.
 * Anything else is handed back for a human to decide. Nothing is invented here.
 */

export type FormQuestion = {
  key: string;
  label: string;
  required: boolean;
  /** input_text | textarea | multi_value_single_select | input_file | ... */
  type: string;
  options?: string[];
};

const CONTACT_RESOLVERS: ReadonlyArray<readonly [RegExp, (profile: Profile) => string, string]> = [
  [/\bfirst name\b/i, (p) => p.identity.fullName.split(/\s+/)[0] ?? "", "identity.fullName"],
  [/\blast name\b|\bsurname\b|\bfamily name\b/i, (p) => p.identity.fullName.split(/\s+/).slice(1).join(" "), "identity.fullName"],
  [/\bfull name\b|\bpreferred name\b|^name$/i, (p) => p.identity.fullName, "identity.fullName"],
  [/\bemail\b/i, (p) => p.identity.email, "identity.email"],
  [/\bphone\b|\bmobile\b|\btelephone\b/i, (p) => p.identity.phone, "identity.phone"],
  [/\blinkedin\b/i, (p) => p.identity.links.linkedin ?? "", "identity.links.linkedin"],
  [/\bgithub\b/i, (p) => p.identity.links.github ?? "", "identity.links.github"],
  [/\b(?:portfolio|website|personal site)\b/i, (p) => p.identity.links.website ?? "", "identity.links.website"],
  [/\bcity\b/i, (p) => p.identity.location.city, "identity.location.city"],
  [/\b(?:state|province|region)\b/i, (p) => p.identity.location.region, "identity.location.region"],
  [/\bcountry\b/i, (p) => p.identity.location.country, "identity.location.country"],
  [/\blocation\b|\bcurrent location\b/i, (p) => formatLocation(p), "identity.location"],
];

function formatLocation(profile: Profile): string {
  const { city, region, country } = profile.identity.location;
  return [city, region, country].filter((part) => part.length > 0).join(", ");
}

/**
 * Finds the pre-approved answer whose pattern matches most specifically.
 *
 * Longest match wins rather than array order, because sponsorship questions
 * overlap: a generic "do you require sponsorship" answer must not pre-empt the
 * answer written for "...require sponsorship (e.g. H-1B, E-3, TN, O-1...)",
 * which names a route the candidate would in fact use.
 */
function matchApprovedAnswer(profile: Profile, label: string) {
  const haystack = label.toLowerCase();
  let best: { entry: Profile["answers"][number]; length: number } | null = null;
  for (const entry of profile.answers) {
    for (const pattern of entry.patterns) {
      const needle = pattern.toLowerCase();
      if (!haystack.includes(needle)) continue;
      if (!best || needle.length > best.length) best = { entry, length: needle.length };
    }
  }
  return best?.entry;
}

/**
 * An answer may be auto-filled when it is authorized and non-empty, or when it
 * is explicitly marked to be skipped. A blank entry that is neither records
 * that a question is known and still needs a decision.
 */
function canAutoFill(entry: { answer: string; allowAutoFill: boolean; skip?: boolean }): boolean {
  if (entry.skip === true) return true;
  return entry.allowAutoFill && entry.answer.trim().length > 0;
}

/**
 * Resolves a stored answer against the choices a question actually offers.
 * Falls back to the plain answer when the entry declares no alternatives.
 */
function resolveApprovedValue(
  entry: { answer: string; alternatives: string[] },
  question: FormQuestion,
): { value: string; unmatchedChoice: boolean } {
  if (entry.alternatives.length === 0) {
    return { value: entry.answer, unmatchedChoice: false };
  }
  const preferences = [entry.answer, ...entry.alternatives].filter((value) => value.trim().length > 0);
  const match = selectBestOption(preferences, question.options);
  const hadOptions = (question.options?.length ?? 0) > 0;
  return { value: match.value, unmatchedChoice: hadOptions && !match.matchedOption };
}

function blocked(question: FormQuestion, category: string, reason: string, guidance = ""): DraftAnswer {
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

/**
 * Produces a draft answer per question. `requiresHuman` marks anything that a
 * person must confirm before the application can be submitted.
 */
export function draftAnswers(
  questions: readonly FormQuestion[],
  profile: Profile,
  campaign: Campaign,
  context?: NarrativeContext,
): { answers: DraftAnswer[]; blockedQuestions: string[] } {
  const blockedCategories = campaign.submission.blockedQuestionCategories;
  const answers = questions.map((question) => answerOne(question, profile, blockedCategories, context));
  const blockedQuestions = answers.filter((answer) => answer.requiresHuman).map((answer) => answer.label);
  return { answers, blockedQuestions };
}

function answerOne(
  question: FormQuestion,
  profile: Profile,
  blockedCategories: readonly string[],
  context?: NarrativeContext,
): DraftAnswer {
  const category = classifyQuestion(question.label);

  // File uploads are satisfied by attaching the resume, not by a typed answer.
  if (question.type === "input_file") {
    return {
      questionKey: question.key,
      label: question.label,
      answer: "",
      source: "profile",
      citation: "profile.resumes (uploaded as a file)",
      requiresHuman: false,
      category: "attachment",
      guidance: "",
    };
  }

  // Hidden fields are populated by the form's own scripts (geocoding, tokens).
  if (question.type === "input_hidden") {
    return {
      questionKey: question.key,
      label: question.label,
      answer: "",
      source: "profile",
      citation: "populated by the application form",
      requiresHuman: false,
      category: "hidden",
      guidance: "",
    };
  }

  // Work authorization gets the verified statement as a suggestion, but the
  // candidate still confirms it: the wording is legally material.
  if (category === "work-authorization" || category === "sponsorship" || category === "citizenship") {
    const approved = matchApprovedAnswer(profile, question.label);
    const useApproved = approved !== undefined && canAutoFill(approved) && !profile.workAuthorization.alwaysReviewManually;
    return {
      questionKey: question.key,
      label: question.label,
      answer: approved?.answer ?? profile.workAuthorization.statement,
      source: approved ? "approved-answer" : "profile",
      citation: approved ? `profile.answers.${approved.key}` : "profile.workAuthorization.statement",
      requiresHuman: !useApproved,
      category,
      guidance: "",
    };
  }

  // A pre-approved answer is an explicit prior decision, so it can satisfy an
  // otherwise blocked category. Checked before the block so the candidate's own
  // stored choice is honoured.
  const approvedEarly = matchApprovedAnswer(profile, question.label);
  if (approvedEarly && canAutoFill(approvedEarly)) {
    const resolved = resolveApprovedValue(approvedEarly, question);
    return {
      questionKey: question.key,
      label: question.label,
      answer: resolved.value,
      source: "approved-answer",
      citation: `profile.answers.${approvedEarly.key}`,
      // A choice question offering none of the stored preferences is handed
      // back: submitting a value the form does not list would fail.
      requiresHuman: resolved.unmatchedChoice,
      category,
      guidance: resolved.unmatchedChoice
        ? `None of the stored preferences match the offered options: ${(question.options ?? []).join(" | ")}`
        : "",
    };
  }

  // Personal and demographic fields: usable only where the candidate opted that
  // specific field in. Otherwise the stored value is offered as a suggestion
  // and the question still stops for a decision.
  const personal = resolvePersonal(question.label, profile);
  if (personal) {
    return {
      questionKey: question.key,
      label: question.label,
      answer: personal.answer,
      source: "profile",
      citation: personal.citation,
      requiresHuman: !personal.authorized,
      category: personal.category,
      guidance: "",
    };
  }

  if (isBlockedCategory(category, blockedCategories)) {
    // A stored entry for a blocked category still supplies a suggestion and
    // guidance, so the person deciding is not starting from a blank field.
    return blocked(
      question,
      category,
      `category "${category}" always requires a human decision`,
      approvedEarly?.note ?? "",
    );
  }

  const approved = approvedEarly;
  if (approved) {
    return {
      questionKey: question.key,
      label: question.label,
      answer: approved.answer,
      source: "approved-answer",
      citation: `profile.answers.${approved.key}`,
      requiresHuman: !canAutoFill(approved),
      category,
      guidance: canAutoFill(approved) ? "" : approved.note ?? "",
    };
  }

  if (category === "contact") {
    const resolver = CONTACT_RESOLVERS.find(([pattern]) => pattern.test(question.label));
    if (resolver) {
      const value = resolver[1](profile);
      return {
        questionKey: question.key,
        label: question.label,
        answer: value,
        source: "profile",
        citation: resolver[2],
        requiresHuman: value.trim().length === 0 && question.required,
        category,
        guidance: "",
      };
    }
  }

  // Open-ended questions can be answered from a narrative template, which is
  // the candidate's own wording filled in from this specific posting.
  if (context) {
    const narrative = resolveNarrative(question.label, profile, context);
    if (narrative) {
      return {
        questionKey: question.key,
        label: question.label,
        answer: narrative.answer,
        source: "approved-answer",
        citation: narrative.citation,
        requiresHuman: !narrative.authorized,
        category: "narrative",
        guidance: "",
      };
    }
  }

  if (looksLikeEssay(question.label, question.type)) {
    return blocked(question, "essay", "free-text response must be written and approved by a human");
  }

  const soleConsent = soleConsentOption(question);
  if (soleConsent) {
    return {
      questionKey: question.key,
      label: question.label,
      answer: soleConsent,
      source: "approved-answer",
      citation: "profile.answers.acknowledgement (sole offered option)",
      requiresHuman: false,
      category: "acknowledgement",
      guidance: "",
    };
  }

  return blocked(question, category, "no verified profile value or pre-approved answer matches this question");
}

const SOLE_CONSENT_OPTION = /^(?:i )?(?:acknowledge|agree|accept|consent|certify|confirm|understand)\b/;

/**
 * A required choice offering exactly one consent option carries no decision:
 * the sole option is the only submittable value. Returns it so drafting does
 * not block on a field a person could only ever answer one way.
 */
function soleConsentOption(question: FormQuestion): string | undefined {
  if (!question.required) return undefined;
  const options = question.options ?? [];
  if (options.length !== 1) return undefined;
  const only = options[0] ?? "";
  const normalized = only.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  return SOLE_CONSENT_OPTION.test(normalized) ? only : undefined;
}

/** Questions still missing an answer that the form requires. */
export function unresolvedRequired(questions: readonly FormQuestion[], answers: readonly DraftAnswer[]): string[] {
  const byKey = new Map(answers.map((answer) => [answer.questionKey, answer]));
  return questions
    .filter((question) => question.required)
    .filter((question) => {
      const answer = byKey.get(question.key);
      return !answer || answer.answer.trim().length === 0;
    })
    .map((question) => question.label);
}
