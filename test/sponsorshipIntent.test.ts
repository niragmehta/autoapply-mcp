import { describe, expect, it } from "vitest";
import { draftAnswers, type FormQuestion } from "../src/drafting/answers.js";
import { fallbackAnswersForFields, pickOptionIndex, type FieldDescriptor } from "../src/submission/formFields.js";
import type { Profile } from "../src/domain/profile.js";
import { makeCampaign, makeProfile } from "./factories.js";

/**
 * Zip asks "Will you now or in the future require sponsorship to work in the
 * country where this role is located?". The longest stored pattern inside that
 * sentence belonged to the authorization answer, so the draft answered "Yes" -
 * telling the employer the candidate needs sponsorship, the opposite of his
 * standing "No". Authorization and sponsorship share most of their wording and
 * take opposite answers, so only an answer written about sponsorship may answer
 * a question asking whether sponsorship is required.
 */
const authorization = {
  key: "auth-country-relative",
  label: "Authorized in the country where the job is located",
  patterns: [
    "work in the country where this role is located",
    "authorized to work in the country where this role is located",
  ],
  answer: "Yes",
  alternatives: [],
  allowAutoFill: true,
};

const sponsorship = {
  key: "visa-sponsorship",
  label: "Require visa sponsorship",
  patterns: ["require sponsorship to work", "require sponsorship"],
  answer: "No",
  alternatives: [],
  allowAutoFill: true,
};

const ZIP = "Will you now or in the future require sponsorship to work in the country where this role is located?";

function profileWith(answers: Profile["answers"]): Profile {
  const base = makeProfile();
  return { ...base, answers, workAuthorization: { ...base.workAuthorization, alwaysReviewManually: false } };
}

function yesNo(label: string): FormQuestion {
  return { key: "sponsorship", label, required: true, type: "multi_value_single_select", options: ["Yes", "No"] };
}

function field(label: string): FieldDescriptor {
  return { selectorIndex: 0, label, type: "text", name: "sponsorship", required: true };
}

describe("sponsorship intent", () => {
  it("answers a sponsorship question from the sponsorship answer, not a longer authorization match", () => {
    const { answers } = draftAnswers([yesNo(ZIP)], profileWith([authorization, sponsorship]), makeCampaign());

    expect(answers[0]?.answer).toBe("No");
    expect(answers[0]?.requiresHuman).toBe(false);
    expect(answers[0]?.citation).toBe("profile.answers.visa-sponsorship");
  });

  it("does the same when filling a live form", () => {
    const answers = fallbackAnswersForFields([field(ZIP)], [], [authorization, sponsorship]);

    expect(answers[0]?.answer).toBe("No");
  });

  it("recognises sponsorship asked with the verb after it", () => {
    const label = "Is sponsorship required for you to work in the country where this role is located?";

    const { answers } = draftAnswers([yesNo(label)], profileWith([authorization, sponsorship]), makeCampaign());

    expect(answers[0]?.answer).toBe("No");
    expect(answers[0]?.requiresHuman).toBe(false);
  });

  it("still answers authorization asked as 'without requiring sponsorship' from the authorization answer", () => {
    const label = "Are you authorized to work in the country where this role is located without requiring sponsorship?";

    const { answers } = draftAnswers([yesNo(label)], profileWith([authorization, sponsorship]), makeCampaign());
    const live = fallbackAnswersForFields([field(label)], [], [authorization, sponsorship]);

    expect(answers[0]?.answer).toBe("Yes");
    expect(answers[0]?.requiresHuman).toBe(false);
    expect(live[0]?.answer).toBe("Yes");
  });

  it("leaves a sponsorship question unanswered when only an authorization answer is on file", () => {
    const { answers } = draftAnswers([yesNo(ZIP)], profileWith([authorization]), makeCampaign());
    const live = fallbackAnswersForFields([field(ZIP)], [], [authorization]);

    expect(answers[0]?.answer).not.toBe("Yes");
    expect(answers[0]?.requiresHuman).toBe(true);
    expect(live).toEqual([]);
  });

  it("does not let an entry written as 'without sponsorship' answer whether sponsorship is required", () => {
    const withoutSponsorship = {
      key: "authorized-without-sponsorship",
      label: "Authorized to work without the need for employer sponsorship",
      patterns: ["without the need for employer sponsorship"],
      answer: "Yes",
      alternatives: [],
      allowAutoFill: true,
    };
    const label =
      "Will you now or in the future require sponsorship to work here? You must be authorized to work without the need for employer sponsorship.";

    const { answers } = draftAnswers([yesNo(label)], profileWith([withoutSponsorship, sponsorship]), makeCampaign());
    const live = fallbackAnswersForFields([field(label)], [], [withoutSponsorship, sponsorship]);

    expect(answers[0]?.answer).toBe("No");
    expect(live[0]?.answer).toBe("No");
  });
});

