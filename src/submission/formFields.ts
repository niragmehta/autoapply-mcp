import type { DraftAnswer } from "../domain/job.js";

/**
 * Field matching for web forms, kept free of browser APIs so it can be tested
 * directly.
 */

export function normalizeLabel(label: string): string {
  return label
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

const MIN_CONFIDENCE = 0.6;

/** Pairs each detected form field with the best matching drafted answer. */
export function matchFields(fields: readonly FieldDescriptor[], answers: readonly DraftAnswer[]): FieldMatch[] {
  return fields.map((field) => {
    const scored = answers
      .map((answer) => ({
        answer,
        confidence: Math.max(similarity(field.label, answer.label), similarity(field.name, answer.questionKey)),
      }))
      .sort((a, b) => b.confidence - a.confidence);

    const best = scored[0];
    if (!best || best.confidence < MIN_CONFIDENCE) {
      return { field, answer: null, confidence: best?.confidence ?? 0 };
    }
    return { field, answer: best.answer, confidence: best.confidence };
  });
}

const CAPTCHA_MARKERS = [
  "recaptcha",
  "hcaptcha",
  "turnstile",
  "captcha",
  "are you a robot",
  "verify you are human",
];

/** Detects anti-bot challenges; encountering one always aborts the run. */
export function detectCaptcha(pageHtml: string): boolean {
  const haystack = pageHtml.toLowerCase();
  return CAPTCHA_MARKERS.some((marker) => haystack.includes(marker));
}

export type FillPlan = {
  toFill: FieldMatch[];
  unmatchedRequired: FieldDescriptor[];
  unusedAnswers: DraftAnswer[];
};

/** Builds a plan and reports required fields that nothing can safely fill. */
export function buildFillPlan(fields: readonly FieldDescriptor[], answers: readonly DraftAnswer[]): FillPlan {
  const matches = matchFields(fields, answers);
  const used = new Set(
    matches.filter((match) => match.answer !== null).map((match) => match.answer!.questionKey),
  );
  return {
    toFill: matches.filter((match) => match.answer !== null && match.answer.answer.trim().length > 0),
    unmatchedRequired: matches
      .filter((match) => match.field.required && (match.answer === null || match.answer.answer.trim().length === 0))
      .map((match) => match.field),
    unusedAnswers: answers.filter((answer) => !used.has(answer.questionKey)),
  };
}
