import type { NarrativeTemplate, Profile } from "../domain/profile.js";

/**
 * Narrative templates for open-ended questions.
 *
 * "Why do you want to work here" cannot be answered from a stored string
 * without becoming obvious boilerplate, and it should not be invented by a
 * model either. A template is the middle path: the candidate's own words, with
 * slots filled from the specific posting.
 */

export type NarrativeContext = {
  company: string;
  role: string;
  location: string;
  /** Topics from the posting that the candidate's profile actually supports. */
  topics: string[];
};

/** Renders a list as readable prose rather than a comma-joined fragment. */
export function joinTopics(topics: readonly string[], max = 3): string {
  const chosen = topics.slice(0, max);
  if (chosen.length === 0) return "";
  if (chosen.length === 1) return chosen[0]!;
  if (chosen.length === 2) return `${chosen[0]} and ${chosen[1]}`;
  return `${chosen.slice(0, -1).join(", ")} and ${chosen[chosen.length - 1]}`;
}

export function renderTemplate(template: string, context: NarrativeContext): string {
  return template
    .replace(/\{company\}/g, context.company)
    .replace(/\{role\}/g, context.role)
    .replace(/\{location\}/g, context.location)
    .replace(/\{topics\}/g, joinTopics(context.topics))
    // Collapse artefacts left by an empty slot.
    .replace(/\s+([.,;])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function patternMatches(pattern: string, label: string, company: string): boolean {
  const expanded = pattern.replace(/\{company\}/gi, company).toLowerCase().trim();
  return expanded.length > 0 && label.toLowerCase().includes(expanded);
}

export type NarrativeResolution = {
  answer: string;
  citation: string;
  authorized: boolean;
};

/**
 * Finds a narrative template for a question and renders it. Returns null when
 * nothing matches, or when the posting did not yield enough specific topics to
 * make the answer worth sending.
 */
export function resolveNarrative(
  label: string,
  profile: Profile,
  context: NarrativeContext,
): NarrativeResolution | null {
  const match: NarrativeTemplate | undefined = profile.narratives.find((narrative) =>
    narrative.patterns.some((pattern) => patternMatches(pattern, label, context.company)),
  );
  if (!match) return null;
  if (context.topics.length < match.minTopics) return null;

  const answer = renderTemplate(match.template, context);
  if (answer.trim().length === 0) return null;

  return {
    answer,
    citation: `profile.narratives.${match.key}`,
    authorized: match.allowAutoFill,
  };
}
