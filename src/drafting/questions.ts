import type { GreenhouseQuestion } from "../sources/greenhouse.js";
import type { FormQuestion } from "./answers.js";

/** Converts ATS question payloads into the neutral FormQuestion shape. */

function asRecordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? (value.filter((item) => typeof item === "object" && item !== null) as Array<Record<string, unknown>>) : [];
}

/**
 * Chooses the field that actually carries the answer.
 *
 * Greenhouse groups alternatives under one question: "Resume" offers a file
 * input and a textarea, as does "Cover Letter". A resume is satisfied by
 * uploading the PDF, whereas a cover letter is written, so the preferred field
 * type differs by question.
 */
function selectPrimaryField(label: string, fields: Array<Record<string, unknown>>): Record<string, unknown> {
  if (fields.length <= 1) return fields[0] ?? {};
  const typeOf = (field: Record<string, unknown>) => (typeof field.type === "string" ? field.type : "");
  const isResume = /\b(resume|cv)\b/i.test(label);

  if (isResume) {
    const file = fields.find((field) => typeOf(field) === "input_file");
    if (file) return file;
  }
  const order = ["textarea", "input_text", "multi_value_single_select", "multi_value_multi_select", "input_file"];
  for (const wanted of order) {
    const match = fields.find((field) => typeOf(field) === wanted);
    if (match) return match;
  }
  return fields[0] ?? {};
}

/**
 * Greenhouse serves demographic self-identification questions in a different
 * shape from the rest of the application: there is no `fields` array, and the
 * type and choices sit directly on the question as `type` and `answer_options`.
 * Read as an ordinary question that payload looks like a required free-text
 * field with no options, so a race/ethnicity multi-select was classified as an
 * essay and blocked every application carrying one.
 *
 * The options also carry `decline_to_answer`, which names the choice that
 * discloses nothing. That flag is the employer's own marking, so it is more
 * reliable than matching decline wording, and it is preserved on the question.
 */
function demographicShape(
  question: Record<string, unknown>,
): { type: string; options: string[]; declineOption?: string } | null {
  const options = asRecordArray(question.answer_options);
  if (options.length === 0) return null;

  const labels: string[] = [];
  let declineOption: string | undefined;
  for (const option of options) {
    const label = String(option.label ?? "").trim();
    if (label.length === 0) continue;
    labels.push(label);
    if (option.decline_to_answer === true && declineOption === undefined) declineOption = label;
  }
  if (labels.length === 0) return null;

  return {
    type: typeof question.type === "string" ? question.type : "multi_value_single_select",
    options: labels,
    declineOption,
  };
}

export function greenhouseQuestionsToForm(questions: readonly GreenhouseQuestion[]): FormQuestion[] {
  return questions.map((question, index) => {
    const fields = asRecordArray(question.fields);
    const label = typeof question.label === "string" ? question.label : `Question ${index + 1}`;
    const demographic = fields.length === 0 ? demographicShape(question as Record<string, unknown>) : null;
    if (demographic) {
      const id = (question as Record<string, unknown>).id;
      return {
        key: typeof id === "number" || typeof id === "string" ? `question_${id}` : `question_${index}`,
        label,
        required: question.required === true,
        type: demographic.type,
        options: demographic.options,
        ...(demographic.declineOption ? { declineOption: demographic.declineOption } : {}),
      };
    }

    const primary = selectPrimaryField(label, fields);
    const values = asRecordArray(primary.values);
    return {
      key: typeof primary.name === "string" && primary.name.length > 0 ? primary.name : `question_${index}`,
      label,
      required: question.required === true,
      type: typeof primary.type === "string" ? primary.type : "input_text",
      options: values.map((value) => String(value.label ?? "")).filter((label) => label.length > 0),
    };
  });
}

/**
 * Baseline fields common to hosted application forms. Used for boards that do
 * not publish their question schema; the real fields are read from the page
 * during an assisted run.
 */
export function defaultQuestionSet(): FormQuestion[] {
  return [
    { key: "first_name", label: "First Name", required: true, type: "input_text" },
    { key: "last_name", label: "Last Name", required: true, type: "input_text" },
    { key: "email", label: "Email", required: true, type: "input_text" },
    { key: "phone", label: "Phone", required: false, type: "input_text" },
    { key: "resume", label: "Resume/CV", required: true, type: "input_file" },
    { key: "linkedin", label: "LinkedIn Profile", required: false, type: "input_text" },
    { key: "website", label: "Website", required: false, type: "input_text" },
    { key: "location", label: "Current Location", required: false, type: "input_text" },
    {
      key: "work_authorization",
      label: "Are you legally authorized to work in the country of this role?",
      required: false,
      type: "multi_value_single_select",
      options: ["Yes", "No"],
    },
    {
      key: "sponsorship",
      label: "Will you now or in the future require visa sponsorship?",
      required: false,
      type: "multi_value_single_select",
      options: ["Yes", "No"],
    },
  ];
}
