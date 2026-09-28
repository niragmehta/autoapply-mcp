import { describe, expect, it } from "vitest";
import { resolveExperience } from "../src/drafting/experience.js";
import { experienceResolverFor } from "../src/submission/experienceResolver.js";
import {
  buildFillPlan,
  fallbackAnswersForFields,
  optionSearchCandidates,
  pickOptionIndex,
} from "../src/submission/formFields.js";
import type { FieldDescriptor } from "../src/submission/formFields.js";
import type { DraftAnswer } from "../src/domain/job.js";
import { makeProfile } from "./factories.js";

function field(label: string, overrides: Partial<FieldDescriptor> = {}): FieldDescriptor {
  return { selectorIndex: 0, label, type: "text", name: "", required: true, ...overrides };
}

function answer(label: string, value: string): DraftAnswer {
  return {
    questionKey: label.toLowerCase().replace(/\W+/g, "_"),
    label,
    answer: value,
    source: "profile",
    citation: "",
    requiresHuman: false,
    category: "contact",
  };
}

const profile = makeProfile();

describe("resolveExperience", () => {
  it("answers Workday's combined employment start date", () => {
    expect(resolveExperience("Employment start date", profile)?.answer).toBe("02/2021");
  });

  it("offers no employment end date for a current role", () => {
    // Workday hides the control once "I currently work here" is ticked, and
    // inventing an end date for a job still held would be false.
    expect(resolveExperience("Employment end date", profile)?.answer ?? "").toBe("");
  });

  it.each([
    "Desired employment start date",
    "Earliest employment start date",
    "Expected employment start date",
    "Preferred employment start date",
    "Anticipated employment start date",
    "Proposed employment start date",
    "Target employment start date",
  ])("does not answer %s with a past employment date", (label) => {
    expect(resolveExperience(label, profile)?.answer).not.toBe("02/2021");
  });

  it.each(["Education start date", "School employment start date"])(
    "does not answer %s from employment", (label) => {
      expect(resolveExperience(label, profile)?.answer).not.toBe("02/2021");
    },
  );

  it.each(["Education start month", "Education start year", "School start year", "University start month"])(
    "does not substitute employment dates for %s", (label) => {
      expect(resolveExperience(label, profile)).toBeNull();
    },
  );
  it("answers the employment block from the current position", () => {
    expect(resolveExperience("Company name", profile)?.answer).toBe("Acme");
    expect(resolveExperience("Title", profile)?.answer).toBe("Software Engineer II - Security");
    expect(resolveExperience("Start date month", profile)?.answer).toBe("February");
    expect(resolveExperience("Start date year", profile)?.answer).toBe("2021");
  });

  it("leaves the end date blank and reports the role as current", () => {
    expect(resolveExperience("End date month", profile)).toBeNull();
    expect(resolveExperience("End date year", profile)).toBeNull();
    expect(resolveExperience("Current role", profile)?.answer).toBe("Yes");
  });

  // 1Password's "Current job title?" was submitted as "Yes": it contains
  // "current" and "job", so the is-this-your-current-role boolean claimed a
  // free-text field. A question that names the attribute it wants is never the
  // boolean, whatever else it contains.
  it("does not answer an attribute question with the current-role yes/no", () => {
    expect(resolveExperience("Current job title?", profile)?.answer).toBe("Software Engineer II - Security");
    expect(resolveExperience("Current title", profile)?.answer).toBe("Software Engineer II - Security");
    expect(resolveExperience("Current employer", profile)?.answer).toBe("Acme");
    expect(resolveExperience("Current company name", profile)?.answer).toBe("Acme");
  });

  it("still recognises the genuinely boolean phrasings", () => {
    expect(resolveExperience("Current role", profile)?.answer).toBe("Yes");
    expect(resolveExperience("I currently work here", profile)?.answer).toBe("Yes");
    expect(resolveExperience("Is this your current position?", profile)?.answer).toBe("Yes");
    expect(resolveExperience("Do you currently work here?", profile)?.answer).toBe("Yes");
  });

  // Maven Clinic asked "Are you currently employed by Maven Clinic in any
  // capacity? If so, please list current role." It contains "currently" and
  // "current role", so the is-this-your-current-role boolean answered Yes: a
  // false claim of already working for the hiring company.
  it("answers a named-employer question from who the candidate actually works for", () => {
    expect(
      resolveExperience(
        "Are you currently employed by Maven Clinic in any capacity? If so, please list current role.",
        profile,
      )?.answer,
    ).toBe("No");
    expect(resolveExperience("Do you currently work for Maven Clinic or any of its affiliates?", profile)?.answer).toBe("No");
    expect(resolveExperience("Are you currently employed by Acme?", profile)?.answer).toBe("Yes");
    expect(resolveExperience("Are you currently an employee of Acme Corporation?", profile)?.answer).toBe("Yes");
  });

  it.each([
    "Are you currently employed by us in any capacity? If so, please list current role.",
    "Are you currently employed by a federal contractor?",
    "Are you currently employed by any other company in your current role?",
    "Have you ever been employed by Maven Clinic in any role?",
  ])("leaves %s for a person rather than guessing who is meant", (label) => {
    expect(resolveExperience(label, profile)).toBeNull();
  });

  // "Current or former" also asks about past jobs, and a willingness question
  // is not about employment at all. Answering either from the current job
  // alone said "No" for the candidate, so both still go to a person.
  it.each([
    "Are you a current or former employee of Stripe?",
    "Are you currently or have you ever been employed by Stripe?",
    "Were you previously employed by Stripe?",
    "Are you open to working for Stripe on a contract basis?",
    "Are you willing to work for Acme in our SF office?",
    "Are you interested in working for Acme's security team?",
  ])("does not answer %s from the current job alone", (label) => {
    expect(resolveExperience(label, profile)).toBeNull();
  });

  it("does not read a skills question as a named employer", () => {
    expect(resolveExperience("Do you currently work with Python in your current role?", profile)?.answer).not.toBe("No");
  });

  it("gives the end date once a position has one", () => {    const past = makeProfile({
      experience: [{ company: "Phemi", title: "Intern", start: "2018-05", end: "2018-08", highlights: [] }],
    });
    expect(past.experience.length).toBe(1);
    expect(resolveExperience("End date month", past)?.answer).toBe("August");
    expect(resolveExperience("End date year", past)?.answer).toBe("2018");
    expect(resolveExperience("Current role", past)?.answer).toBe("No");
  });

  it("prefers the current position over an older one that started later in the list", () => {
    const many = makeProfile({
      experience: [
        { company: "Phemi", title: "Intern", start: "2018-05", end: "2018-08", highlights: [] },
        { company: "Acme", title: "Engineer", start: "2021-02", end: "present", highlights: [] },
      ],
    });
    expect(resolveExperience("Company name", many)?.answer).toBe("Acme");
  });

  /**
   * "Why this company?" and "Job title you are applying for" are about the
   * employer being applied to. Answering them with the current employer would
   * be a plain misstatement, so bare names only match exactly.
   */
  it("does not answer questions about the company being applied to", () => {
    expect(resolveExperience("Why do you want to work at this company?", profile)).toBeNull();
    expect(resolveExperience("What job title are you applying for?", profile)).toBeNull();
  });

  it("does not take a desired start date for an employment start date", () => {
    expect(resolveExperience("When is your earliest start date?", profile)).toBeNull();
    expect(resolveExperience("Desired start date", profile)).toBeNull();
  });

  it("says nothing when the profile lists no positions", () => {
    expect(resolveExperience("Company name", makeProfile({ experience: [] }))).toBeNull();
  });
});

