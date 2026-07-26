import { describe, expect, it } from "vitest";
import { draftAnswers, unresolvedRequired, type FormQuestion } from "../src/drafting/answers.js";
import { classifyQuestion } from "../src/drafting/blockedQuestions.js";
import { greenhouseQuestionsToForm } from "../src/drafting/questions.js";
import { ProfileSchema } from "../src/domain/profile.js";
import { makeCampaign, makeProfile } from "./factories.js";

const profile = makeProfile();
const campaign = makeCampaign();

function question(label: string, overrides: Partial<FormQuestion> = {}): FormQuestion {
  return { key: label.toLowerCase().replace(/\W+/g, "_"), label, required: false, type: "input_text", ...overrides };
}

describe("classifyQuestion", () => {
  it("recognizes sensitive categories", () => {
    expect(classifyQuestion("Are you legally authorized to work in the United States?")).toBe("work-authorization");
    expect(classifyQuestion("Will you now or in the future require sponsorship?")).toBe("sponsorship");
    expect(classifyQuestion("What is your desired salary?")).toBe("compensation");
    expect(classifyQuestion("Do you identify as Hispanic or Latino?")).toBe("demographic");
    expect(classifyQuestion("Are you a protected veteran?")).toBe("veteran");
    expect(classifyQuestion("Do you have a disability?")).toBe("disability");
    expect(classifyQuestion("Have you ever been convicted of a felony?")).toBe("criminal-history");
    expect(classifyQuestion("Do you hold an active security clearance?")).toBe("clearance");
  });

  it("recognizes camel case compliance labels", () => {
    expect(classifyQuestion("DisabilityStatus")).toBe("disability");
    expect(classifyQuestion("VeteranStatus")).toBe("veteran");
    expect(classifyQuestion("HispanicLatino")).toBe("demographic");
    expect(classifyQuestion("Gender")).toBe("demographic");
    expect(classifyQuestion("Race")).toBe("demographic");
  });

  it("recognizes ordinary contact fields", () => {
    expect(classifyQuestion("First Name")).toBe("contact");
    expect(classifyQuestion("Email")).toBe("contact");
    expect(classifyQuestion("LinkedIn Profile")).toBe("contact");
  });

  it("recognizes free-text prompts", () => {
    expect(classifyQuestion("Why do you want to work here?")).toBe("essay");
  });
});

