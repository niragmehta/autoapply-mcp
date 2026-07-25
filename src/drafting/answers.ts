import type { Campaign } from "../domain/campaign.js";
import type { DraftAnswer } from "../domain/job.js";
import type { Profile } from "../domain/profile.js";
import { classifyQuestion, isBlockedCategory, looksLikeEssay } from "./blockedQuestions.js";

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

function matchApprovedAnswer(profile: Profile, label: string) {
  const haystack = label.toLowerCase();
  return profile.answers.find((entry) => entry.patterns.some((pattern) => haystack.includes(pattern.toLowerCase())));
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
): { answers: DraftAnswer[]; blockedQuestions: string[] } {
  const blockedCategories = campaign.submission.blockedQuestionCategories;
  const answers = questions.map((question) => answerOne(question, profile, blockedCategories));
  const blockedQuestions = answers.filter((answer) => answer.requiresHuman).map((answer) => answer.label);
  return { answers, blockedQuestions };
}

function answerOne(question: FormQuestion, profile: Profile, blockedCategories: readonly string[]): DraftAnswer {
  const category = classifyQuestion(question.label);

  // Work authorization gets the verified statement as a suggestion, but the
  // candidate still confirms it: the wording is legally material.
  if (category === "work-authorization" || category === "sponsorship" || category === "citizenship") {
    const approved = matchApprovedAnswer(profile, question.label);
    const useApproved = approved?.allowAutoFill === true && !profile.workAuthorization.alwaysReviewManually;
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

  if (isBlockedCategory(category, blockedCategories)) {
    return blocked(question, category, `category "${category}" always requires a human decision`);
  }

  const approved = matchApprovedAnswer(profile, question.label);
  if (approved) {
    return {
      questionKey: question.key,
      label: question.label,
      answer: approved.answer,
      source: "approved-answer",
      citation: `profile.answers.${approved.key}`,
      requiresHuman: !approved.allowAutoFill,
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
