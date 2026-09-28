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

describe("a run's own diagnostics are not employer questions", () => {
  it("keys a field on the employer's wording, not the note explaining the failure", () => {
    const withNote = mergeDiscoveredQuestions(
      [],
      ['How Did You Hear About Us?* [fill failed: no Workday option matched ["Company Website"]]'],
    );
    const plain = mergeDiscoveredQuestions([], ["How Did You Hear About Us?*"]);
    expect(withNote[0]?.label).toBe("How Did You Hear About Us?*");
    expect(withNote[0]?.questionKey).toBe(plain[0]?.questionKey);
  });

  it("does not rediscover the same field when the failure note changes", () => {
    const first = mergeDiscoveredQuestions([], ["Country Phone Code* [options: [\"+1\"]]"]);
    const answered = first.map((entry) => ({ ...entry, answer: "Canada (+1)", blocked: false }));
    const second = mergeDiscoveredQuestions(answered, [
      "Country Phone Code* [controls: input[text],div[listbox]]",
    ]);
    expect(second).toHaveLength(1);
    expect(second[0]?.answer).toBe("Canada (+1)");
  });

  it("ignores status lines that no employer asked", () => {
    expect(
      mergeDiscoveredQuestions([], [
        "current step 1 of 4 would not advance",
        "Resume/CV (upload did not take)",
      ]),
    ).toHaveLength(0);
  });

  it("strips a diagnostic note that carries no colon", () => {
    const merged = mergeDiscoveredQuestions([], ["Employment end date [control not found]"]);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.label).toBe("Employment end date");
  });

  it("treats a colonless and a colon-bearing note as the same question", () => {
    const first = mergeDiscoveredQuestions([], ["Employment end date [control not found]"]);
    const answered = first.map((entry) => ({ ...entry, answer: "06/2021", blocked: false }));
    const second = mergeDiscoveredQuestions(answered, [
      "Employment end date [controls: div[group],input[text]]",
    ]);
    expect(second).toHaveLength(1);
    expect(second[0]?.answer).toBe("06/2021");
  });

  it("records a question the bank answers when the run still could not fill it", () => {
    // The run already had the bank. A label it reports is one the bank's answer
    // did not fill, so skipping it leaves nothing a person can answer and the
    // next run fails the same way.
    const bank = [{
      key: "background-check-willing",
      label: "Willing to submit to a background check",
      patterns: ["are you willing to submit a background check"],
      answer: "Yes",
      allowAutoFill: true,
    }];
    expect(
      mergeDiscoveredQuestions([], [
        "Are you willing to submit a background check during the hiring process?",
      ], bank),
    ).toHaveLength(1);
  });

  it("treats a field whose answer the page would not say back as the same question", () => {
    const first = mergeDiscoveredQuestions([], ["Country"]);
    const answered = first.map((entry) => ({ ...entry, answer: "Canada", source: "human" as const }));
    const second = mergeDiscoveredQuestions(answered, [
      'Country [answered "Canada" but the page does not say it back]',
    ]);
    expect(second).toHaveLength(1);
    expect(second[0]?.answer).toBe("Canada");
  });

  it("drops a stale block once the bank gains the answer", () => {
    const blocked = mergeDiscoveredQuestions([], [
      "Are you willing to submit a background check during the hiring process?",
    ]);
    expect(blocked).toHaveLength(1);
    const bank = [{
      key: "background-check-willing",
      label: "Willing to submit to a background check",
      patterns: ["are you willing to submit a background check"],
      answer: "Yes",
      allowAutoFill: true,
    }];
    expect(mergeDiscoveredQuestions(blocked, [], bank)).toHaveLength(0);
  });

  it("keeps a block a human already answered by hand", () => {
    const answered = [{
      ...mergeDiscoveredQuestions([], ["Are you willing to submit a background check during the hiring process?"])[0]!,
      answer: "Yes",
    }];
    const bank = [{
      key: "background-check-willing",
      label: "Willing to submit to a background check",
      patterns: ["are you willing to submit a background check"],
      answer: "Yes",
      allowAutoFill: true,
    }];
    expect(mergeDiscoveredQuestions(answered, [], bank)).toHaveLength(1);
  });

  it("still blocks when the bank entry is held back from auto-fill", () => {
    const bank = [{
      key: "ai-policy",
      label: "Use of AI in the application",
      patterns: ["did you use ai"],
      answer: "Yes",
      allowAutoFill: false,
    }];
    expect(mergeDiscoveredQuestions([], ["Did you use AI to complete this application?"], bank))
      .toHaveLength(1);
  });

  it("never clears an AI recording consent from a generic privacy answer", () => {    const bank = [{
      key: "privacy-consent",
      label: "Consent to the privacy notice",
      patterns: ["consent", "privacy notice"],
      answer: "Yes",
      allowAutoFill: true,
    }];
    const labels = [
      "Do you consent to the use of AI to create written transcripts and summaries of your interviews?",
    ];
    expect(mergeDiscoveredQuestions([], labels, bank)).toHaveLength(1);
    // A block already recorded for it is kept, not swept away by the same match.
    const blocked = mergeDiscoveredQuestions([], labels);
    expect(mergeDiscoveredQuestions(blocked, [], bank)).toHaveLength(1);
  });

  it("never clears an arbitration acknowledgement from the bank", () => {
    const bank = [{
      key: "acknowledgement",
      label: "Acknowledgement",
      patterns: ["i acknowledge", "acknowledge"],
      answer: "Yes",
      allowAutoFill: true,
    }];
    expect(
      mergeDiscoveredQuestions([], ["I acknowledge the mutual arbitration agreement"], bank),
    ).toHaveLength(1);
  });

  it("does not record ATS account credentials as employer questions", () => {
    // A signed-out session lands on a create-account screen, whose fields are
    // then reported as required and unfilled. Asking the candidate to answer
    // "Password*" is meaningless, and the blank answer vetoes every later run.
    const labels = ["Email Address*", "Password*", "Verify New Password*"];
    expect(mergeDiscoveredQuestions([], labels)).toHaveLength(0);
  });

  it("drops account-credential blocks left by an earlier run", () => {
    const stale = mergeDiscoveredQuestions([], ["Some employer question?"]).concat({
      questionKey: "discovered_deadbeefdeadbeef",
      label: "Verify New Password*",
      answer: "",
      source: "blocked",
      citation: "",
      requiresHuman: true,
      required: true,
      category: "employer-specific",
      guidance: "",
    });
    const merged = mergeDiscoveredQuestions(stale, []);
    expect(merged.map((answer) => answer.label)).toEqual(["Some employer question?"]);
  });

  it("still records a question that merely mentions email", () => {
    const labels = ["May we contact you at your work email address?"];
    expect(mergeDiscoveredQuestions([], labels)).toHaveLength(1);
  });
});