/**
 * The candidate's standing decision is that a form counting TN as sponsorship is
 * owed a "Yes". It was stored once, under one employer's wording, so CoreWeave's
 * "(e.g. H1-B, H1B1, TN, E3...)" and Ridgeline's "(e.g. H-1B, TN, F1, OPT,
 * etc)" matched only the generic "No" - which the engine rightly refuses for a
 * TN definition - and went to a person to repeat a decision already on file.
 */
describe("sponsorship defined to include TN", () => {
  const namedTn = {
    key: "sponsorship-named-tn",
    label: "Sponsorship where the employer explicitly lists TN",
    patterns: ["h-1b, e-3, tn, o-1", 'commence ("sponsor") an immigration case'],
    answer: "Yes",
    alternatives: [],
    allowAutoFill: true,
  };
  const COREWEAVE =
    "Do you now or will you in the future require sponsorship to work in the United States? (e.g. H1-B, H1B1, TN, E3, CPT, OPT/STEM OPT, H4, J2, or other visa type)";

  it("answers a yes/no question that names TN from the stored TN decision", () => {
    const { answers } = draftAnswers([yesNo(COREWEAVE)], profileWith([sponsorship, namedTn]), makeCampaign());

    expect(answers[0]?.answer).toBe("Yes");
    expect(answers[0]?.requiresHuman).toBe(false);
    expect(answers[0]?.citation).toBe("profile.answers.sponsorship-named-tn");
  });

  it("covers an employer asking to sponsor 'you' for a visa", () => {
    const label = "Will you now, or in the future, require Sentilink to sponsor you for an employment visa (e.g.H-1B, TN, E-3, O-1, etc)?";

    const { answers } = draftAnswers([yesNo(label)], profileWith([sponsorship, namedTn]), makeCampaign());

    expect(answers[0]?.answer).toBe("Yes");
    expect(answers[0]?.requiresHuman).toBe(false);
  });

  it("leaves it to a person when no TN decision is on file", () => {
    const { answers } = draftAnswers([yesNo(COREWEAVE)], profileWith([sponsorship]), makeCampaign());

    expect(answers[0]?.requiresHuman).toBe(true);
    expect(answers[0]?.answer).not.toBe("No");
  });

  it("does not apply it to authorization asked as 'without sponsorship'", () => {
    const label = "Are you authorized to work in the United States without sponsorship (e.g. H-1B, TN)?";

    const { answers } = draftAnswers([yesNo(label)], profileWith([sponsorship, namedTn]), makeCampaign());

    expect(answers[0]?.requiresHuman).toBe(true);
    expect(answers[0]?.answer).not.toBe("Yes");
  });

  it("does not apply it when the choices are more than a plain yes/no", () => {
    const asked: FormQuestion = {
      ...yesNo(COREWEAVE),
      options: ["Yes, I will require sponsorship", "No, I will not require sponsorship", "I am not sure"],
    };

    const { answers } = draftAnswers([asked], profileWith([sponsorship, namedTn]), makeCampaign());

    expect(answers[0]?.requiresHuman).toBe(true);
  });

  it("does not apply it when the form says TN is not counted", () => {
    const label =
      "Will you now or in the future require sponsorship to work in the United States? TN status is not considered sponsorship for this question.";

    const { answers } = draftAnswers([yesNo(label)], profileWith([sponsorship, namedTn]), makeCampaign());

    expect(answers[0]?.answer).not.toBe("Yes");
  });

  it("never lets the TN decision answer a generic sponsorship question, whatever the bank order", () => {
    const label = "Do you need, or will you need in the future, any immigration related support or sponsorship from Abnormal AI?";

    const { answers } = draftAnswers([yesNo(label)], profileWith([namedTn, sponsorship]), makeCampaign());

    expect(answers[0]?.answer).toBe("No");
    expect(answers[0]?.citation).toBe("profile.answers.visa-sponsorship");
  });
});

/**
 * Mintlify asks "Will you now or in the future require visa sponsorship? If yes,
 * select the type of sponsorship." and lists "Yes, TN" beside "Yes, H1B
 * Transfer". TN is named only as one of the choices, and the check for a TN
 * definition wanted TN and "sponsor" in the same text, so the generic "No"
 * answered a form that counts TN as sponsorship - the opposite of his decision.
 */
