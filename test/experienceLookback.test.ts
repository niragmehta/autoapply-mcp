import { describe, expect, it } from "vitest";
import { draftAnswers, type FormQuestion } from "../src/drafting/answers.js";
import { fallbackAnswersForFields, type FieldDescriptor } from "../src/submission/formFields.js";
import { makeCampaign, makeProfile } from "./factories.js";

// "7+ years" normalizes to "7 years", which Amazon's export-control question
// contains, so this entry answered "No" to where the candidate has lived.
const threshold = {
  key: "years-experience-threshold", label: "Do you have N+ years of experience",
  patterns: ["6+ years", "7+ years", "minimum of 7 years"], answer: "No", allowAutoFill: true,
};
const LIVED =
  "In the past 7 years, have you lived or were physically located outside of the US for 12 consecutive months or more? Please only include locations where you would have been located for a minimum of 12 consecutive months.";

function question(label: string): FormQuestion {
  return { key: "q", label, required: true, type: "multi_value_single_select", options: ["Yes", "No"] };
}

describe("years-of-experience answers and lookback windows", () => {
  it("does not draft an experience threshold into a residence question", () => {
    const result = draftAnswers([question(LIVED)], makeProfile({ answers: [threshold] }), makeCampaign());
    expect(result.answers[0]).toMatchObject({ answer: "", requiresHuman: true });
  });

  it("does not fill a residence question from an experience threshold on a live form", () => {
    const field: FieldDescriptor = {
      selectorIndex: 0, type: "radio", name: "LIVED_OUTSIDE_US", required: true, label: LIVED, optionLabel: "No",
    };
    expect(fallbackAnswersForFields([field], [], [threshold])).toEqual([]);
  });

  it("still answers the threshold it was written for", () => {
    const label = "Do you have 7+ years of experience in software engineering?";
    const result = draftAnswers([question(label)], makeProfile({ answers: [threshold] }), makeCampaign());
    expect(result.answers[0]).toMatchObject({ answer: "No", requiresHuman: false });
  });
});
