import type { GreenhouseQuestion } from "../sources/greenhouse.js";
import type { FormQuestion } from "./answers.js";

/** Converts ATS question payloads into the neutral FormQuestion shape. */

function asRecordArray(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? (value.filter((item) => typeof item === "object" && item !== null) as Array<Record<string, unknown>>) : [];
}

export function greenhouseQuestionsToForm(questions: readonly GreenhouseQuestion[]): FormQuestion[] {
  return questions.map((question, index) => {
    const fields = asRecordArray(question.fields);
    const primary = fields[0] ?? {};
    const values = asRecordArray(primary.values);
    return {
      key: typeof primary.name === "string" && primary.name.length > 0 ? primary.name : `question_${index}`,
      label: typeof question.label === "string" ? question.label : `Question ${index + 1}`,
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
