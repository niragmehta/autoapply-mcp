import { classifyQuestion } from "../../drafting/blockedQuestions.js";

/**
 * Which answers in the library are legally material, and the one question that
 * is never answered for the candidate.
 *
 * Work authorization, visa sponsorship, citizenship and US person status, and
 * voluntary self-identification are locked: the dashboard changes them only
 * after an explicit unlock that names what the answer is used for. The AI-policy
 * question ("did you use AI in this application?") always stays "ask me",
 * because employers' policies differ and the honest answer depends on each one.
 */

type AnswerText = { key: string; label: string; patterns: readonly string[] };

export const LOCK_GROUPS = ["work-authorization", "sponsorship", "us-person", "demographics"] as const;
export type LockGroup = (typeof LOCK_GROUPS)[number];

export const LOCK_DESCRIPTIONS: Record<LockGroup, { label: string; consequence: string }> = {
  "work-authorization": {
    label: "Work authorization",
    consequence: "Employers decide whether they can lawfully hire you from this answer. A wrong answer can get an application rejected or an offer withdrawn.",
  },
  sponsorship: {
    label: "Visa sponsorship",
    consequence: "This tells employers whether they must sponsor a visa for you. A wrong answer can disqualify you, or surface as a problem after an offer.",
  },
  "us-person": {
    label: "Citizenship and US person status",
    consequence: "Export-control and citizenship answers are legal statements employers rely on for compliance. A wrong answer can void an offer.",
  },
  demographics: {
    label: "Self-identification",
    consequence: "Voluntary self-identification goes to employers' compliance records. Change it only if you want to disclose differently.",
  },
};

const US_PERSON = /\bu\.?\s?s\.?\s*persons?\b|\bexport[\s-]+control|\bitar\b|\bembargo/i;
const DEMOGRAPHIC =
  /\b(?:gender|race|racial|ethnic\w*|hispanic|latin[oax]\w*|pronouns?|sexual orientation|lgbtq\w*|transgender|veteran|military status|disabilit\w*|self[\s-]?identif\w*|self[\s-]?id)\b/i;
const AI_POLICY = [
  /\bai[\s-]+polic(?:y|ies)\b/i,
  /\bai[\s-]+(?:usage|use)[\s-]+attestation\b/i,
  /\bdid you use ai\b/i,
  /\buse of ai in (?:this|your) application\b/i,
  /\bused ai to\b/i,
];

function textsOf(answer: AnswerText): string[] {
  return [answer.key.replace(/[-_]+/g, " "), answer.label, ...answer.patterns].filter((text) => text.trim().length > 0);
}

/** The lock groups an answer belongs to, in a fixed order; empty when it is not locked. */
export function lockGroupsOf(answer: AnswerText): LockGroup[] {
  const groups = new Set<LockGroup>();
  for (const text of textsOf(answer)) {
    const category = classifyQuestion(text);
    if (category === "work-authorization") groups.add("work-authorization");
    if (category === "sponsorship") groups.add("sponsorship");
    if (category === "citizenship" || US_PERSON.test(text)) groups.add("us-person");
    if (DEMOGRAPHIC.test(text)) groups.add("demographics");
  }
  return LOCK_GROUPS.filter((group) => groups.has(group));
}

export type AnswerLock = { groups: LockGroup[]; labels: string[]; consequence: string };

export function lockOf(answer: AnswerText): AnswerLock | null {
  const groups = lockGroupsOf(answer);
  if (!groups.length) return null;
  return {
    groups,
    labels: groups.map((group) => LOCK_DESCRIPTIONS[group].label),
    consequence: groups.map((group) => LOCK_DESCRIPTIONS[group].consequence).join(" "),
  };
}

export function isAiPolicyQuestion(answer: AnswerText): boolean {
  return textsOf(answer).some((text) => AI_POLICY.some((pattern) => pattern.test(text)));
}

type AnswerSetting = { answer: string; allowAutoFill: boolean; skip: boolean; alternatives: readonly string[]; whenNoDecline?: string | undefined };

/** What would stop the AI-policy question being asked every time; empty when it stays "ask me". */
export function aiPolicyProblems(answer: AnswerSetting): string[] {
  return [
    answer.answer.trim() ? "it has an answer" : null,
    answer.allowAutoFill ? "it may fill in without asking" : null,
    answer.skip ? "it is set to be left blank" : null,
    answer.alternatives.length ? "it has fallback choices" : null,
    answer.whenNoDecline?.trim() ? "it has a forced choice" : null,
  ].filter((problem): problem is string => problem !== null);
}
