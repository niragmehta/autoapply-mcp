import { describe, expect, it } from "vitest";
import type { DraftAnswer } from "../src/domain/job.js";
import { augmentAnswersForBrowser, buildFillPlan, type FieldDescriptor } from "../src/submission/formFields.js";

const answer = (label: string, value: string): DraftAnswer => ({
  questionKey: label, label, answer: value, source: "profile", citation: "verified test fact",
  requiresHuman: false, required: true, category: "general", guidance: "",
});
const field = (label: string): FieldDescriptor => ({
  selectorIndex: 0, label, type: "select", name: "", required: true,
});
const answers = augmentAnswersForBrowser([
  answer("Current Location", "Vancouver, British Columbia, Canada"),
  answer("Are you legally authorized to work in the country of this role?", "Yes"),
  answer("I currently work here", "Yes"),
], "Canada");

describe("country answer scope", () => {
  it.each([
    "Are you of legal age to work in the country in which this position will be based?",
    "If you are offered employment by Adobe, can you provide documentation establishing your identity and right to work in the country where this position will be based?",
    "Do you have experience working in this country?",
    "Country of citizenship",
  ])("does not use a residence-country value for %s", (label) => {
    expect(buildFillPlan([field(label)], answers).toFill).toEqual([]);
  });

  it.each(["Country", "Country / Region", "Country of residence", "Current country"])(
    "retains an actual residence-country control: %s", (label) => {
      expect(buildFillPlan([field(label)], answers).toFill[0]?.answer?.answer).toBe("Canada");
    },
  );

  it("still permits a separately provided answer to a legal-age question", () => {
    const label = "Are you of legal age to work in the country in which this position will be based?";
    expect(buildFillPlan([field(label)], [...answers, answer(label, "Yes")]).toFill[0]?.answer?.answer).toBe("Yes");
  });
});
