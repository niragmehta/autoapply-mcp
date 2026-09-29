/**
 * Whether a value can answer a free-text question, judged by its shape.
 *
 * Labels only resemble one another; values do not. Jane Street asks "What year
 * did you graduate high school?", and the stored university name matched it on
 * the word "school". It asks for a "University Email Address", and the
 * institution resolver answered that too. Its one-line "Additional information
 * (for source)" took the four-paragraph additional-information essay. Wording
 * cannot separate these from the questions the answers were written for, but
 * the values are unmistakable: a phone box takes digits, an email box takes an
 * address, a year question takes a year, and a single-line box cannot hold
 * paragraphs.
 *
 * Shared by drafting, so the packet a person approves already leaves these
 * blank, and by form filling, which also derives answers from the live page.
 */
export type TextControl = "single-line" | "multi-line";

const PHONE_QUESTION = /\b(?:phone|mobile|cell)\b/;
const EMAIL_QUESTION = /\be-?mail\b/;
// Asks *for* a year. "At least 1 year of experience" mentions one without
// asking for it, so the word alone is not enough.
const YEAR_QUESTION =
  /\b(?:what|which)\s+year\b|^year\b|\byear\s+(?:did|do|does|will|would|were|you)\b|\b(?:graduation|grad|completion|start|end|expected|date)\s+year\b|\byear\s+of\s+(?:graduation|completion|birth)\b/;
const YEAR_VALUE = /\b(?:19|20)\d{2}\b/;
// Riot's "If yes, ... the last year you worked for Riot" is fairly answered "n/a".
const NOT_APPLICABLE = /^(?:n\/?a|not applicable|none)\.?$/i;
const PARAGRAPH_BREAK = /\n\s*\n/;

/** Returns why the value cannot answer the question, or null when it can. */
export function valueShapeMismatch(label: string, control: TextControl, value: string): string | null {
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  const asked = label.toLowerCase();
  // An essay names "mobile" or "email" as its subject ("Describe your mobile
  // security experience"), so only a one-line box is a contact field.
  if (control === "single-line" && PHONE_QUESTION.test(asked)) {
    return (trimmed.match(/\d/g) ?? []).length < 7 ? "a phone field takes a number" : null;
  }
  if (control === "single-line" && EMAIL_QUESTION.test(asked)) {
    return trimmed.includes("@") ? null : "an email field takes an address";
  }
  if (YEAR_QUESTION.test(asked) && !YEAR_VALUE.test(trimmed) && !NOT_APPLICABLE.test(trimmed)) {
    return "a year question takes a year";
  }
  if (control === "single-line" && PARAGRAPH_BREAK.test(value)) {
    return "a single-line field cannot hold paragraphs";
  }
  return null;
}

// A token holding both letters and digits is a code - a postal code, a licence
// number - never a quantity.
const MIXED_CODE_TOKEN = /\b(?=[a-z]*\d)(?=\d*[a-z])[a-z\d]+\b/i;
const DIGIT_GROUP_SEPARATOR = /(\d),(?=\d{3}(?!\d))/g;

/**
 * What a number input can take from an answer, or null when the answer is not
 * a quantity. A number box rejects text, so "5+ years" is typed as the 5 it
 * states. Taking the first run of digits from anything else misstates it:
 * Confluent's "Location - Zip Code" box received "5" from the postal code
 * "V5K 0A1", and "$250,000" would have become a salary of 250.
 */
export function numberInputValue(value: string): string | null {
  const trimmed = value.trim();
  if (MIXED_CODE_TOKEN.test(trimmed)) return null;
  return trimmed.replace(DIGIT_GROUP_SEPARATOR, "$1").match(/-?\d+(?:\.\d+)?/)?.[0] ?? null;
}
