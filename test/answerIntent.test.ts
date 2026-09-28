import { describe, expect, it } from "vitest";
import { draftAnswers, type FormQuestion } from "../src/drafting/answers.js";
import { fallbackAnswersForFields, type FieldDescriptor } from "../src/submission/formFields.js";
import type { Profile } from "../src/domain/profile.js";
import { makeCampaign, makeProfile } from "./factories.js";

function profileWith(answers: Profile["answers"]): Profile {
  return { ...makeProfile(), answers };
}

function yesNo(label: string): FormQuestion {
  return { key: "q", label, required: true, type: "multi_value_single_select", options: ["Yes", "No"] };
}

function choice(label: string, options: string[]): FormQuestion {
  return { key: "q", label, required: true, type: "multi_value_single_select", options };
}

function text(label: string, type: FormQuestion["type"] = "input_text"): FormQuestion {
  return { key: "q", label, required: true, type };
}

function field(label: string, type = "text"): FieldDescriptor {
  return { selectorIndex: 0, label, type, name: "q", required: true };
}

const basedIn = {
  key: "based-in-location",
  label: "Currently based in the role's location",
  patterns: ["currently based in", "are you located in", "do you currently live in"],
  answer: "No - based in Vancouver, Canada and willing to relocate.",
  alternatives: [],
  allowAutoFill: true,
};

const relocate = {
  key: "relocation-willing",
  label: "Open to relocation",
  patterns: ["open to relocation", "willing to relocate"],
  answer: "Yes",
  alternatives: [],
  allowAutoFill: true,
};

/**
 * Watershed asks "Are you located in, or willing to relocate to the SF area?"
 * as a plain Yes/No. The stored residence denial reads "No - based in
 * Vancouver, Canada and willing to relocate.", and a Yes/No control keeps only
 * its first word, so the employer was told "No" by a candidate who is willing to
 * relocate. A question that accepts either residence or relocation is answered
 * by the relocation decision.
 */
describe("residence questions that also accept relocation", () => {
  it.each([
    "This role will be based in our San Francisco office. Are you located in, or willing to relocate to the SF area?",
    "This role is on-site five days a week at SF HQ or the Toronto Hub. Are you currently based in the Bay Area or Greater Toronto Area, or willing to relocate?",
    "Are you located in San Francisco or NYC, and/or willing to relocate?",
    "Do you currently live in, or plan to relocate to, the specified location?",
  ])("answers Yes from the relocation decision: %s", (label) => {
    const { answers } = draftAnswers([yesNo(label)], profileWith([basedIn, relocate]), makeCampaign());

    expect(answers[0]?.answer).toBe("Yes");
    expect(answers[0]?.requiresHuman).toBe(false);
    expect(answers[0]?.citation).toBe("profile.answers.relocation-willing");
  });

  it("never lets the residence denial answer one when no relocation decision is on file", () => {
    const label = "Are you located in, or willing to relocate to the SF area?";

    const { answers } = draftAnswers([yesNo(label)], profileWith([basedIn]), makeCampaign());

    expect(answers[0]?.answer).not.toBe("No");
    expect(answers[0]?.requiresHuman).toBe(true);
  });

  it("keeps the qualified residence answer for free text, which carries the relocation clause", () => {
    const label = "Do you currently live in, or plan to relocate to, the specified location?";

    const { answers } = draftAnswers([text(label)], profileWith([basedIn, relocate]), makeCampaign());

    expect(answers[0]?.answer).toContain("willing to relocate");
  });

  it("does not claim residence through an option list that separates living there from relocating", () => {
    const label = "Are you located in the SF Bay Area, or willing to relocate?";
    const options = ["Yes, I live there", "No, but I am willing to relocate", "No"];

    const { answers } = draftAnswers([choice(label, options)], profileWith([basedIn, relocate]), makeCampaign());

    expect(answers[0]?.answer).toBe("No, but I am willing to relocate");
    expect(answers[0]?.requiresHuman).toBe(false);
  });

  it("still answers a residence-only question with the denial", () => {
    const { answers } = draftAnswers(
      [yesNo("Are you located in San Francisco or New York City?")],
      profileWith([basedIn, relocate]),
      makeCampaign(),
    );

    expect(answers[0]?.answer).toBe("No");
  });
});