describe("sponsorship with TN named among the choices", () => {
  const namedTn = {
    key: "sponsorship-named-tn",
    label: "Sponsorship where the employer explicitly lists TN",
    patterns: ["h-1b, e-3, tn, o-1"],
    answer: "Yes",
    alternatives: [],
    allowAutoFill: true,
  };
  const visaSponsorship = { ...sponsorship, patterns: ["require visa sponsorship", "require sponsorship"] };
  const MINTLIFY = "Will you now or in the future require visa sponsorship? If yes, select the type of sponsorship.";
  const MINTLIFY_OPTIONS = ["No", "Yes, H1B Transfer", "Yes, STEM OPT", "Yes, TN", "Yes, H1B Sponsorship", "Yes, other"];
  const typed: FormQuestion = {
    key: "sponsorship",
    label: MINTLIFY,
    required: true,
    type: "multi_value_single_select",
    options: MINTLIFY_OPTIONS,
  };

  it("selects the choice naming TN from the stored TN decision", () => {
    const { answers } = draftAnswers([typed], profileWith([visaSponsorship, namedTn]), makeCampaign());

    expect(answers[0]?.answer).toBe("Yes, TN");
    expect(answers[0]?.requiresHuman).toBe(false);
    expect(answers[0]?.citation).toBe("profile.answers.sponsorship-named-tn");
  });

  it("does not let the generic answer choose from the list when no TN decision is on file", () => {
    const { answers } = draftAnswers([typed], profileWith([visaSponsorship]), makeCampaign());

    expect(answers[0]?.requiresHuman).toBe(true);
    expect(answers[0]?.answer).not.toBe("No");
  });

  it("leaves it to a person when the choice naming TN denies needing sponsorship", () => {
    const asked: FormQuestion = { ...typed, options: ["Yes", "No", "No, I will work under TN status"] };

    const { answers } = draftAnswers([asked], profileWith([visaSponsorship, namedTn]), makeCampaign());

    expect(answers[0]?.requiresHuman).toBe(true);
  });

  it("keeps the generic answer for a list of visa types that leaves TN out", () => {
    const asked: FormQuestion = { ...typed, options: ["No", "Yes, H1B Transfer", "Yes, STEM OPT", "Yes, other"] };

    const { answers } = draftAnswers([asked], profileWith([visaSponsorship, namedTn]), makeCampaign());

    expect(answers[0]?.answer).toBe("No");
    expect(answers[0]?.requiresHuman).toBe(false);
  });

  it("lands the drafted TN choice on the matching option of a live list", () => {
    expect(pickOptionIndex(MINTLIFY_OPTIONS, ["Yes, TN"])).toBe(3);
  });

  it("keeps the generic answer when the question is about remaining where he lives now", () => {
    // GitLab: he lives in Canada, where he needs no visa, whatever the list offers for the US.
    const asked: FormQuestion = {
      ...typed,
      label: "Will you now or in the future require sponsorship for a visa to remain in your current location?",
      options: [
        "No",
        "Yes, Netherlands Highly Skilled Migrant Visa",
        "Yes, EU Blue Card",
        "Yes, USMCA Professional (TN) Visa (USA)",
        "Yes, F-1 Visa OPT (USA)",
        "Yes, but not one of the visas listed here",
      ],
    };

    const { answers } = draftAnswers([asked], profileWith([visaSponsorship, namedTn]), makeCampaign());

    expect(answers[0]?.answer).toBe("No");
    expect(answers[0]?.citation).toBe("profile.answers.visa-sponsorship");
  });
});

/**
 * The question is the sentence that asks. A preamble stating that candidates
 * "must be authorized to work without the need for employer sponsorship" was
 * read as the question, switched the sponsorship guard off, and the
 * authorization answer's "Yes" told the employer he needs sponsorship.
 */
describe("sponsorship asked after a without-sponsorship preamble", () => {
  const label =
    "Candidates must be authorized to work in the country where this role is located without the need for employer sponsorship. Will you now or in the future require sponsorship?";

  it("is answered from the sponsorship answer", () => {
    const { answers } = draftAnswers([yesNo(label)], profileWith([authorization, sponsorship]), makeCampaign());
    const live = fallbackAnswersForFields([field(label)], [], [authorization, sponsorship]);

    expect(answers[0]?.answer).toBe("No");
    expect(live[0]?.answer).toBe("No");
  });
});
