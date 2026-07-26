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

export function greenhouseQuestionsToForm(questions: readonly GreenhouseQuestion[]): FormQuestion[] {
  return questions.map((question, index) => {
    const fields = asRecordArray(question.fields);
    const label = typeof question.label === "string" ? question.label : `Question ${index + 1}`;
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
