import type { DraftAnswer } from "../../domain/job.js";

export function normalizeLabel(label: string): string {
  return label
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
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
  /**
   * The control's DOM id. Greenhouse leaves `name` empty on its repeatable
   * education and employment blocks and carries the meaning in the id instead,
   * as in `school--0` and `end-year--0`, which is the only way to tell which
   * block an "End date year" belongs to.
   */
  domId?: string;
  required: boolean;
  /**
   * What the control already holds. A step the candidate has visited before, or
   * one an employer pre-fills, arrives with values in place: NVIDIA's disability
   * form ships with Language set to English. Reporting those as unanswered
   * stalls a wizard on a question that is already answered.
   */
  value?: string;
  role?: string;
  /**
   * For radios, the text of this single option. The `label` then carries the
   * question the whole group asks, so one approved answer selects one option.
   */
  optionLabel?: string;
  /**
   * Every choice a native `<select>` offers. A required dropdown whose options
   * are employer-specific consent wording - Unity's Global Data Privacy Notice
   * is neither Yes/No nor "I Acknowledge" - otherwise fails with nothing to
   * go on, and the only way forward is guessing at legal text. Reporting the
   * real choices turns that into a decision on the record.
   */
  options?: string[];
  /**
   * Shared by every box of one multi-select question. Ticking any one of them
   * answers the question, so the group is judged together rather than each box
   * counting as its own unmet requirement.
   */
  groupKey?: string;
  /**
   * The question a control sits under, when the control's own label is only a
   * choice. A lone acknowledgement box is labelled "I understand", so without
   * the question above it there is no way to tell what is being agreed to.
   */
  questionLabel?: string;
};

export type FieldMatch = {
  field: FieldDescriptor;
  answer: DraftAnswer | null;
  confidence: number;
};

/**
 * "wish to answer" is a *search key* for finding a decline option in a list,
 * not a value anyone would type. Harvey's Ashby form renders Pronouns as a
 * plain text box, so returning the key unconditionally typed the literal words
 * "wish to answer" into the field and reported it filled. Only controls that
 * offer options can use a search key; a free-text box takes the answer as
 * written.
 */
const OPTION_BEARING_TYPE = /^(?:select|select-one|select-multiple|radio|checkbox)$/;
const OPTION_BEARING_ROLE = /^(?:combobox|listbox|radiogroup|menu)$/;

export function offersOptions(field: FieldDescriptor): boolean {
  return (
    OPTION_BEARING_TYPE.test(field.type) ||
    field.optionLabel !== undefined ||
    (field.role !== undefined && OPTION_BEARING_ROLE.test(field.role))
  );
}

/**
 * A date the candidate signs, as opposed to one they remember.
 *
 * Only the field's own machine name decides this. "Start date" and "End date"
 * are history and belong to the profile; a signature date is today by
 * definition, and no stored answer can ever supply it.
 */
export function signatureDateField(field: FieldDescriptor): boolean {
  if (field.type !== "date") return false;
  const hints = `${field.name} ${field.questionLabel ?? ""}`.toLowerCase();
  // PayPal's acknowledgement asks for it outright: "Please enter today's date
  // on your acknowledgement."
  return /sign/.test(hints) || /\b(?:enter|provide|input) (?:today['\u2019]?s|the current) date\b/i.test(field.label);
}

/**
 * True when the control already holds a real answer.
 *
 * A required field that arrives filled needs nothing from us, and demanding an
 * answer for it stops a wizard on a question the employer already answered.
 * Placeholder text is not an answer.
 */
export const FIELD_PLACEHOLDER_VALUE = /^(select(\.{0,3}| one)?|choose(\.{0,3}| one)?|search|none|-+|mm[ /-]yyyy|yyyy|[my]{2}\/[dm]{2}\/[dy]{4}|[dy]{4}\/[md]{2}\/[dm]{2})$/i;

export function alreadyAnswered(field: FieldDescriptor): boolean {
  // A segmented date control reports its parts on separate lines ("MM\n/\nDD"),
  // so the value is collapsed before it is compared against placeholder text.
  const value = (field.value ?? "")
    .replace(/\s*\/\s*/g, "/")
    .replace(/\s+/g, " ")
    .trim();
  if (value.length === 0) return false;
  return !FIELD_PLACEHOLDER_VALUE.test(value);
}

/**
 * Identifies the option group a control belongs to, or nothing when it stands
 * alone. Radios are grouped by their shared `name`, which the browser already
 * enforces; checkboxes have independent names, so they are grouped by the
 * structural `groupKey` derived from the surrounding question.
 */
export function groupIdentity(field: FieldDescriptor): string | undefined {
  if (!field.optionLabel) return undefined;
  if (field.type === "radio") return field.name.length > 0 ? `radio:${field.name}` : undefined;
  if (field.type === "checkbox") return field.groupKey ? `checkbox:${field.groupKey}` : undefined;
  return undefined;
}