const basedOrRelocating = {
  key: "willing-to-relocate-to-role-location",
  label: "Based in or willing to relocate to the role's location",
  patterns: ["or open to relocation", "or willing to relocate"],
  answer: "Yes",
  alternatives: [],
  allowAutoFill: true,
};

const BREX = "Do you currently live in, or plan to relocate to, the specified location?";
const BREX_OPTIONS = ["Yes, I live here", "Yes, I plan to relocate", "No"];
const RIDGELINE =
  "This role is only available in either Reno, NV or San Ramon, CA and is a hybrid role. Are you located in either area or open to relocation?";
const RIDGELINE_OPTIONS = [
  "Yes, I am located in/near the Reno, NV area.",
  "Yes, I am located in/near San Ramon, CA.",
  "I am open to relocation.",
  "I am not open to relocation.",
];

/**
 * Brex and Ridgeline ask the same either-or question but spell the answers out.
 * The residence denial took Brex's "No", telling the employer he would not
 * relocate, and the bare "Yes" of the based-or-relocating answer took
 * Ridgeline's first option, claiming he lives near Reno. Both were submitted.
 * He lives in neither place and has decided to relocate, so the answer is the
 * option that says so without claiming residence.
 */
describe("residence-or-relocation questions that spell the answers out", () => {
  it("takes the option that commits to relocating rather than the bare No", () => {
    const { answers } = draftAnswers([choice(BREX, BREX_OPTIONS)], profileWith([basedIn, relocate]), makeCampaign());

    expect(answers[0]?.answer).toBe("Yes, I plan to relocate");
    expect(answers[0]?.requiresHuman).toBe(false);
    expect(answers[0]?.citation).toBe("profile.answers.relocation-willing");
  });

  it("never claims residence through the first option that opens with Yes", () => {
    const { answers } = draftAnswers(
      [choice(RIDGELINE, RIDGELINE_OPTIONS)],
      profileWith([basedIn, basedOrRelocating, relocate]),
      makeCampaign(),
    );

    expect(answers[0]?.answer).toBe("I am open to relocation.");
  });

  it("asks a person when no single option commits to relocating", () => {
    const { answers } = draftAnswers([choice(BREX, ["Yes, I live here", "No"])], profileWith([basedIn, relocate]), makeCampaign());

    expect(answers[0]?.answer).toBe("");
    expect(answers[0]?.requiresHuman).toBe(true);
  });

  it("asks a person when no relocation decision is on file", () => {
    const { answers } = draftAnswers([choice(BREX, BREX_OPTIONS)], profileWith([basedIn]), makeCampaign());

    expect(answers[0]?.answer).toBe("");
    expect(answers[0]?.requiresHuman).toBe(true);
  });
});

const relocationAssistance = {
  key: "relocation-assistance",
  label: "Do you require relocation assistance",
  patterns: ["require relocation assistance", "relocation assistance"],
  answer: "No",
  alternatives: [],
  allowAutoFill: true,
};

/**
 * Snap asked "Do you currently live in or are you able to relocate to the
 * location this job is advertised in?" on a Workday Yes/No prompt. The live
 * fallback matched "do you currently live in" to the residence denial, and the
 * submitted answer was "No". The live path answers such a field from the
 * relocation decision, as drafting does.
 */
describe("live residence-or-relocation fields", () => {
  const SNAP =
    "Do you currently live in or are you able to relocate to the location this job is advertised in? (Snap may provide relocation assistance)";

  it("answers from the relocation decision, not the residence denial", () => {
    const live = fallbackAnswersForFields(
      [field(SNAP, "select")],
      [],
      [basedIn, relocate, relocationAssistance],
    );

    expect(live).toHaveLength(1);
    expect(live[0]?.questionKey).toBe("relocation-willing");
    expect(live[0]?.answer).toBe("Yes");
  });

  it("leaves the field alone when the only candidate is the residence denial", () => {
    const live = fallbackAnswersForFields([field(SNAP, "select")], [], [basedIn]);

    expect(live).toEqual([]);
  });

  it("keeps the qualified denial for a free-text field", () => {
    const live = fallbackAnswersForFields([field(BREX, "text")], [], [basedIn, relocate]);

    expect(live[0]?.answer).toContain("willing to relocate");
  });
});

