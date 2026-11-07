import type { DraftAnswer } from "../../domain/job.js";
import { workdayDateLabel } from "../workdayDates.js";
import { DECLINE_ANSWER_PATTERN } from "./answerVocabulary.js";
import { isIncompatible } from "./compatibility.js";
import { normalizeLabel, offersOptions, type FieldDescriptor, type FieldMatch } from "./fieldModel.js";
import { MIN_CONFIDENCE, semanticSimilarity, similarity, statesOwnLocation } from "./similarity.js";

/**
 * The page extractor keeps only the first 200 characters of a label, while the
 * drafted answer carries the question exactly as the board's API published it.
 * A long acknowledgement is therefore compared as a fragment that usually ends
 * mid-word - Waymo's interview-assistance policy arrived as "...but is not lim"
 * - so whole-phrase containment fails and word overlap with the full text falls
 * under the confidence floor. The required question was reported unfillable
 * while its approved answer sat unused in the packet.
 *
 * A long label that the answer's own question text begins with is that
 * question. Two answers beginning the same way leave the page's words unable to
 * say which one is meant, so neither is chosen. Short labels are excluded: a
 * brief prompt that merely starts another question is not evidence of a cut.
 *
 * The cut can also sit on the answer's side. Ashby labels were cut at 200
 * characters until they were kept whole, and a question a run could not fill
 * was recorded for a person under the label the page gave it then.
 */
export const TRUNCATED_LABEL_MIN_LENGTH = 150;

function truncatedLabelAnswer(field: FieldDescriptor, answers: readonly DraftAnswer[]): DraftAnswer | undefined {
  const fieldLabel = normalizeLabel(field.label);
  const cutOff = answers.filter((answer) => {
    const answerLabel = normalizeLabel(answer.label);
    if (answerLabel.length === fieldLabel.length) return false;
    const [shorter, longer] =
      answerLabel.length < fieldLabel.length ? [answerLabel, fieldLabel] : [fieldLabel, answerLabel];
    return shorter.length >= TRUNCATED_LABEL_MIN_LENGTH && longer.startsWith(shorter);
  });
  return cutOff.length === 1 ? cutOff[0] : undefined;
}

/**
 * An aborted run records each unanswered question into the packet with no
 * answer. At equal confidence that placeholder must not beat an answer that
 * says something: Adobe's recorded "Country Phone Code*" outranked the phone
 * country derived from the approved number, and the field went unanswered.
 */
function hasAnswerText(answer: DraftAnswer): number {
  return answer.answer.trim().length > 0 ? 1 : 0;
}

/** Pairs each detected form field with the best matching drafted answer. */
export function matchFields(fields: readonly FieldDescriptor[], answers: readonly DraftAnswer[]): FieldMatch[] {
  return fields.map((original) => {
    const scopedLabel = original.type === "date" ? workdayDateLabel(original.domId) : null;
    const field = scopedLabel ? { ...original, label: scopedLabel } : original;
    const compatible = answers.filter(
      (answer) =>
        (answer.fieldIndex === undefined || answer.fieldIndex === original.selectorIndex) && !isIncompatible(field, answer),
    );
    const scored = compatible
      .map((answer) => ({
        answer,
        confidence: Math.max(
          similarity(field.label, answer.label),
          similarity(field.name, answer.questionKey),
          semanticSimilarity(field, answer),
        ),
      }))
      .sort((a, b) => b.confidence - a.confidence || hasAnswerText(b.answer) - hasAnswerText(a.answer));

    const best = scored[0];
    if (!best || best.confidence < MIN_CONFIDENCE) {
      const cutOff = truncatedLabelAnswer(field, compatible);
      if (cutOff) return { field, answer: cutOff, confidence: 0.85 };
      return { field, answer: null, confidence: best?.confidence ?? 0 };
    }
    return { field, answer: best.answer, confidence: best.confidence };
  });
}

/** Resolves deterministic field-specific representations from the approved answer. */
export function answerValueForField(field: FieldDescriptor, answer: DraftAnswer): string {
  const fieldLabel = normalizeLabel(field.label);
  const answerLabel = normalizeLabel(answer.label);
  if (fieldLabel === "country" && statesOwnLocation(answerLabel)) {
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
