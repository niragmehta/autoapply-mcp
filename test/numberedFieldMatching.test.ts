import { describe, expect, it } from "vitest";

import { matchFields, type DraftAnswer, type FieldDescriptor } from "../src/submission/formFields.js";

/**
 * Workday's address block puts "Address Line 1" and "Address Line 2" side by
 * side. The labels differ by one character, so a similarity match bound the
 * street to both and Cisco's form showed the street twice.
 */
function field(label: string, selectorIndex: number): FieldDescriptor {
  return { selectorIndex, label, type: "text", name: "", required: false } as FieldDescriptor;
}

function answer(label: string, value: string): DraftAnswer {
  return {
    questionKey: label,
    label,
    answer: value,
    source: "profile",
    citation: "personal.address.street",
    requiresHuman: false,
    required: false,
    category: "contact",
    guidance: "",
  } as DraftAnswer;
}

function boundAnswer(fields: readonly FieldDescriptor[], answers: readonly DraftAnswer[], label: string) {
  const match = matchFields(fields, answers).find((entry) => entry.field.label === label);
  return match?.answer?.answer;
}

describe("a numbered field only takes its own number's answer", () => {
  const street = answer("Address Line 1", "301-5140 Sanders St");

  it("does not repeat the street on the second address line", () => {
    const fields = [field("Address Line 1", 0), field("Address Line 2", 1)];
    expect(boundAnswer(fields, [street], "Address Line 1")).toBe("301-5140 Sanders St");
    expect(boundAnswer(fields, [street], "Address Line 2")).toBeUndefined();
  });

  it("still fills the line the answer names", () => {
    const fields = [field("Address Line 1", 0)];
    expect(boundAnswer(fields, [street], "Address Line 1")).toBe("301-5140 Sanders St");
  });

  it("keeps a second employer's answer off the first employer", () => {
    const second = answer("Employer 2", "Second Employer Inc");
    const fields = [field("Employer 1", 0), field("Employer 2", 1)];
    expect(boundAnswer(fields, [second], "Employer 1")).toBeUndefined();
    expect(boundAnswer(fields, [second], "Employer 2")).toBe("Second Employer Inc");
  });

  it("leaves unnumbered labels matching as before", () => {
    const fields = [field("Postal Code", 0)];
    const postal = answer("Postal Code", "V5H 1T2");
    expect(boundAnswer(fields, [postal], "Postal Code")).toBe("V5H 1T2");
  });

  it("lets an unnumbered answer fill a numbered field when nothing else claims it", () => {
    // The rule only separates two numbers that disagree; an answer with no
    // slot number is still free to match on its own merits.
    const fields = [field("Address Line 1", 0)];
    const plain = answer("Address", "301-5140 Sanders St");
    expect(boundAnswer(fields, [plain], "Address Line 1")).toBe("301-5140 Sanders St");
  });

  it("does not read a number inside the text as a slot number", () => {
    // "COVID-19" and "Top 5 skills" carry digits that name nothing.
    const fields = [field("Top 5 skills", 0)];
    const skills = answer("Top 5 skills", "Security engineering");
    expect(boundAnswer(fields, [skills], "Top 5 skills")).toBe("Security engineering");
  });
});