const onsite = {
  key: "onsite-willingness",
  label: "Willing to work onsite",
  patterns: ["open to working in-office"],
  answer: "Yes",
  alternatives: [],
  allowAutoFill: true,
};

/**
 * Retell AI asks "Are you open to working in-office 5x per week in the San
 * Francisco area? Retell AI offers relocation assistance to help make the move
 * easier". The only stored pattern in that label was "relocation assistance",
 * from the answer to whether he needs assistance, so the employer was told "No"
 * - he will not work onsite. The assistance answer may only answer a question
 * that asks about assistance.
 */
describe("relocation assistance mentioned but not asked", () => {
  const RETELL =
    "Are you open to working in-office 5x per week in the San Francisco area? Retell AI offers relocation assistance to help make the move easier";

  it("does not answer an onsite question from the relocation-assistance answer", () => {
    const { answers } = draftAnswers([yesNo(RETELL)], profileWith([relocationAssistance]), makeCampaign());
    const live = fallbackAnswersForFields([field(RETELL)], [], [relocationAssistance]);

    expect(answers[0]?.answer).not.toBe("No");
    expect(answers[0]?.requiresHuman).toBe(true);
    expect(live).toEqual([]);
  });

  it("answers it from the onsite answer instead", () => {
    const { answers } = draftAnswers([yesNo(RETELL)], profileWith([relocationAssistance, onsite]), makeCampaign());
    const live = fallbackAnswersForFields([field(RETELL)], [], [relocationAssistance, onsite]);

    expect(answers[0]?.answer).toBe("Yes");
    expect(live[0]?.answer).toBe("Yes");
  });

  it.each([
    "Do you require relocation assistance in order to work in the San Francisco area?",
    "Will you need relocation assistance? We offer a generous package.",
    "Relocation assistance required",
  ])("still answers a question about assistance: %s", (label) => {
    const { answers } = draftAnswers([yesNo(label)], profileWith([relocationAssistance]), makeCampaign());
    const live = fallbackAnswersForFields([field(label)], [], [relocationAssistance]);

    expect(answers[0]?.answer).toBe("No");
    expect(live[0]?.answer).toBe("No");
  });

  it("answers a relocation question whose preamble mentions assistance from the relocation decision", () => {
    // "relocation assistance" is the longer pattern, so without the guard it outranked "willing to relocate".
    const label = "This role is in San Francisco and we offer relocation assistance. Are you willing to relocate?";

    const { answers } = draftAnswers([yesNo(label)], profileWith([relocationAssistance, relocate]), makeCampaign());
    const live = fallbackAnswersForFields([field(label)], [], [relocationAssistance, relocate]);

    expect(answers[0]?.answer).toBe("Yes");
    expect(live[0]?.answer).toBe("Yes");
  });

  it("answers the assistance question on a radio whose option reads only Yes", () => {
    const radio: FieldDescriptor = {
      selectorIndex: 0,
      label: "Do you require relocation assistance?",
      type: "radio",
      name: "q",
      required: true,
      optionLabel: "No",
    };

    const live = fallbackAnswersForFields([radio], [], [relocationAssistance]);

    expect(live[0]?.answer).toBe("No");
  });
});

/**
 * Anysphere asks "Has someone at Cursor or Graphite referred you for this role?
 * If so, please include their email here". The email resolver filled the
 * candidate's own address, which names him as his own referrer.
 */
describe("contact details belonging to someone the question refers to", () => {
  it.each([
    "Has someone at Cursor or Graphite referred you for this role? If so, please include their email here",
    "Did anyone refer you? Please share their name and phone number.",
  ])("does not fill the candidate's own details: %s", (label) => {
    const { answers } = draftAnswers([text(label)], makeProfile(), makeCampaign());

    expect(answers[0]?.answer).not.toContain("alex@example.com");
    expect(answers[0]?.source).not.toBe("profile");
  });

  it("still fills the candidate's own email", () => {
    const { answers } = draftAnswers([text("Please enter your email so we can reach you")], makeProfile(), makeCampaign());

    expect(answers[0]?.answer).toBe("alex@example.com");
  });
});

const whyMulti = {
  key: "why-interested-multi",
  label: "Why are you interested in working here? (select all that apply)",
  patterns: ["why are you interested in working"],
  answer: "Products & Technical Innovation",
  alternatives: [],
  allowAutoFill: true,
};