describe("employment block fill", () => {
  it("fills every control in the block, including both halves of the start date", () => {
    const fields = [
      field("Company name", { selectorIndex: 1 }),
      field("Title", { selectorIndex: 2 }),
      field("Start date month", { selectorIndex: 3, type: "select" }),
      field("Start date year", { selectorIndex: 4 }),
    ];
    const derived = fallbackAnswersForFields(fields, [], [], undefined, undefined, experienceResolverFor(profile));
    expect(derived.map((entry) => entry.answer)).toEqual([
      "Acme",
      "Software Engineer II - Security",
      "February",
      "2021",
    ]);
  });

  /**
   * The two ends of a period differ by one word and sit next to each other, so
   * similarity let the start month fill the end month - which on a past
   * position states the job began and ended in the same month.
   */
  it("does not let a start date fill an end date", () => {
    const fields = [
      field("Start date month", { selectorIndex: 3, type: "select" }),
      field("End date month", { selectorIndex: 5, type: "select" }),
    ];
    const derived = fallbackAnswersForFields(fields, [], [], undefined, undefined, experienceResolverFor(profile));
    const plan = buildFillPlan(fields, derived);
    const endDate = plan.toFill.find((match) => match.field.label === "End date month");
    expect(endDate).toBeUndefined();
  });

  it("leaves a control alone when the packet already answered it", () => {    const fields = [field("Company name", { selectorIndex: 1 })];
    const derived = fallbackAnswersForFields(
      fields,
      [answer("Company name", "Stated already")],
      [],
      undefined,
      undefined,
      experienceResolverFor(profile),
    );
    expect(derived).toEqual([]);
  });
});

/**
 * Lyft's relocation question is a react-select with three sentences and no
 * "Yes", so a stored decision reached none of them.
 */
describe("relocation options", () => {
  const LYFT_LABEL =
    "This position is required to work out of a Lyft Office in Toronto, if you do not reside within the country and within commutable proximity to the office, are you open to relocating?";
  const LYFT_OPTIONS = [
    "I am willing to relocate before starting employment.",
    "I am not willing to relocate before starting employment.",
    "I already reside within commutable distance to Toronto and am able to work at an On-site Office.",
  ];

  it("reaches the sentence from a stored yes, and never its negation", () => {
    const candidates = optionSearchCandidates(field(LYFT_LABEL, { type: "select" }), answer(LYFT_LABEL, "Yes"));
    expect(pickOptionIndex(LYFT_OPTIONS, candidates)).toBe(0);
  });

  it("reaches the negated sentence from a stored no", () => {
    const candidates = optionSearchCandidates(field(LYFT_LABEL, { type: "select" }), answer(LYFT_LABEL, "No"));
    expect(pickOptionIndex(LYFT_OPTIONS, candidates)).toBe(1);
  });

  /**
   * "I already reside within commutable distance to Toronto" is a statement
   * about where the candidate lives, which a yes to relocating does not make.
   */
  it("never claims the candidate already lives near the office", () => {
    const candidates = optionSearchCandidates(field(LYFT_LABEL, { type: "select" }), answer(LYFT_LABEL, "Yes"));
    expect(pickOptionIndex([LYFT_OPTIONS[2]!], candidates)).toBe(-1);
  });
});

describe("month options", () => {  /** Boards write the same month as "February", "Feb", "02" and "2". */
  it("offers every spelling of the one month", () => {
    const candidates = optionSearchCandidates(
      field("Start date month", { type: "select" }),
      answer("Start date month", "February"),
    );
    expect(candidates).toEqual(["February", "feb", "02", "2"]);
  });

  it("leaves other values alone", () => {
    const candidates = optionSearchCandidates(
      field("Current company", {}),
      answer("Current company", "Microsoft"),
    );
    expect(candidates).toEqual(["Microsoft"]);
  });
});
