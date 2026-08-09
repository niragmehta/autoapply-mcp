import { describe, expect, it } from "vitest";

import type { DraftAnswer } from "../src/domain/job.js";
import type { FormQuestion } from "../src/drafting/answers.js";
import {
  isConditionalFollowUp,
  isNegativeAnswer,
  resolveConditionalFollowUps,
} from "../src/drafting/conditionalFollowUps.js";

function question(key: string, label: string, type = "input_text"): FormQuestion {
  return { key, label, required: true, type };
}

function answer(questionKey: string, label: string, value: string, requiresHuman = false): DraftAnswer {
  return {
    questionKey,
    label,
    answer: value,
    source: requiresHuman ? "blocked" : "approved-answer",
    citation: "",
    requiresHuman,
    required: true,
  };
}

describe("conditional follow-ups", () => {
  it("recognises the precondition-only labels employers actually use", () => {
    expect(isConditionalFollowUp("If yes, please describe: ")).toBe(true);
    expect(isConditionalFollowUp("If so, please explain")).toBe(true);
    expect(isConditionalFollowUp("If any, list them")).toBe(true);
    expect(isConditionalFollowUp("If you answered yes above, please elaborate")).toBe(true);
    expect(isConditionalFollowUp("If applicable, provide details")).toBe(true);
  });

  it("does not treat a real question that merely starts with 'if' as a follow-up", () => {
    // Stripe's actual label. It asks for a city and must never resolve blank.
    expect(isConditionalFollowUp("If located in the US, in what city and state do you reside?")).toBe(false);
    expect(isConditionalFollowUp("If this role offers remote work, do you plan to work remotely?")).toBe(false);
  });

  it("reads only a plain negative as negative", () => {
    expect(isNegativeAnswer("No")).toBe(true);
    expect(isNegativeAnswer("no.")).toBe(true);
    expect(isNegativeAnswer("N/A")).toBe(true);
    expect(isNegativeAnswer("None")).toBe(true);
    expect(isNegativeAnswer("Yes")).toBe(false);
    expect(isNegativeAnswer("No, but I held a similar role at Microsoft")).toBe(false);
  });

  it("resolves Okta's three follow-ups because each parent was answered No", () => {
    const questions = [
      question("q_relations", "To the best of your knowledge, do you have any family members at Okta?"),
      question("q_relations_detail", "If yes, please identify name of person / vendor and describe relationship: "),
      question("q_outside", "Do you have any outside business activity(ies)?"),
      question("q_outside_detail", "If yes, please describe: "),
    ];
    const drafted = [
      answer("q_relations", questions[0]!.label, "No"),
      answer("q_relations_detail", questions[1]!.label, "", true),
      answer("q_outside", questions[2]!.label, "No"),
      answer("q_outside_detail", questions[3]!.label, "", true),
    ];

    const resolved = resolveConditionalFollowUps(questions, drafted);

    expect(resolved[1]!.requiresHuman).toBe(false);
    expect(resolved[1]!.answer).toBe("");
    expect(resolved[1]!.citation).toMatch(/answered "No"/);
    expect(resolved[3]!.requiresHuman).toBe(false);
  });

  it("leaves a follow-up blocked when the parent said yes", () => {
    const questions = [
      question("q_parent", "Do you have any outside business activities?"),
      question("q_detail", "If yes, please describe: "),
    ];
    const drafted = [
      answer("q_parent", questions[0]!.label, "Yes"),
      answer("q_detail", questions[1]!.label, "", true),
    ];

    const resolved = resolveConditionalFollowUps(questions, drafted);

    expect(resolved[1]!.requiresHuman).toBe(true);
  });

  it("leaves a follow-up blocked when the parent is itself unresolved", () => {
    const questions = [
      question("q_parent", "Do you have any outside business activities?"),
      question("q_detail", "If yes, please describe: "),
    ];
    const drafted = [
      answer("q_parent", questions[0]!.label, "", true),
      answer("q_detail", questions[1]!.label, "", true),
    ];

    const resolved = resolveConditionalFollowUps(questions, drafted);

    expect(resolved[1]!.requiresHuman).toBe(true);
  });

  it("never resolves a select, which would need an option chosen on the candidate's behalf", () => {
    const questions = [
      question("q_parent", "Do you have any outside business activities?"),
      question("q_detail", "If yes, select the category", "multi_value_single_select"),
    ];
    const drafted = [
      answer("q_parent", questions[0]!.label, "No"),
      answer("q_detail", questions[1]!.label, "", true),
    ];

    const resolved = resolveConditionalFollowUps(questions, drafted);

    expect(resolved[1]!.requiresHuman).toBe(true);
  });

  it("does not disturb an answer that already has content", () => {
    const questions = [
      question("q_parent", "Do you have any outside business activities?"),
      question("q_detail", "If yes, please describe: "),
    ];
    const drafted = [
      answer("q_parent", questions[0]!.label, "No"),
      answer("q_detail", questions[1]!.label, "Advisory role at a startup"),
    ];

    const resolved = resolveConditionalFollowUps(questions, drafted);

    expect(resolved[1]!.answer).toBe("Advisory role at a startup");
  });

  it("resolves a run of follow-ups that all hang off one negative question", () => {
    const questions = [
      question("q_parent", "Have you ever been subject to a restrictive covenant?"),
      question("q_a", "If yes, please describe: "),
      question("q_b", "If so, when did it expire?"),
    ];
    const drafted = [
      answer("q_parent", questions[0]!.label, "No"),
      answer("q_a", questions[1]!.label, "", true),
      answer("q_b", questions[2]!.label, "", true),
    ];

    const resolved = resolveConditionalFollowUps(questions, drafted);

    expect(resolved[1]!.requiresHuman).toBe(false);
    expect(resolved[2]!.requiresHuman).toBe(false);
  });
});
