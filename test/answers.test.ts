import { describe, expect, it } from "vitest";
import { draftAnswers, unresolvedRequired, type FormQuestion } from "../src/drafting/answers.js";
import { classifyQuestion, questionCore } from "../src/drafting/blockedQuestions.js";
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

describe("optional questions do not gate approval", () => {
  const pronouns = question("Please share your gender pronouns.", {
    required: false,
    type: "multi_value_multi_select",
    options: ["She / Her", "He / Him", "They / Them", "Other"],
  });
  const clearance = question("Do you hold an active security clearance?", { required: true });

  it("reports an unanswerable optional question without blocking", () => {
    const { blockedQuestions, blockingQuestions } = draftAnswers([pronouns], profile, campaign);
    expect(blockedQuestions).toContain("Please share your gender pronouns.");
    expect(blockingQuestions).toHaveLength(0);
  });

  it("still blocks when the unanswerable question is required", () => {
    const { blockingQuestions } = draftAnswers([clearance], profile, campaign);
    expect(blockingQuestions).toContain("Do you hold an active security clearance?");
  });

  it("blocks on the required question only when both are present", () => {
    const { blockedQuestions, blockingQuestions } = draftAnswers([pronouns, clearance], profile, campaign);
    expect(blockedQuestions).toHaveLength(2);
    expect(blockingQuestions).toEqual(["Do you hold an active security clearance?"]);
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

describe("authorized narratives on essay questions", () => {
  const narrativeProfile = makeProfile({
    narratives: [
      {
        key: "why-company",
        label: "Why this company",
        patterns: ["why do you want to work"],
        template: "I want to work at {company} on {title}.",
        allowAutoFill: true,
        minTopics: 0,
      },
    ],
  });
  const context = {
    company: "Discord",
    title: "Staff Software Engineer",
    topics: ["platform"],
    trackId: "software-platform",
  };

  it("answers an essay question from the candidate's authorized narrative", () => {
    // "essay" is a blocked category, and that gate ran before the narrative
    // check, so the exact question narratives exist for was always blocked -
    // while the same template filled a field labelled "Cover Letter".
    const q = question("Why do you want to work at Discord?", { required: true, type: "textarea" });
    const { answers } = draftAnswers([q], narrativeProfile, campaign, context);
    expect(answers[0]?.requiresHuman).toBe(false);
    expect(answers[0]?.answer).toContain("Discord");
    expect(answers[0]?.citation).toBe("profile.narratives.why-company");
  });

  it("still blocks an essay when the narrative is not authorized", () => {
    const unauthorized = makeProfile({
      narratives: [
        {
          key: "why-company",
          label: "Why this company",
          patterns: ["why do you want to work"],
          template: "I want to work at {company}.",
          allowAutoFill: false,
          minTopics: 0,
        },
      ],
    });
    const q = question("Why do you want to work at Discord?", { required: true, type: "textarea" });
    const { answers } = draftAnswers([q], unauthorized, campaign, context);
    expect(answers[0]?.requiresHuman).toBe(true);
  });

  it("still blocks an essay no narrative matches", () => {
    const q = question("Describe your proudest achievement.", { required: true, type: "textarea" });
    const { answers } = draftAnswers([q], narrativeProfile, campaign, context);
    expect(answers[0]?.requiresHuman).toBe(true);
  });
});

describe("sole consent option", () => {
  it("auto-selects a required choice offering only an acknowledgement", () => {
    const q = question("Point of Data Transfer", {
      required: true,
      type: "multi_value_single_select",
      options: ["I Acknowledge"],
    });
    const { answers } = draftAnswers([q], profile, campaign);
    expect(answers[0]?.requiresHuman).toBe(false);
    expect(answers[0]?.answer).toBe("I Acknowledge");
    expect(unresolvedRequired([q], answers)).toEqual([]);
  });

  it("still blocks a single option that is a real choice, not a consent", () => {
    const q = question("Which office would you join?", {
      required: true,
      type: "multi_value_single_select",
      options: ["Toronto"],
    });
    const { answers } = draftAnswers([q], profile, campaign);
    expect(answers[0]?.requiresHuman).toBe(true);
  });

  it("does not auto-select a lone consent option on an optional question", () => {
    const q = question("Optional consent", {
      required: false,
      type: "multi_value_single_select",
      options: ["I agree"],
    });
    const { answers } = draftAnswers([q], profile, campaign);
    expect(answers[0]?.requiresHuman).toBe(true);
  });
  it("takes the sole consent option even when an approved answer matched first", () => {
    // Roblox words the only option as a full sentence naming the notice, so a
    // stored "Yes" matches the question but not the option text. The approved
    // answer branch used to return before the sole-consent rule was reached,
    // blocking an application over a field with one submittable value.
    const q = question("Please review and acknowledge Roblox's Job Applicant Privacy Notice", {
      required: true,
      type: "multi_value_single_select",
      options: ["I acknowledge that I have read and understood Roblox's Job Applicant Privacy Notice."],
    });
    const { answers } = draftAnswers([q], profile, campaign);
    expect(answers[0]?.requiresHuman).toBe(false);
    expect(answers[0]?.answer).toBe(
      "I acknowledge that I have read and understood Roblox's Job Applicant Privacy Notice.",
    );
    expect(unresolvedRequired([q], answers)).toEqual([]);
  });

  it("takes the sole consent option when a stored yes matched the question", () => {
    // The live profile stores "Yes" against an acknowledgement pattern. That
    // matches the question but not Roblox's sentence-long option, so the
    // approved-answer branch has to apply the sole-consent rule itself.
    const consenting = {
      ...profile,
      answers: [
        ...profile.answers,
        {
          key: "acknowledgement",
          label: "I acknowledge and agree",
          patterns: ["privacy notice", "i acknowledge"],
          answer: "Yes",
          alternatives: [],
          allowAutoFill: true,
        },
      ],
    };
    const q = question("Please review and acknowledge Roblox's Job Applicant Privacy Notice", {
      required: true,
      type: "multi_value_single_select",
      options: ["I acknowledge that I have read and understood Roblox's Job Applicant Privacy Notice."],
    });
    const { answers } = draftAnswers([q], consenting, campaign);
    expect(answers[0]?.requiresHuman).toBe(false);
    expect(unresolvedRequired([q], answers)).toEqual([]);
  });

  it("never converts a declining stored answer into consent", () => {
    // Demographic questions carry a stored decline. A form offering only
    // "I agree" must not turn that decline into an agreement.
    const q = question("Gender", {
      required: true,
      type: "multi_value_single_select",
      options: ["I agree to be identified"],
    });
    const { answers } = draftAnswers([q], profile, campaign);
    expect(answers[0]?.answer).not.toBe("I agree to be identified");
  });
});
describe("optional choice questions with no matching option", () => {
  const stored = ProfileSchema.parse({
    ...makeProfile(),
    answers: [
      {
        key: "pronouns",
        label: "Pronouns",
        answer: "I prefer not to say",
        patterns: ["pronoun"],
        allowAutoFill: true,
        alternatives: [],
      },
    ],
  });

  function pronounQuestion(required: boolean) {
    return question("Pronouns", {
      required,
      type: "multi_value_single_select",
      options: ["she/her/hers", "he/him/his", "they/them/theirs", "self-describe"],
    });
  }

  it("leaves an optional one blank instead of blocking the application", () => {
    const draft = draftAnswers([pronounQuestion(false)], stored, campaign);
    expect(draft.blockingQuestions).toHaveLength(0);
    const answer = draft.answers.find((entry) => entry.label === "Pronouns");
    expect(answer?.answer).toBe("");
    expect(answer?.requiresHuman).toBe(false);
  });

  it("still stops on a required one rather than sending an unlisted value", () => {
    const draft = draftAnswers([pronounQuestion(true)], stored, campaign);
    expect(draft.blockingQuestions).toContain("Pronouns");
  });
});

describe("conditional question clauses", () => {
  it("asks the question, not its precondition", () => {
    expect(questionCore("If located in the US, in what city and state do you reside?")).toBe(
      "in what city and state do you reside?",
    );
    expect(
      questionCore("If this role offers the option to work from a remote location, do you plan to work remotely?"),
    ).toBe("do you plan to work remotely?");
  });

  it("leaves a label alone when the clause is the whole label", () => {
    expect(questionCore("If applicable")).toBe("If applicable");
    expect(questionCore("If yes, why?")).toBe("If yes, why?");
  });

  it("leaves an ordinary question untouched", () => {
    const label = "What is your current or previous job title?";
    expect(questionCore(label)).toBe(label);
  });

  it("does not answer a city question with a yes/no residence answer", () => {
    const { answers } = draftAnswers(
      [question("If located in the US, in what city and state do you reside?")],
      profile,
      campaign,
    );
    expect(answers[0]?.answer.trim().toLowerCase()).not.toBe("no");
    expect(answers[0]?.answer.trim().toLowerCase()).not.toBe("yes");
  });
});

describe("Greenhouse demographic question shape", () => {
  const declineAll = {
    gender: { value: "Decline to self-identify", autoFill: true },
    pronouns: { value: "I prefer not to say", autoFill: true },
    raceEthnicity: { value: "Decline to self-identify", autoFill: true },
    hispanicLatino: { value: "Decline to self-identify", autoFill: true },
    veteranStatus: { value: "I decline to self-identify for protected veteran status", autoFill: true },
    disabilityStatus: { value: "I don't wish to answer", autoFill: true },
    sexualOrientation: { value: "Decline to self-identify", autoFill: true },
    transgenderIdentity: { value: "Decline to self-identify", autoFill: true },
  };

  // Greenhouse serves these with no `fields` array: the type and choices sit on
  // the question itself. Read with the ordinary parser they look like required
  // free text, which classified a race multi-select as an essay.
  const raw = [
    {
      id: 4000407002,
      label: "Which categories describe you? Select all that apply to you:",
      required: true,
      type: "multi_value_multi_select",
      answer_options: [
        { id: 1, label: "East Asian", free_form: false, decline_to_answer: false },
        { id: 2, label: "South Asian", free_form: false, decline_to_answer: false },
        { id: 3, label: "I don't wish to answer", free_form: false, decline_to_answer: true },
      ],
    },
  ];

  it("reads the type and options that live on the question itself", () => {
    const [parsed] = greenhouseQuestionsToForm(raw as never);
    expect(parsed?.type).toBe("multi_value_multi_select");
    expect(parsed?.options).toEqual(["East Asian", "South Asian", "I don't wish to answer"]);
    expect(parsed?.declineOption).toBe("I don't wish to answer");
  });

  it("answers an unrecognised self-ID question with the employer's own decline option", () => {
    const declining = ProfileSchema.parse({ ...makeProfile(), personal: { demographics: declineAll } });
    const [answer] = draftAnswers(greenhouseQuestionsToForm(raw as never), declining, campaign).answers;
    expect(answer?.answer).toBe("I don't wish to answer");
    expect(answer?.requiresHuman).toBe(false);
  });

  it("asks a candidate who discloses his demographics rather than declining for him", () => {
    const disclosing = ProfileSchema.parse({
      ...makeProfile(),
      personal: { demographics: { ...declineAll, gender: { value: "Male", autoFill: true } } },
    });
    const [answer] = draftAnswers(greenhouseQuestionsToForm(raw as never), disclosing, campaign).answers;
    expect(answer?.requiresHuman).toBe(true);
  });

  it("leaves ordinary field-bearing questions alone", () => {
    const ordinary = [
      { label: "Website", required: false, fields: [{ name: "question_1", type: "input_text", values: [] }] },
    ];
    const [parsed] = greenhouseQuestionsToForm(ordinary as never);
    expect(parsed?.key).toBe("question_1");
    expect(parsed?.declineOption).toBeUndefined();
  });
});
