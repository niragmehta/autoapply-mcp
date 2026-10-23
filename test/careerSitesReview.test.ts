import { describe, expect, it } from "vitest";
import { contradictedEligibilityAnswers } from "../src/submission/careerSites.js";

const SPONSORSHIP =
  "Your response is mandatory when applying for a U.S.-based position. Do you need, or will you need in the future, any immigration related support or sponsorship from Amazon? This includes visa sponsorship for employment (H-1B, H-1B1, E-3, O-1, or TN)";

function hooks(answers: Record<string, string | null>) {
  return { resolveChoice: (label: string) => answers[label] ?? null };
}

describe("contradictedEligibilityAnswers", () => {
  it("stops a sponsorship answer the record contradicts", () => {
    // Amazon's TN-inclusive question went out as "No" once.
    const problems = contradictedEligibilityAnswers([{ question: SPONSORSHIP, answer: "No" }], hooks({ [SPONSORSHIP]: "Yes" }));

    expect(problems).toHaveLength(1);
    expect(problems[0]).toContain('states "No" but the record answers "Yes"');
  });

  it("passes an answer that agrees with the record", () => {
    expect(contradictedEligibilityAnswers([{ question: SPONSORSHIP, answer: "Yes" }], hooks({ [SPONSORSHIP]: "Yes" }))).toEqual([]);
  });

  it("leaves questions the record does not answer, and non-eligibility questions, alone", () => {
    const stated = [
      { question: SPONSORSHIP, answer: "Yes" },
      { question: "Have you previously applied to Amazon?", answer: "Yes" },
    ];

    expect(contradictedEligibilityAnswers(stated, hooks({ "Have you previously applied to Amazon?": "No" }))).toEqual([]);
  });
});
