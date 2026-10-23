import type { Application, DraftAnswer } from "../domain/job.js";
import { isDiscoveredQuestionKey } from "../submission/discoveredQuestions.js";
import { isAiDetectionPrompt, isReservedForHuman } from "../submission/formFields.js";

/**
 * Boards that publish no question schema - every Workday tenant - reveal their
 * questions only on the live form. Each new posting at the same employer then
 * aborted on the same questions and waited for the same answers again: Etsy's
 * "Are you authorized to work in the job's location?" and its 60-mile radius
 * question cost a 13-minute failed run on every application.
 *
 * An answer a person gave to a question revealed on a board is carried into
 * the next packet for that board and country, citing the application it came
 * from, so the preview shows it and the run starts with it. Only short answers
 * to the employer's own revealed questions travel: free text tends to be
 * written for one role, pay and dates are set per posting, and questions kept
 * for a person - AI policies, arbitration, bot checks - are asked every time.
 */
export const CARRIED_ANSWER_MAX_LENGTH = 80;

const SET_PER_POSTING = /\b(salary|compensation|pay|wages?|rate|start date|available to start|availability|notice period)\b/i;
const MENTIONS_AI = /\b(?:AI|A\.I\.|LLMs?|GenAI)\b|artificial intelligence|generative|chatgpt|copilot/i;

function normalizeLabel(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function carriable(answer: DraftAnswer): boolean {
  const value = answer.answer.trim();
  return (
    isDiscoveredQuestionKey(answer.questionKey) &&
    answer.source === "human" &&
    value.length > 0 &&
    value.length <= CARRIED_ANSWER_MAX_LENGTH &&
    !SET_PER_POSTING.test(answer.label) &&
    !MENTIONS_AI.test(answer.label) &&
    !isReservedForHuman(answer.label) &&
    !isAiDetectionPrompt(answer.label)
  );
}

/**
 * The drafted answers followed by the carried ones. `earlier` is ordered
 * newest first, so when two applications answered a question differently the
 * latest decision stands. Nothing the new packet already answers is replaced.
 */
export function carryEmployerAnswers(drafted: readonly DraftAnswer[], earlier: readonly Application[]): DraftAnswer[] {
  const keys = new Set(drafted.map((answer) => answer.questionKey));
  const labels = new Set(drafted.map((answer) => normalizeLabel(answer.label)));
  const carried: DraftAnswer[] = [];
  for (const application of earlier) {
    for (const answer of application.answers) {
      if (!carriable(answer)) continue;
      const label = normalizeLabel(answer.label);
      if (keys.has(answer.questionKey) || labels.has(label)) continue;
      keys.add(answer.questionKey);
      labels.add(label);
      carried.push({
        ...answer,
        // The control index belonged to the earlier form's layout.
        fieldIndex: undefined,
        citation: `carried from ${application.id}, where it was answered by hand on this board`,
        guidance: `Answered by hand for ${application.id} on this board. Replace it with set_application_content if this posting needs a different answer.`,
      });
    }
  }
  return [...drafted, ...carried];
}
