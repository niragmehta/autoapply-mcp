import type { Campaign } from "../domain/campaign.js";
import type { DraftAnswer } from "../domain/job.js";
import type { Profile } from "../domain/profile.js";
import { classifyQuestion, isBlockedCategory, looksLikeEssay } from "./blockedQuestions.js";
import { resolveNarrative, type NarrativeContext } from "./narrative.js";
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

function blocked(question: FormQuestion, category: string, reason: string): DraftAnswer {
  return {
    questionKey: question.key,
    label: question.label,
    answer: "",
    source: "blocked",
    citation: reason,
    requiresHuman: true,
    category,
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
    };
  }

  // A pre-approved answer is an explicit prior decision, so it can satisfy an
  // otherwise blocked category. Checked before the block so the candidate's own
  // stored choice is honoured.
  const approvedEarly = matchApprovedAnswer(profile, question.label);
  if (approvedEarly && canAutoFill(approvedEarly)) {
    return {
      questionKey: question.key,
      label: question.label,
      answer: approvedEarly.answer,
      source: "approved-answer",
      citation: `profile.answers.${approvedEarly.key}`,
      requiresHuman: false,
      category,
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
    };
  }

  if (isBlockedCategory(category, blockedCategories)) {
    return blocked(question, category, `category "${category}" always requires a human decision`);
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
      };
    }
  }

  if (looksLikeEssay(question.label, question.type)) {
    return blocked(question, "essay", "free-text response must be written and approved by a human");
  }

  return blocked(question, category, "no verified profile value or pre-approved answer matches this question");
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
