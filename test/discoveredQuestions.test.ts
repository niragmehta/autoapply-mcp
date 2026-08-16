import { describe, expect, it } from "vitest";
import type { DraftAnswer } from "../src/domain/job.js";
import {
  discoveredQuestionKey,
  isDiscoveredQuestionKey,
  mergeDiscoveredQuestions,
} from "../src/submission/discoveredQuestions.js";

function answer(overrides: Partial<DraftAnswer>): DraftAnswer {
  return {
    questionKey: "question_1",
    label: "Email",
    answer: "a@b.com",
    source: "profile",
    citation: "",
    requiresHuman: false,
    required: true,
    category: "general",
    guidance: "",
    ...overrides,
  };
}

describe("questions discovered on the live form", () => {
  it("records an unfillable required field as a question a person can answer", () => {
    const merged = mergeDiscoveredQuestions([], ["How many years of Go experience do you have?"]);

    expect(merged).toHaveLength(1);
    const [question] = merged;
    expect(question.label).toBe("How many years of Go experience do you have?");
    expect(question.requiresHuman).toBe(true);
    expect(question.required).toBe(true);
    expect(question.answer).toBe("");
    expect(question.source).toBe("blocked");
    expect(isDiscoveredQuestionKey(question.questionKey)).toBe(true);
  });

  it("keeps the same key for the same question, so an answer survives the next run", () => {
    const first = mergeDiscoveredQuestions([], ["What would you build first?"]);
    const second = mergeDiscoveredQuestions([], ["What would you build first?"]);

    expect(first[0].questionKey).toBe(second[0].questionKey);
  });

  it("treats whitespace and casing differences as the same question", () => {
    expect(discoveredQuestionKey("Years of  Go experience")).toBe(discoveredQuestionKey("years of go experience"));
  });

  it("does not overwrite an answer a person already supplied", () => {
    const label = "What would you build first?";
    const existing = [
      answer({ questionKey: discoveredQuestionKey(label), label, answer: "A metrics layer", source: "human" }),
    ];

    const merged = mergeDiscoveredQuestions(existing, [label]);

    expect(merged).toHaveLength(1);
    expect(merged[0].answer).toBe("A metrics layer");
    expect(merged[0].source).toBe("human");
  });

  it("does not duplicate a label the packet already carries under another key", () => {
    const existing = [answer({ questionKey: "question_9002", label: "LinkedIn Profile", answer: "" })];

    const merged = mergeDiscoveredQuestions(existing, ["LinkedIn Profile"]);

    expect(merged).toHaveLength(1);
    expect(merged[0].questionKey).toBe("question_9002");
  });

  it("keeps every distinct question from one aborted run and ignores blank labels", () => {
    const merged = mergeDiscoveredQuestions(
      [],
      ["Years of Data Engineering experience?", "   ", "Years of Go experience?"],
    );

    expect(merged.map((entry) => entry.label)).toEqual([
      "Years of Data Engineering experience?",
      "Years of Go experience?",
    ]);
  });

  it("leaves the existing answers untouched", () => {
    const existing = [answer({})];

    const merged = mergeDiscoveredQuestions(existing, ["Something new"]);

    expect(existing).toHaveLength(1);
    expect(merged).toHaveLength(2);
    expect(merged[0]).toEqual(existing[0]);
  });
});
