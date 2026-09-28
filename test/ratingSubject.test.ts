import { describe, expect, it } from "vitest";
import { draftAnswers, type FormQuestion } from "../src/drafting/answers.js";
import { fallbackAnswersForFields, type FieldDescriptor } from "../src/submission/formFields.js";
import { makeCampaign, makeProfile } from "./factories.js";

const companyRating = {
  key: "company-ai-rating", label: "How would you rate this company's position in AI?",
  patterns: ["how would you rate", "position in ai"], answer: "3", allowAutoFill: true,
};
function question(label: string): FormQuestion {
  return { key: "rating", label, required: true, type: "multi_value_single_select", options: ["0", "1", "2", "3", "4", "5"] };
}

describe("rating answer subjects", () => {
  it.each(["Go", "Python", "Rust"])("does not turn an employer rating into a %s skill claim", (language) => {
    const label = `On a scale from 0 to 5, how would you rate yourself in ${language}?`;
    const result = draftAnswers([question(label)], makeProfile({ answers: [companyRating] }), makeCampaign());
    expect(result.answers[0]).toMatchObject({ answer: "", requiresHuman: true });
  });

  it.each(["Go", "Python", "Rust"])("blocks the same %s mismatch in live answer-bank fallback", (language) => {
    const field: FieldDescriptor = {
      selectorIndex: 0, type: "select", name: "rating", required: true,
      label: `On a scale from 0 to 5, how would you rate yourself in ${language}?`,
    };
    expect(fallbackAnswersForFields([field], [], [companyRating])).toEqual([]);
  });

  it("retains the authorized company-impression rating", () => {
    const result = draftAnswers([question(companyRating.label)], makeProfile({ answers: [companyRating] }), makeCampaign());
    expect(result.answers[0]).toMatchObject({ answer: "3", requiresHuman: false });
  });

  it("retains a separately authorized self-rating", () => {
    const personalRating = {
      key: "python-rating", label: "How would you rate yourself in Python?",
      patterns: ["rate yourself in python"], answer: "4", allowAutoFill: true,
    };
    const result = draftAnswers([question(personalRating.label)], makeProfile({ answers: [companyRating, personalRating] }), makeCampaign());
    expect(result.answers[0]).toMatchObject({ answer: "4", requiresHuman: false });
  });
});