describe("draftAnswers", () => {
  it("fills contact fields from the verified profile", () => {
    const { answers } = draftAnswers([question("First Name"), question("Email")], profile, campaign);
    const first = answers.find((answer) => answer.label === "First Name");
    const email = answers.find((answer) => answer.label === "Email");
    expect(first?.answer).toBe("Alex");
    expect(first?.source).toBe("profile");
    expect(email?.answer).toBe("alex@example.com");
    expect(email?.requiresHuman).toBe(false);
  });

  it("uses pre-approved answers where they match", () => {
    const { answers } = draftAnswers([question("How did you hear about us?")], profile, campaign);
    expect(answers[0]?.answer).toBe("Company careers page");
    expect(answers[0]?.source).toBe("approved-answer");
    expect(answers[0]?.requiresHuman).toBe(false);
  });

  it("suggests the verified authorization statement but still requires a human", () => {
    const { answers } = draftAnswers(
      [question("Are you legally authorized to work in the United States?")],
      profile,
      campaign,
    );
    expect(answers[0]?.answer).toBe(profile.workAuthorization.statement);
    expect(answers[0]?.requiresHuman).toBe(true);
    expect(answers[0]?.citation).toBe("profile.workAuthorization.statement");
  });

  it("blocks demographic, compensation and legal questions", () => {
    const { answers, blockedQuestions } = draftAnswers(
      [
        question("What is your desired salary?"),
        question("Please select your gender"),
        question("I certify the information above is accurate"),
      ],
      profile,
      campaign,
    );
    expect(blockedQuestions).toHaveLength(3);
    expect(answers.every((answer) => answer.requiresHuman)).toBe(true);
    expect(answers.every((answer) => answer.answer === "")).toBe(true);
  });

  it("never invents an answer for an unknown question", () => {
    const { answers } = draftAnswers([question("How many years of Rust experience do you have?")], profile, campaign);
    expect(answers[0]?.answer).toBe("");
    expect(answers[0]?.source).toBe("blocked");
    expect(answers[0]?.requiresHuman).toBe(true);
  });

  it("blocks free-text areas", () => {
    const { answers } = draftAnswers([question("Tell us about a project", { type: "textarea" })], profile, campaign);
    expect(answers[0]?.category).toBe("essay");
    expect(answers[0]?.requiresHuman).toBe(true);
  });

  it("carries a suggestion and guidance on questions it hands back", () => {
    const p = ProfileSchema.parse({
      ...profile,
      answers: [
        {
          key: "ai-policy",
          label: "AI policy",
          patterns: ["ai policy"],
          answer: "",
          allowAutoFill: false,
          note: "Read the employer's exact policy before answering.",
        },
      ],
    });
    const { answers } = draftAnswers([question("AI Policy for Application")], p, campaign);
    expect(answers[0]?.requiresHuman).toBe(true);
    expect(answers[0]?.guidance).toContain("Read the employer");
  });

  it("does not attach guidance to answers it fills automatically", () => {
    const p = ProfileSchema.parse({
      ...profile,
      answers: [
        {
          key: "relocation",
          label: "Relocation assistance",
          patterns: ["relocation assistance"],
          answer: "No",
          allowAutoFill: true,
          note: "No relocation assistance required.",
        },
      ],
    });
    const { answers } = draftAnswers(
      [question("Do you require relocation assistance?")],
      p,
      campaign,
    );
    expect(answers[0]?.requiresHuman).toBe(false);
    expect(answers[0]?.answer).toBe("No");
    expect(answers[0]?.guidance).toBe("");
  });

  it("supplies guidance even for a hard-blocked category", () => {
    const p = ProfileSchema.parse({
      ...profile,
      answers: [
        {
          key: "salary",
          label: "Salary expectation",
          patterns: ["desired salary"],
          answer: "",
          allowAutoFill: false,
          note: "Do not anchor before scope is agreed.",
        },
      ],
    });
    const { answers } = draftAnswers([question("Desired salary")], p, campaign);
    expect(answers[0]?.requiresHuman).toBe(true);
    expect(answers[0]?.guidance).toContain("Do not anchor");
  });

  it("treats file uploads as satisfied by the resume attachment", () => {
    const { answers, blockedQuestions } = draftAnswers(
      [question("Resume/CV", { type: "input_file", required: true })],
      profile,
      campaign,
    );
    expect(answers[0]?.category).toBe("attachment");
    expect(answers[0]?.requiresHuman).toBe(false);
    expect(blockedQuestions).toHaveLength(0);
  });

  it("does not demand human input for hidden form fields", () => {
    const { answers } = draftAnswers(
      [question("Latitude", { type: "input_hidden", required: true })],
      profile,
      campaign,
    );
    expect(answers[0]?.category).toBe("hidden");
    expect(answers[0]?.requiresHuman).toBe(false);
  });
});

describe("greenhouseQuestionsToForm", () => {
  it("prefers the file input for a resume question", () => {
    const [resume] = greenhouseQuestionsToForm([
      {
        label: "Resume/CV",
        required: true,
        fields: [
          { name: "resume", type: "input_file" },
          { name: "resume_text", type: "textarea" },
        ],
      },
    ]);
    expect(resume?.type).toBe("input_file");
    expect(resume?.key).toBe("resume");
  });

  it("prefers the text field for a cover letter so it can be written", () => {
    const [cover] = greenhouseQuestionsToForm([
      {
        label: "Cover Letter",
        required: false,
        fields: [
          { name: "cover_letter", type: "input_file" },
          { name: "cover_letter_text", type: "textarea" },
        ],
      },
    ]);
    expect(cover?.type).toBe("textarea");
    expect(cover?.key).toBe("cover_letter_text");
  });

  it("keeps select options", () => {
    const [q] = greenhouseQuestionsToForm([
      {
        label: "Do you require sponsorship?",
        required: true,
        fields: [
          {
            name: "question_1",
            type: "multi_value_single_select",
            values: [
              { value: 0, label: "No" },
              { value: 1, label: "Yes" },
            ],
          },
        ],
      },
    ]);
    expect(q?.options).toEqual(["No", "Yes"]);
  });
});

describe("unresolvedRequired", () => {
  it("reports required questions that are still empty", () => {
    const questions = [question("Desired salary", { required: true }), question("Email", { required: true })];
    const { answers } = draftAnswers(questions, profile, campaign);
    expect(unresolvedRequired(questions, answers)).toEqual(["Desired salary"]);
  });
});
