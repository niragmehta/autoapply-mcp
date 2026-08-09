import type { DraftAnswer } from "../domain/job.js";
import type { FormQuestion } from "./answers.js";

/**
 * Employers routinely pair a yes/no question with a free-text follow-up that
 * only applies when the answer was yes:
 *
 *   Do you have any outside business activities?   -> No
 *   If yes, please describe:                        -> (nothing to describe)
 *
 * The follow-up carries no question of its own, so no profile answer can ever
 * match it and it blocked the whole application. Okta alone asked three of
 * them, and Okta is not unusual. When the question it depends on was answered
 * negatively there is genuinely nothing to say, so a blank is the correct and
 * complete answer rather than something a person must supply.
 */

/**
 * A label that is only a precondition. "If yes, please describe:" says nothing
 * about what is being described - that lives in the question above it.
 */
const CONDITIONAL_PREFIX =
  /^\s*if\s+(?:yes\b|so\b|any\b|applicable\b|true\b|selected\b|checked\b|you\s+(?:answered|selected|checked)\s+(?:yes|"?yes"?)\b)/i;

/**
 * Only free text. A select or checkbox needs a real option chosen, and picking
 * one on the candidate's behalf would assert something.
 */
const FREE_TEXT_TYPES = new Set(["input_text", "textarea", "text", "long_text", "short_text"]);

/**
 * Deliberately narrow. Anything that is not plainly a "no" leaves the follow-up
 * blocked, because a wrong reading here silently drops a disclosure the
 * employer asked for.
 */
const NEGATIVE_ANSWER = /^(?:no|none|n\/?a|nope|false|not applicable|i have not|i do not|no\.)$/i;

/**
 * What to write when the governing question was answered negatively. Okta's
 * form marks these follow-ups required and refuses a blank, so leaving them
 * empty fails client-side validation on a form that is otherwise complete.
 * "N/A" states only that nothing applies, which is exactly what the negative
 * parent already said, so it asserts nothing new.
 */
const NOT_APPLICABLE_TEXT = "N/A";

export function isConditionalFollowUp(label: string): boolean {
  return CONDITIONAL_PREFIX.test(label);
}

export function isNegativeAnswer(answer: string): boolean {
  return NEGATIVE_ANSWER.test(answer.trim().replace(/[.,;]+$/, ""));
}

/**
 * Resolves conditional follow-ups whose governing question was answered
 * negatively. Returns a new array; nothing is mutated in place.
 *
 * The governing question is the nearest preceding question that actually
 * received an answer. Forms place the two adjacently, and requiring an answered
 * parent means a follow-up to an unresolved question stays blocked rather than
 * quietly resolving off a question nobody answered yet.
 */
export function resolveConditionalFollowUps(
  questions: readonly FormQuestion[],
  answers: readonly DraftAnswer[],
): DraftAnswer[] {
  const questionByKey = new Map(questions.map((question) => [question.key, question]));

  return answers.map((answer, index) => {
    if (!answer.requiresHuman || answer.answer.trim() !== "") return answer;
    if (!isConditionalFollowUp(answer.label)) return answer;

    const question = questionByKey.get(answer.questionKey);
    if (!question || !FREE_TEXT_TYPES.has(question.type)) return answer;

    const governing = findGoverningAnswer(answers, index);
    if (!governing || governing.requiresHuman || !isNegativeAnswer(governing.answer)) return answer;

    return {
      ...answer,
      answer: NOT_APPLICABLE_TEXT,
      source: "profile" as const,
      citation: `not applicable: "${truncate(governing.label)}" answered "${governing.answer}"`,
      requiresHuman: false,
      notApplicable: true,
    };
  });
}

function findGoverningAnswer(answers: readonly DraftAnswer[], index: number): DraftAnswer | undefined {
  for (let i = index - 1; i >= 0; i -= 1) {
    const candidate = answers[i];
    if (!candidate) continue;
    // Skip other blank follow-ups so a run of them all resolve off the one
    // real question that governs them.
    if (candidate.answer.trim() === "" && isConditionalFollowUp(candidate.label)) continue;
    if (candidate.answer.trim() === "") return undefined;
    return candidate;
  }
  return undefined;
}

function truncate(label: string): string {
  const clean = label.trim().replace(/\s+/g, " ");
  return clean.length > 70 ? `${clean.slice(0, 70)}...` : clean;
}