/**
 * The stored pick for a "select all that apply" list was pasted into Abby
 * Care's essay box, "Why are you interested in working at Abby Care? We read
 * every single answer", as the bare phrase "Products & Technical Innovation".
 * An answer written for a choice list only answers a choice question.
 */
describe("answers written for a choice list", () => {
  const ABBY = "Why are you interested in working at Abby Care? Note: We read every single answer.";

  it("do not answer a free-text question", () => {
    const { answers } = draftAnswers([text(ABBY, "textarea")], profileWith([whyMulti]), makeCampaign());
    const live = fallbackAnswersForFields([field(ABBY, "textarea")], [], [whyMulti]);

    expect(answers[0]?.answer).not.toBe("Products & Technical Innovation");
    expect(live.map((answer) => answer.answer)).not.toContain("Products & Technical Innovation");
  });

  it("still answer the choice question they were written for", () => {
    const { answers } = draftAnswers(
      [
        {
          key: "q",
          label: "Why are you interested in working here?",
          required: true,
          type: "multi_value_multi_select",
          options: ["Products & Technical Innovation", "Mission", "Culture"],
        },
      ],
      profileWith([whyMulti]),
      makeCampaign(),
    );

    expect(answers[0]?.answer).toBe("Products & Technical Innovation");
  });
});

/**
 * A stored "No" to relocating to one named place was discarded as though it
 * were the residence denial, so "Are you located in, or willing to relocate to
 * New York?" took the generic relocation "Yes" instead.
 */
describe("a place-specific relocation decision", () => {
  const noNewYork = {
    key: "relocation-new-york",
    label: "Willing to relocate to New York",
    patterns: ["relocate to new york"],
    answer: "No",
    alternatives: [],
    allowAutoFill: true,
  };

  it("answers a located-in-or-relocate question about that place", () => {
    const label = "Are you located in, or willing to relocate to New York?";

    const { answers } = draftAnswers([yesNo(label)], profileWith([basedIn, relocate, noNewYork]), makeCampaign());

    expect(answers[0]?.answer).toBe("No");
    expect(answers[0]?.citation).toBe("profile.answers.relocation-new-york");
  });
});

/**
 * "Mobile" and "email" name a subject in an essay as readily as a contact
 * detail. The phone and email shape checks blocked an approved essay about
 * mobile security, and with nothing approved the phone resolver answered an
 * email-infrastructure essay with the candidate's address.
 */
describe("essay questions that mention a contact word", () => {
  const mobileEssay = {
    key: "mobile-security-experience",
    label: "Describe your mobile security experience",
    patterns: ["mobile security experience"],
    answer: "I reviewed the threat model for a mobile banking app and hardened its token storage.",
    alternatives: [],
    allowAutoFill: true,
  };

  it("keeps an approved essay answer", () => {
    const { answers } = draftAnswers(
      [text("Describe your mobile security experience.", "textarea")],
      profileWith([mobileEssay]),
      makeCampaign(),
    );

    expect(answers[0]?.answer).toBe(mobileEssay.answer);
    expect(answers[0]?.requiresHuman).toBe(false);
  });

  it.each(["Tell us about your email infrastructure work.", "Describe your mobile development experience."])(
    "does not answer %s with a contact detail",
    (label) => {
      const { answers } = draftAnswers([text(label, "textarea")], makeProfile(), makeCampaign());

      expect(answers[0]?.source).not.toBe("profile");
      expect(answers[0]?.answer).not.toContain("alex@example.com");
    },
  );
});

/**
 * "Phone number for the recruiter to contact you" names a recruiter, but the
 * number asked for is the candidate's own.
 */
describe("a contact detail the third party will use to reach the candidate", () => {
  it.each([
    "Best phone number for the hiring manager to reach you",
    "Phone number for the recruiter to contact you",
  ])("fills the candidate's own phone: %s", (label) => {
    const { answers } = draftAnswers([text(label)], makeProfile(), makeCampaign());

    expect(answers[0]?.citation).toBe("identity.phone");
  });

  it("still leaves out the third party's own details", () => {
    const { answers } = draftAnswers([text("Phone number of your hiring manager")], makeProfile(), makeCampaign());

    expect(answers[0]?.source).not.toBe("profile");
  });
});
