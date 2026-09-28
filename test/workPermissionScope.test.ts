import { describe, expect, it } from "vitest";
import { draftAnswers, type FormQuestion } from "../src/drafting/answers.js";
import { fallbackAnswersForFields, type FieldDescriptor } from "../src/submission/formFields.js";
import type { Profile } from "../src/domain/profile.js";
import { makeCampaign, makeProfile } from "./factories.js";

const genericPermission = {
  key: "us-work-authorization-now",
  label: "Currently authorized to work in the United States",
  patterns: ["authorized to work"],
  answer: "Yes",
  allowAutoFill: true,
};

const qualifiedQuestions = [
  "Are you authorized to work in the United States for any employer?",
  "Are you currently authorized to work for all employers in the United States on a full-time basis?",
  "Are you authorized to work for any U.S. employer?",
  "Are you authorized to work for any US employer?",
  "Are you currently eligible to work in this country and authorized to work for Navan on an ongoing indefinite basis?",
  "Are you authorized to work in the United States without any restrictions?",
  "Do you have unrestricted authorization to work in the United States?",
  "Are you authorized to work in the United States on a permanent basis?",
] as const;

function profileWithPermissions(answers: Profile["answers"]): Profile {
  const base = makeProfile();
  return { ...base, answers, workAuthorization: { ...base.workAuthorization, alwaysReviewManually: false } };
}

function question(label: string): FormQuestion {
  return { key: "authorization", label, required: true, type: "input_text" };
}

function field(label: string, questionLabel?: string): FieldDescriptor {
  return {
    selectorIndex: 0, label, type: "text", name: "authorization", required: true,
    ...(questionLabel ? { questionLabel } : {}),
  };
}

describe("work authorization scope", () => {
  it.each(qualifiedQuestions)("does not expand a generic approval when drafting: %s", (label) => {
    const profile = profileWithPermissions([genericPermission]);

    const { answers } = draftAnswers([question(label)], profile, makeCampaign());

    expect(answers[0]?.requiresHuman).toBe(true);
    expect(answers[0]?.answer).not.toBe("Yes");
    expect(answers[0]?.guidance).toContain("explicit matching decision");
  });

  it.each(qualifiedQuestions)("does not expand a generic approval in a live form: %s", (label) => {
    const answers = fallbackAnswersForFields([field(label)], [], [genericPermission]);

    expect(answers).toEqual([]);
  });

  it("checks the enclosing question rather than just a generic control label", () => {
    const answers = fallbackAnswersForFields(
      [field("Your answer", qualifiedQuestions[0])],
      [],
      [genericPermission],
    );

    expect(answers).toEqual([]);
  });

  it("does not fall back to generic sponsorship after rejecting qualified authorization", () => {
    const sponsorship = {
      key: "visa-sponsorship",
      label: "Do you require visa sponsorship?",
      patterns: ["require sponsorship"],
      answer: "No",
      allowAutoFill: true,
    };
    const label = "Are you authorized to work for any employer without requiring sponsorship?";

    const answers = fallbackAnswersForFields([field(label)], [], [genericPermission, sponsorship]);
    const drafted = draftAnswers([question(label)], profileWithPermissions([genericPermission, sponsorship]), makeCampaign());

    expect(answers).toEqual([]);
    expect(drafted.answers[0]?.requiresHuman).toBe(true);
    expect(drafted.answers[0]?.answer).not.toBe("Yes");
  });

  it("preserves settled generic work-permission wording", () => {
    const label = "Are you currently eligible to work in the United States?";
    const profile = profileWithPermissions([genericPermission]);

    const { answers } = draftAnswers([question(label)], profile, makeCampaign());
    const live = fallbackAnswersForFields([field(label)], [], [genericPermission]);

    expect(answers[0]?.answer).toBe("Yes");
    expect(answers[0]?.requiresHuman).toBe(false);
    expect(live[0]?.answer).toBe("Yes");
  });

  it("does not confuse a permanent job with permanent authorization", () => {
    const label = "Are you authorized to work in the United States in a permanent role?";

    const { answers } = draftAnswers([question(label)], profileWithPermissions([genericPermission]), makeCampaign());

    expect(answers[0]?.answer).toBe("Yes");
    expect(answers[0]?.requiresHuman).toBe(false);
  });

  it("honors an explicitly approved answer covering the requested scope", () => {
    const label = qualifiedQuestions[0];
    const scoped = { ...genericPermission, label };
    const profile = profileWithPermissions([scoped]);

    const { answers } = draftAnswers([question(label)], profile, makeCampaign());
    const live = fallbackAnswersForFields([field(label)], [], [scoped]);

    expect(answers[0]?.answer).toBe("Yes");
    expect(answers[0]?.requiresHuman).toBe(false);
    expect(live[0]?.answer).toBe("Yes");
  });

  it("does not treat any-employer approval as indefinite authorization", () => {
    const scoped = { ...genericPermission, label: "Authorized to work for any employer" };
    const label = "Are you authorized to work here indefinitely?";
    const profile = profileWithPermissions([scoped]);

    const { answers } = draftAnswers([question(label)], profile, makeCampaign());
    const live = fallbackAnswersForFields([field(label)], [], [scoped]);

    expect(answers[0]?.requiresHuman).toBe(true);
    expect(live).toEqual([]);
  });
});
