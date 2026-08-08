import { describe, expect, it } from "vitest";
import { selectBestOption } from "../src/drafting/options.js";
import { draftAnswers, type FormQuestion } from "../src/drafting/answers.js";
import { ProfileSchema } from "../src/domain/profile.js";
import { makeCampaign, makeProfile } from "./factories.js";

const campaign = makeCampaign();

function question(label: string, overrides: Partial<FormQuestion> = {}): FormQuestion {
  return { key: label.toLowerCase().replace(/\W+/g, "_"), label, required: false, type: "input_text", ...overrides };
}

const SOURCE_PREFERENCES = [
  "Friend",
  "Referral",
  "Employee Referral",
  "Word of mouth",
  "Company careers page",
  "Company website",
  "LinkedIn",
  "Other",
];

describe("selectBestOption", () => {
  it("takes the top preference when the field is free text", () => {
    expect(selectBestOption(SOURCE_PREFERENCES).value).toBe("Friend");
    expect(selectBestOption(SOURCE_PREFERENCES).matchedOption).toBe(false);
  });

  it("prefers an exact option match", () => {
    const result = selectBestOption(SOURCE_PREFERENCES, ["LinkedIn", "Friend", "Job board"]);
    expect(result.value).toBe("Friend");
    expect(result.matchedOption).toBe(true);
  });

  it("falls to the next preference when the first is not offered", () => {
    expect(selectBestOption(SOURCE_PREFERENCES, ["LinkedIn", "Job board", "Referral"]).value).toBe("Referral");
    expect(selectBestOption(SOURCE_PREFERENCES, ["LinkedIn", "Job board"]).value).toBe("LinkedIn");
  });

  it("matches an option that contains the preference", () => {
    const result = selectBestOption(SOURCE_PREFERENCES, ["Employee Referral (current employee)", "Indeed"]);
    expect(result.value).toBe("Employee Referral (current employee)");
  });

  it("keeps preference order ahead of match looseness", () => {
    // "Referral" outranks "LinkedIn", even though LinkedIn matches exactly and
    // Referral only matches as a substring.
    const result = selectBestOption(SOURCE_PREFERENCES, ["LinkedIn", "Referral from an employee"]);
    expect(result.value).toBe("Referral from an employee");
  });

  it("reports no match when the options offer nothing suitable", () => {
    const result = selectBestOption(["Friend", "Referral"], ["Indeed", "Glassdoor", "University fair"]);
    expect(result.value).toBe("");
    expect(result.matchedOption).toBe(false);
  });

  it("handles empty preference lists", () => {
    expect(selectBestOption([], ["A", "B"]).value).toBe("");
    expect(selectBestOption(["   "]).value).toBe("");
  });

  it("ignores case and punctuation", () => {
    expect(selectBestOption(["company careers page"], ["Company Careers Page"]).value).toBe("Company Careers Page");
  });
});

describe("preference lists in draftAnswers", () => {
  const profile = ProfileSchema.parse({
    ...makeProfile(),
    answers: [
      {
        key: "source",
        label: "How did you hear about us?",
        patterns: ["how did you hear", "where have you learned about"],
        answer: "Friend",
        alternatives: SOURCE_PREFERENCES,
        allowAutoFill: true,
      },
      {
        key: "employed-before",
        label: "Previously employed here",
        patterns: ["worked for", "been employed by"],
        answer: "No",
        allowAutoFill: true,
      },
      {
        key: "employed-microsoft",
        label: "Previously employed at Microsoft",
        patterns: ["worked for microsoft", "employed by microsoft", "worked at microsoft"],
        answer: "Yes",
        allowAutoFill: true,
      },
    ],
  });

  it("uses the top preference on a free-text source question", () => {
    const { answers } = draftAnswers([question("How did you hear about us?")], profile, campaign);
    expect(answers[0]?.answer).toBe("Friend");
    expect(answers[0]?.requiresHuman).toBe(false);
  });

  it("falls back through the list against a dropdown", () => {
    const { answers } = draftAnswers(
      [question("Where have you learned about us?", { type: "multi_value_single_select", options: ["LinkedIn", "Job board", "Company careers page"] })],
      profile,
      campaign,
    );
    expect(answers[0]?.answer).toBe("Company careers page");
  });

  it("hands back a required dropdown that offers none of the preferences", () => {
    const { answers } = draftAnswers(
      [
        question("How did you hear about us?", {
          required: true,
          type: "multi_value_single_select",
          options: ["Indeed", "Glassdoor"],
        }),
      ],
      profile,
      campaign,
    );
    expect(answers[0]?.requiresHuman).toBe(true);
    expect(answers[0]?.guidance).toContain("Indeed");
  });

  it("answers prior employment No by default", () => {
    const { answers } = draftAnswers([question("Have you ever worked for this company?")], profile, campaign);
    expect(answers[0]?.answer).toBe("No");
  });

  it("answers Yes when the question names Microsoft explicitly", () => {
    for (const label of [
      "Have you ever worked for Microsoft?",
      "Have you been employed by Microsoft or any of its subsidiaries?",
      "Have you worked at Microsoft in the past?",
    ]) {
      const { answers } = draftAnswers([question(label)], profile, campaign);
      expect(answers[0]?.answer, label).toBe("Yes");
    }
  });
});
