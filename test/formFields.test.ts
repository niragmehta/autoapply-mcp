import { describe, expect, it } from "vitest";
import { buildFillPlan, detectCaptcha, matchFields, normalizeLabel, type FieldDescriptor } from "../src/submission/formFields.js";
import type { DraftAnswer } from "../src/domain/job.js";

function field(label: string, overrides: Partial<FieldDescriptor> = {}): FieldDescriptor {
  return { selectorIndex: 0, label, type: "text", name: "", required: false, ...overrides };
}

function answer(label: string, value: string, overrides: Partial<DraftAnswer> = {}): DraftAnswer {
  return {
    questionKey: label.toLowerCase().replace(/\W+/g, "_"),
    label,
    answer: value,
    source: "profile",
    citation: "",
    requiresHuman: false,
    category: "contact",
    ...overrides,
  };
}

describe("normalizeLabel", () => {
  it("strips required markers and punctuation", () => {
    expect(normalizeLabel("First Name *")).toBe("first name");
    expect(normalizeLabel("Email (required)")).toBe("email");
  });
});

describe("matchFields", () => {
  it("matches fields to answers by label", () => {
    const matches = matchFields([field("First Name *"), field("Email")], [answer("First Name", "Alex"), answer("Email", "a@b.co")]);
    expect(matches[0]?.answer?.answer).toBe("Alex");
    expect(matches[1]?.answer?.answer).toBe("a@b.co");
  });

  it("matches by field name when the label is unhelpful", () => {
    const matches = matchFields([field("", { name: "email" })], [answer("Email", "a@b.co")]);
    expect(matches[0]?.answer).not.toBeNull();
  });

  it("leaves unrelated fields unmatched", () => {
    const matches = matchFields([field("Favourite programming language")], [answer("Email", "a@b.co")]);
    expect(matches[0]?.answer).toBeNull();
  });
});

describe("buildFillPlan", () => {
  it("reports required fields nothing can fill", () => {
    const plan = buildFillPlan(
      [field("Email"), field("Desired salary", { required: true })],
      [answer("Email", "a@b.co")],
    );
    expect(plan.toFill).toHaveLength(1);
    expect(plan.unmatchedRequired.map((entry) => entry.label)).toEqual(["Desired salary"]);
  });

  it("excludes answers that are still empty", () => {
    const plan = buildFillPlan([field("Work authorization", { required: true })], [answer("Work authorization", "")]);
    expect(plan.toFill).toHaveLength(0);
    expect(plan.unmatchedRequired).toHaveLength(1);
  });

  it("lists answers that found no field", () => {
    const plan = buildFillPlan([field("Email")], [answer("Email", "a@b.co"), answer("GitHub", "https://github.com/x")]);
    expect(plan.unusedAnswers.map((entry) => entry.label)).toEqual(["GitHub"]);
  });
});

describe("detectCaptcha", () => {
  it("detects common anti-bot widgets", () => {
    expect(detectCaptcha('<div class="g-recaptcha"></div>')).toBe(true);
    expect(detectCaptcha("<iframe src='https://challenges.cloudflare.com/turnstile'></iframe>")).toBe(true);
    expect(detectCaptcha("<form><input name='email'></form>")).toBe(false);
  });
});
