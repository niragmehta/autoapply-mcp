import { describe, expect, it } from "vitest";
import {
  buildFillPlan,
  answerValueForField,
  augmentAnswersForBrowser,
  detectCaptcha,
  detectSubmissionConfirmation,
  educationDateLabels,
  fallbackAnswersForFields,
  looksLikeApplicationForm,
  matchFields,
  normalizeLabel,
  optionSearchCandidates,
  optionTextMatches,
  orderFieldsForBrowser,
  pickOptionIndex,
  type FieldDescriptor,
} from "../src/submission/formFields.js";
import type { DraftAnswer } from "../src/domain/job.js";

function field(label: string, overrides: Partial<FieldDescriptor> = {}): FieldDescriptor {
  return { selectorIndex: 0, label, type: "text", name: "", required: false, ...overrides };
}

function answer(label: string, value: string, overrides: Partial<DraftAnswer> = {}): DraftAnswer {
  return {
    questionKey: label.toLowerCase().replace(/\W+/g, "_"),
    label,
    answer: value,
    source: "profile",
    citation: "",
    requiresHuman: false,
    category: "contact",
    ...overrides,
  };
}

describe("normalizeLabel", () => {
  it("strips required markers and punctuation", () => {
    expect(normalizeLabel("First Name *")).toBe("first name");
    expect(normalizeLabel("Email (required)")).toBe("email");
  });

  it("splits camel case so profile keys match spaced form labels", () => {
    expect(normalizeLabel("VeteranStatus")).toBe("veteran status");
    expect(normalizeLabel("DisabilityStatus")).toBe("disability status");
    expect(normalizeLabel("Veteran Status")).toBe("veteran status");
  });
});

describe("matchFields", () => {
  it("matches fields to answers by label", () => {
    const matches = matchFields([field("First Name *"), field("Email")], [answer("First Name", "Alex"), answer("Email", "a@b.co")]);
    expect(matches[0]?.answer?.answer).toBe("Alex");
    expect(matches[1]?.answer?.answer).toBe("a@b.co");
  });

  it("matches by field name when the label is unhelpful", () => {
    const matches = matchFields([field("", { name: "email" })], [answer("Email", "a@b.co")]);
    expect(matches[0]?.answer).not.toBeNull();
  });

  it("leaves unrelated fields unmatched", () => {
    const matches = matchFields([field("Favourite programming language")], [answer("Email", "a@b.co")]);
    expect(matches[0]?.answer).toBeNull();
  });

  it("uses the approved location answer for a country selector", () => {
    const matches = matchFields(
      [field("Country *")],
      [answer("Location", "Vancouver, British Columbia, Canada")],
    );

    expect(matches[0]?.answer?.label).toBe("Location");
  });

  it("matches equivalent work-authorization and residence questions", () => {
    const matches = matchFields(
      [
        field("Are you legally eligible to work in Canada?"),
        field("What is the location where you permanently reside?"),
      ],
      [
        answer("Are you legally authorized to work in the country of this role?", "Yes"),
        answer("Current Location", "Vancouver, British Columbia, Canada"),
      ],
    );

    expect(matches[0]?.answer?.answer).toBe("Yes");
    expect(matches[1]?.answer?.label).toBe("Current Location");
  });
});

describe("answerValueForField", () => {
  it("extracts the country from an approved location", () => {
    expect(
      answerValueForField(
        field("Country *"),
        answer("Location", "Vancouver, British Columbia, Canada"),
      ),
    ).toBe("Canada");
  });

  it("maps an affirmative agreement answer to the option label", () => {
    expect(
      answerValueForField(
        field('By selecting "I agree," I accept the privacy policy'),
        answer("Privacy consent", "Yes"),
      ),
    ).toBe("I agree");
  });

  it("normalizes decline-to-identify wording for ATS option matching", () => {
    expect(
      answerValueForField(
        field("Gender identity", { type: "select-one" }),
        answer("Gender identity", "Decline to self-identify"),
      ),
    ).toBe("wish to answer");
    expect(
      answerValueForField(
        field("Disability status", { type: "select-one" }),
        answer("Disability status", "I do not wish to answer"),
      ),
    ).toBe("wish to answer");
  });
});

describe("buildFillPlan", () => {
  it("reports required fields nothing can fill", () => {
    const plan = buildFillPlan(
      [field("Email"), field("Desired salary", { required: true })],
      [answer("Email", "a@b.co")],
    );
    expect(plan.toFill).toHaveLength(1);
    expect(plan.unmatchedRequired.map((entry) => entry.label)).toEqual(["Desired salary"]);
  });

  it("excludes answers that are still empty", () => {
    const plan = buildFillPlan([field("Work authorization", { required: true })], [answer("Work authorization", "")]);
    expect(plan.toFill).toHaveLength(0);
    expect(plan.unmatchedRequired).toHaveLength(1);
  });

  it("lists answers that found no field", () => {
    const plan = buildFillPlan([field("Email")], [answer("Email", "a@b.co"), answer("GitHub", "https://github.com/x")]);
    expect(plan.unusedAnswers.map((entry) => entry.label)).toEqual(["GitHub"]);
  });

  it("leaves required file controls to the verified resume uploader", () => {
    const plan = buildFillPlan(
      [field("Resume", { type: "file", required: true })],
      [answer("Resume/CV", "")],
    );

    expect(plan.unmatchedRequired).toHaveLength(0);
  });

  it("ticks one option in a select-all-that-apply group, never every option", () => {
    // Sierra's diversity survey came back with all seven orientations ticked at
    // once, plus both "Other" and "I prefer not to answer", because each option
    // matched the shared question label independently. That states things about
    // the candidate that are not true.
    const options = [
      "Bisexual",
      "Lesbian",
      "Gay",
      "Queer",
      "Heterosexual / straight",
      "Other",
      "I prefer not to answer",
    ];
    const label = "How do you identify your sexual orientation? Please select all that apply.";
    const fields = options.map((optionLabel, index) =>
      field(label, {
        selectorIndex: index,
        type: "checkbox",
        name: `orientation_${index}`,
        optionLabel,
        groupKey: label,
      }),
    );

    const plan = buildFillPlan(fields, [
      answer(label, "I prefer not to answer", { category: "demographic" }),
    ]);

    expect(plan.toFill).toHaveLength(1);
    expect(plan.toFill[0]!.field.optionLabel).toBe("I prefer not to answer");
  });

  it("reports an unanswerable checkbox group once rather than once per option", () => {
    const label = "Which ethnicity(ies) do you identify with? Please select all that apply.";
    const fields = ["Asian or Asian American", "White", "Other"].map((optionLabel, index) =>
      field(label, {
        selectorIndex: index,
        type: "checkbox",
        name: `ethnicity_${index}`,
        optionLabel,
        required: true,
        groupKey: label,
      }),
    );

    const plan = buildFillPlan(fields, []);

    expect(plan.unmatchedRequired).toHaveLength(1);
  });

  it("keeps ungrouped checkboxes independent of one another", () => {
    // Two acknowledgement boxes are separate obligations and both must tick.
    const plan = buildFillPlan(
      [
        field("I acknowledge the privacy notice", { type: "checkbox", name: "ack1" }),
        field("I acknowledge the arbitration agreement", { type: "checkbox", name: "ack2" }),
      ],
      [
        answer("I acknowledge the privacy notice", "Yes"),
        answer("I acknowledge the arbitration agreement", "Yes"),
      ],
    );

    expect(plan.toFill).toHaveLength(2);
  });
});

describe("orderFieldsForBrowser", () => {  it("fills stateful choice controls after text and combobox fields", () => {
    const matches = matchFields(
      [
        field("Eligible", { type: "checkbox" }),
        field("Location", { role: "combobox" }),
        field("Email"),
      ],
      [answer("Eligible", "Yes"), answer("Location", "Vancouver"), answer("Email", "a@b.co")],
    );

    expect(orderFieldsForBrowser(matches).map((match) => match.field.label)).toEqual([
      "Location",
      "Email",
      "Eligible",
    ]);
    expect(matches[0]?.field.label).toBe("Eligible");
  });
});

describe("augmentAnswersForBrowser", () => {
  it("derives legal name from approved first and last names without mutation", () => {
    const original = [answer("First Name", "Nirag"), answer("Last Name", "Mehta")];
    const augmented = augmentAnswersForBrowser(original);

    expect(augmented.find((entry) => entry.label === "Legal Name")?.answer).toBe("Nirag Mehta");
    expect(original).toHaveLength(2);
  });

  it("adds verified profile country for ATS phone-country selectors", () => {
    const augmented = augmentAnswersForBrowser([answer("Phone", "604-555-0100")], "Canada");

    expect(augmented.find((entry) => entry.label === "Country")?.answer).toBe("Canada");
  });
});

describe("detectCaptcha", () => {
  it("ignores passive anti-bot widgets embedded in normal forms", () => {
    expect(detectCaptcha('<form><div class="g-recaptcha"></div><input name="email"></form>')).toBe(false);
    expect(detectCaptcha("<form><iframe src='https://challenges.cloudflare.com/turnstile'></iframe></form>")).toBe(false);
  });

  it("detects active anti-bot challenge text", () => {
    expect(detectCaptcha("Verify you are human to continue")).toBe(true);
    expect(detectCaptcha("Please complete the CAPTCHA")).toBe(true);
    expect(detectCaptcha("Apply for this job")).toBe(false);
  });

  it("does not read a security job advert as an anti-bot wall", () => {
    expect(
      detectCaptcha(
        "Tackle evolving enterprise security challenges, such as protecting against advanced persistent threats.",
      ),
    ).toBe(false);
    expect(detectCaptcha("You will own the hardest security challenge in the company.")).toBe(false);
    expect(detectCaptcha("Complete the security challenge to continue.")).toBe(true);
  });
});

describe("detectSubmissionConfirmation", () => {
  it("recognizes common ATS confirmation messages", () => {
    expect(detectSubmissionConfirmation("Thank you for applying!")).toBe(true);
    expect(detectSubmissionConfirmation("Your application has been submitted.")).toBe(true);
  });

  it("does not treat the application form or a button click as confirmation", () => {
    expect(detectSubmissionConfirmation("Apply for this job\nSubmit application")).toBe(false);
  });

  it("accepts an ATS confirmation URL when the employer uses its own wording", () => {
    // Pinterest writes "Good news: your application is in!", which no marker
    // list anticipated, but Greenhouse still routed to its confirmation page.
    expect(
      detectSubmissionConfirmation(
        "Good news: your application is in!",
        "https://job-boards.greenhouse.io/embed/job_app/confirmation?for=pinterest&token=7305880",
      ),
    ).toBe(true);
  });

  it("does not accept the form URL as confirmation", () => {
    expect(
      detectSubmissionConfirmation(
        "Apply for this job",
        "https://job-boards.greenhouse.io/embed/job_app?for=pinterest&token=7305880",
      ),
    ).toBe(false);
  });

  it("does not accept a posting that merely mentions confirmation", () => {
    expect(
      detectSubmissionConfirmation(
        "You will receive a confirmation email.",
        "https://job-boards.greenhouse.io/acme/jobs/12345",
      ),
    ).toBe(false);
  });

  it("recognizes confirmation copy carrying an adverb", () => {
    // Ashby renders "Your application was successfully submitted", which no
    // literal marker matched, so a real submission was reported as unverified.
    expect(
      detectSubmissionConfirmation(
        "Success\nYour application was successfully submitted. We'll reach out with any next steps!",
        "https://jobs.ashbyhq.com/modal/73c97bbc/application",
      ),
    ).toBe(true);
  });

  it("does not treat a promise of future submission as confirmation", () => {
    expect(
      detectSubmissionConfirmation(
        "Your application will be submitted once you press the button below.",
        "https://jobs.ashbyhq.com/acme/123/application",
      ),
    ).toBe(false);
  });
});

describe("augmentAnswersForBrowser demographic consent", () => {
  const declined = answer("Gender", "Decline to self-identify", { category: "demographic" });

  it("consents to processing demographic responses once they are all declines", () => {
    const augmented = augmentAnswersForBrowser([declined]);
    const consent = augmented.find((entry) => entry.questionKey === "derived-demographic-consent");
    expect(consent?.answer).toBe("Yes");

    const consentField = field(
      "By checking this box, I consent to Reddit collecting, storing, and processing my responses to the demographic data surveys above.*",
      { type: "checkbox", required: true },
    );
    const plan = buildFillPlan([consentField], augmented);
    expect(plan.unmatchedRequired).toEqual([]);
    expect(plan.toFill[0]?.answer?.answer).toBe("Yes");
  });

  it("does not invent consent when no demographic answers are present", () => {
    const augmented = augmentAnswersForBrowser([answer("First Name", "Nirag")]);
    expect(augmented.some((entry) => entry.questionKey === "derived-demographic-consent")).toBe(false);
  });
});

describe("optionSearchCandidates", () => {
  it("offers every common decline-to-answer phrasing", () => {
    const candidates = optionSearchCandidates(
      field("Gender*", { role: "combobox" }),
      answer("Gender", "Decline to self-identify", { category: "demographic" }),
    );
    expect(candidates).toContain("wish to answer");
    expect(candidates).toContain("Decline to self identify");
    expect(candidates).toContain("Prefer not to say");
  });

  it("recognizes decline phrasings other than the canonical one", () => {
    const wishNot = optionSearchCandidates(
      field("Race", { role: "combobox" }),
      answer("Race", "I don't wish to answer", { category: "demographic" }),
    );
    expect(wishNot).toContain("Decline to self identify");
    expect(
      optionSearchCandidates(
        field("Veteran Status", { role: "combobox" }),
        answer("Veteran Status", "Prefer not to answer", { category: "demographic" }),
      ),
    ).toContain("wish to answer");
  });

  it("recognizes a decline whose wording names the subject", () => {
    // Ashby renders the veteran decline as "I decline to self-identify for
    // protected veteran status". Matched exactly, that is not a decline, and
    // the field falls through to an option that answers the question.
    const candidates = optionSearchCandidates(
      field("Veteran Status", { role: "radio" }),
      answer("VeteranStatus", "I decline to self-identify for protected veteran status", {
        category: "demographic",
      }),
    );
    expect(
      pickOptionIndex(
        [
          "I identify as one or more of the classifications of protected veteran listed above",
          "I am not a protected veteran",
          "I decline to self-identify for protected veteran status",
        ],
        candidates,
      ),
    ).toBe(2);
    expect(pickOptionIndex(["Yes", "No"], candidates)).toBe(-1);
  });

  it("falls back to the locality when a full location string finds nothing", () => {
    const candidates = optionSearchCandidates(
      field("Location (City)*", { role: "combobox" }),
      answer("Location", "Vancouver, British Columbia, Canada"),
    );
    expect(candidates[0]).toBe("Vancouver, British Columbia, Canada");
    expect(candidates).toContain("Vancouver");
  });

  it("leaves a plain answer as a single candidate", () => {
    expect(
      optionSearchCandidates(
        field("Are you legally authorized to work in the United States?*", { role: "combobox" }),
        answer("US work authorization", "Yes"),
      ),
    ).toEqual(["Yes"]);
  });

  it("offers relocation wording when a board replaces Yes/No with prose", () => {
    const candidates = optionSearchCandidates(
      field("Do you currently live or are you willing to relocate to the jobâ€™s location?*", { role: "combobox" }),
      answer("Open to relocation", "Yes"),
    );
    expect(candidates).toContain("am willing to relocate");
    expect(
      pickOptionIndex(
        [
          "I currently live in this job's location.",
          "I am willing to relocate to this job's location.",
          "I do not live and not willing to relocate to this job's location.",
        ],
        candidates,
      ),
    ).toBe(1);
  });

  // Abridge puts the relocation decision entirely in the options: the label is
  // "Where in the United States will you be working from?", which says nothing
  // about relocating, so a label-only rule left a required question with no
  // reachable answer and aborted the application.
  it("reads relocation wording out of the options when the label omits it", () => {
    const abridgeOptions = [
      "I am currently living in the SF Bay or New York areas",
      "I do not currently live in New York, San Francisco - but I am willing to relocate within 6 months",
      "I do not currently live in New York, San Francisco - but I am willing to travel 20%",
      "I am NOT willing to relocate and am only open to 100% remote positions",
    ];
    const chosen = abridgeOptions.findIndex((optionLabel) => {
      const candidates = optionSearchCandidates(
        field("Where in the United States will you be working from?", { type: "radio", optionLabel }),
        answer("Open to relocation", "Yes"),
      );
      return pickOptionIndex([optionLabel], candidates) >= 0;
    });
    expect(abridgeOptions[chosen]).toBe(
      "I do not currently live in New York, San Francisco - but I am willing to relocate within 6 months",
    );
  });

  // The wording rules see only the group's head option, so the whole group has
  // to be planned to prove the right radio is actually selected.
  it("selects the relocating option of a group whose head option never mentions it", () => {
    const abridgeOptions = [
      "I am currently living in the San Francisco Bay or New York areas",
      "I do not currently live in New York, San Francisco - but I am willing to relocate within 6 months",
      "I do not currently live in New York, San Francisco - but I am willing to travel 20%",
      "I do not currently live in New York, San Francisco- I am NOT willing to relocate and am only open to 100% remote positions",
    ];
    const group = abridgeOptions.map((optionLabel, selectorIndex) =>
      field("Where in the United States will you be working from?", {
        type: "radio",
        name: "where",
        optionLabel,
        selectorIndex,
        required: true,
      }),
    );
    const plan = buildFillPlan(group, [
      // A derived answer carries the live field label, which is how it binds to
      // the group at all - the stored key stays in questionKey.
      answer("Where in the United States will you be working from?", "Yes", {
        questionKey: "relocation-willing",
        source: "approved-answer",
      }),
    ]);
    expect(plan.toFill.map((match) => match.field.optionLabel)).toEqual([
      "I do not currently live in New York, San Francisco - but I am willing to relocate within 6 months",
    ]);
    expect(plan.unmatchedRequired).toEqual([]);
  });

  it("never claims willingness when the answer is no", () => {    const candidates = optionSearchCandidates(
      field("Are you willing to relocate to the jobâ€™s location?*", { role: "combobox" }),
      answer("Open to relocation", "No"),
    );
    expect(
      pickOptionIndex(
        ["I am willing to relocate to this job's location.", "I am not willing to relocate."],
        candidates,
      ),
    ).toBe(1);
  });

  it("treats the EEOC protected-veteran phrasing as equivalent to plain not-a-veteran options", () => {
    const candidates = optionSearchCandidates(
      field("Are you a veteran/have you served in the military? *", { role: "combobox" }),
      answer("VeteranStatus", "I am not a protected veteran", { category: "demographic" }),
    );
    expect(pickOptionIndex(["Active Duty", "Inactive Reserve", "I am not a veteran"], candidates)).toBe(2);
    expect(pickOptionIndex(["Yes", "No"], candidates)).toBe(1);
    expect(
      pickOptionIndex(
        ["I identify as one or more of the classifications of a protected veteran", "I am not a protected veteran"],
        candidates,
      ),
    ).toBe(1);
  });

  it("does not select a veteran option that claims service", () => {
    const candidates = optionSearchCandidates(
      field("Are you a veteran or active member of the United States Armed Forces? (select one)", {
        role: "combobox",
      }),
      answer("VeteranStatus", "I am not a protected veteran", { category: "demographic" }),
    );
    expect(pickOptionIndex(["I am a veteran", "Active Duty"], candidates)).toBe(-1);
  });

  it("never answers a disability question when the candidate declined to say", () => {
    // "no" sits inside "do not", so a naive containment check turns a refusal
    // to disclose into a claim about a protected characteristic.
    const options = ["Yes", "No", "I prefer to self-describe", "I don't wish to answer"];
    expect(pickOptionIndex(options, ["I do not wish to answer"])).toBe(3);
    expect(pickOptionIndex(["Yes", "No"], ["I do not wish to answer"])).toBe(-1);

    const candidates = optionSearchCandidates(
      field(
        "Do you have a disability or chronic condition that substantially limits 1 or more of your major life activities?",
        { role: "combobox" },
      ),
      answer("DisabilityStatus", "I do not wish to answer", { category: "demographic" }),
    );
    expect(pickOptionIndex(options, candidates)).toBe(3);
    expect(pickOptionIndex(["Yes", "No"], candidates)).toBe(-1);
  });

  it("still matches a short option that appears as a whole word", () => {
    expect(pickOptionIndex(["Yes", "No"], ["No"])).toBe(1);
    expect(pickOptionIndex(["Yes", "No, I have not"], ["No"])).toBe(1);
  });
});

describe("pickOptionIndex", () => {
  it("prefers an exact option over a substring match", () => {
    expect(pickOptionIndex(["Yes, and I have a valid visa", "Yes", "No"], ["Yes"])).toBe(1);
  });

  it("ticks a lone acknowledgement option for an affirmative answer", () => {
    expect(pickOptionIndex(["I acknowledge"], ["Yes"])).toBe(0);
    expect(pickOptionIndex(["I agree"], ["Yes"])).toBe(0);
    expect(pickOptionIndex(["I certify that the above is accurate"], ["Yes"])).toBe(0);
  });

  it("leaves a lone option alone when it is not an opt-in", () => {
    expect(pickOptionIndex(["San Francisco, CA"], ["Yes"])).toBe(-1);
  });

  it("leaves a lone acknowledgement alone when the answer is not affirmative", () => {
    expect(pickOptionIndex(["I acknowledge"], ["No"])).toBe(-1);
  });

  it("finds a decline option regardless of the wording the board uses", () => {
    const candidates = optionSearchCandidates(
      field("Gender*", { role: "combobox" }),
      answer("Gender", "Decline to self-identify", { category: "demographic" }),
    );
    expect(pickOptionIndex(["Male", "Female", "Decline to self identify"], candidates)).toBe(2);
    expect(pickOptionIndex(["Male", "Female", "I don't wish to answer"], candidates)).toBe(2);
    expect(pickOptionIndex(["Man", "Woman", "Prefer not to say"], candidates)).toBe(2);
  });

  it("covers the exact wording Greenhouse EEOC dropdowns use", () => {
    const candidates = optionSearchCandidates(
      field("Disability Status", { role: "combobox" }),
      answer("DisabilityStatus", "Decline to self-identify", { category: "demographic" }),
    );
    expect(
      pickOptionIndex(
        [
          "Yes, I have a disability, or have had one in the past",
          "No, I do not have a disability and have not had one in the past",
          "I do not want to answer",
        ],
        candidates,
      ),
    ).toBe(2);
    expect(
      pickOptionIndex(
        [
          "I am not a protected veteran",
          "I identify as one or more of the classifications of a protected veteran",
          "I don't wish to answer",
        ],
        candidates,
      ),
    ).toBe(2);
    expect(pickOptionIndex(["Male", "Female", "Decline To Self Identify"], candidates)).toBe(2);
  });

  it("does not confuse Yes with No", () => {
    expect(pickOptionIndex(["No"], ["Yes"])).toBe(-1);
  });

  it("reports no match when nothing is close", () => {
    expect(pickOptionIndex(["Alpha", "Beta"], ["Gamma"])).toBe(-1);
  });
});

describe("optionTextMatches", () => {
  it("matches a city option from a full location string", () => {
    expect(optionTextMatches("Vancouver, British Columbia, Canada", "Vancouver")).toBe(true);
    expect(optionTextMatches("Vancouver, Washington, United States", "Vancouver, British Columbia, Canada")).toBe(
      true,
    );
  });

  it("rejects unrelated options", () => {
    expect(optionTextMatches("Toronto, Ontario, Canada", "Vancouver")).toBe(false);
  });
});

describe("location phrasing", () => {
  it("matches a where-are-you-located question to the current location answer", () => {
    const matches = matchFields(
      [field("Where are you currently located?", { required: true })],
      [answer("Current Location", "Vancouver, British Columbia, Canada")],
    );
    expect(matches[0]?.answer?.answer).toBe("Vancouver, British Columbia, Canada");
  });

  it("matches other location phrasings boards use", () => {
    for (const label of ["Where are you based?", "What is your current location?", "Where do you reside?"]) {
      const matches = matchFields([field(label)], [answer("Current Location", "Vancouver, Canada")]);
      expect(matches[0]?.answer, label).not.toBeNull();
    }
  });

  it("does not treat an unrelated question as a location question", () => {
    const matches = matchFields([field("Why do you want to work here?")], [answer("Current Location", "Vancouver, Canada")]);
    expect(matches[0]?.answer).toBeNull();
  });
});

describe("fallbackAnswersForFields", () => {
  const bank = [
    {
      key: "start-date",
      label: "Earliest start date",
      patterns: ["start date", "when can you start"],
      answer: "Approximately four weeks from offer acceptance.",
      allowAutoFill: true,
    },
    {
      key: "onsite-willingness",
      label: "Willing to work in office",
      patterns: ["work from our", "days per week"],
      answer: "Yes",
      allowAutoFill: true,
    },
    {
      key: "not-approved",
      label: "Needs a human",
      patterns: ["describe a time"],
      answer: "",
      allowAutoFill: false,
    },
  ];

  it("supplies approved answers for live fields the packet never enumerated", () => {
    const fields = [field("When can you start a new role?", { required: true, selectorIndex: 1 })];
    const extra = fallbackAnswersForFields(fields, [], bank);
    expect(extra).toHaveLength(1);
    expect(extra[0]?.questionKey).toBe("start-date");
    expect(extra[0]?.label).toBe("When can you start a new role?");
    expect(extra[0]?.answer).toBe("Approximately four weeks from offer acceptance.");
    expect(extra[0]?.source).toBe("approved-answer");
    expect(extra[0]?.citation).toBe("profile.answers.start-date");
  });

  it("prefers the most specific pattern when several match", () => {
    const specific = [
      { key: "generic", label: "Generic", patterns: ["start"], answer: "generic", allowAutoFill: true },
      { key: "precise", label: "Precise", patterns: ["when can you start"], answer: "precise", allowAutoFill: true },
    ];
    const extra = fallbackAnswersForFields([field("When can you start a new role?")], [], specific);
    expect(extra[0]?.answer).toBe("precise");
  });

  it("skips fields the packet already answers", () => {
    const fields = [field("When can you start a new role?", { required: true })];
    const packet = [answer("When can you start a new role?", "Two weeks")];
    expect(fallbackAnswersForFields(fields, packet, bank)).toEqual([]);
  });

  it("fills a live field when the packet holds that key under a label the page never uses", () => {
    // Ashby's baseline field set calls it "LinkedIn Profile"; the live page asks
    // for "LinkedIn URL". The packet answer binds to nothing, so treating the
    // key as spent left a required field blank and aborted the submission.
    const linkedInBank = [
      {
        key: "linkedin",
        label: "LinkedIn",
        patterns: ["linkedin url", "linkedin profile", "linkedin"],
        answer: "https://www.linkedin.com/in/example/",
        allowAutoFill: true,
      },
    ];
    const packet = [{ ...answer("LinkedIn Profile", "https://www.linkedin.com/in/example/"), questionKey: "linkedin" }];
    const extra = fallbackAnswersForFields([field("LinkedIn URL", { required: true })], packet, linkedInBank);
    expect(extra).toHaveLength(1);
    expect(extra[0]?.label).toBe("LinkedIn URL");
    expect(extra[0]?.answer).toBe("https://www.linkedin.com/in/example/");
  });

  it("never supplies an entry that is not cleared for auto-fill", () => {
    const extra = fallbackAnswersForFields([field("Describe a time you shipped something")], [], bank);
    expect(extra).toEqual([]);
  });

  it("supplies a bank entry to every standalone field that matches it", () => {
    const fields = [field("When can you start a new role?"), field("Start date preference", { selectorIndex: 1 })];
    const extra = fallbackAnswersForFields(fields, [], bank);
    expect(extra.filter((entry) => entry.questionKey === "start-date")).toHaveLength(2);
  });

  it("fills an onsite question worded around a specific office", () => {
    const fields = [field("Are you able to work from our San Francisco office three days per week?", { required: true })];
    const extra = fallbackAnswersForFields(fields, [], bank);
    expect(extra[0]?.answer).toBe("Yes");
  });

  it("closes the gap end to end through buildFillPlan", () => {
    const fields = [
      field("Where are you currently located?", { required: true, selectorIndex: 0 }),
      field("When can you start a new role?", { required: true, selectorIndex: 1 }),
      field("Are you able to work from our San Francisco office three days per week?", { required: true, selectorIndex: 2 }),
    ];
    const packet = [answer("Current Location", "Vancouver, British Columbia, Canada")];
    const plan = buildFillPlan(fields, [...packet, ...fallbackAnswersForFields(fields, packet, bank)]);
    expect(plan.unmatchedRequired).toEqual([]);
  });
});

describe("radio groups", () => {
  const gender = (optionLabel: string, selectorIndex: number): FieldDescriptor =>
    field("Gender", { type: "radio", name: "eeoc_gender", optionLabel, selectorIndex });

  const group = [gender("Male", 0), gender("Female", 1), gender("Decline to self-identify", 2)];

  it("selects only the option matching the approved answer", () => {
    const plan = buildFillPlan(group, [answer("Gender", "Decline to self-identify", { category: "demographic" })]);
    expect(plan.toFill).toHaveLength(1);
    expect(plan.toFill[0]?.field.optionLabel).toBe("Decline to self-identify");
  });

  it("honours board specific decline wording", () => {
    const disability = [
      field("Disability Status", { type: "radio", name: "eeoc_disability", optionLabel: "Yes, I have a disability", selectorIndex: 0 }),
      field("Disability Status", { type: "radio", name: "eeoc_disability", optionLabel: "No, I don't have a disability", selectorIndex: 1 }),
      field("Disability Status", { type: "radio", name: "eeoc_disability", optionLabel: "I do not want to answer", selectorIndex: 2 }),
    ];
    const plan = buildFillPlan(disability, [answer("Disability Status", "I do not wish to answer", { category: "demographic" })]);
    expect(plan.toFill).toHaveLength(1);
    expect(plan.toFill[0]?.field.optionLabel).toBe("I do not want to answer");
  });

  it("selects the veteran option that states the same fact", () => {
    const veteran = [
      field("Veteran Status", { type: "radio", name: "eeoc_vet", optionLabel: "I identify as one or more of the classifications of protected veteran", selectorIndex: 0 }),
      field("Veteran Status", { type: "radio", name: "eeoc_vet", optionLabel: "I am not a protected veteran", selectorIndex: 1 }),
      field("Veteran Status", { type: "radio", name: "eeoc_vet", optionLabel: "I decline to self-identify for protected veteran status", selectorIndex: 2 }),
    ];
    const plan = buildFillPlan(veteran, [answer("Veteran Status", "I am not a protected veteran", { category: "demographic" })]);
    expect(plan.toFill).toHaveLength(1);
    expect(plan.toFill[0]?.field.optionLabel).toBe("I am not a protected veteran");
  });

  it("fills nothing when no option represents the answer", () => {
    const plan = buildFillPlan(group, [answer("Gender", "Nonbinary", { category: "demographic" })]);
    expect(plan.toFill).toEqual([]);
  });

  it("reports a required group once rather than once per option", () => {
    const required = group.map((entry) => ({ ...entry, required: true }));
    const plan = buildFillPlan(required, []);
    expect(plan.unmatchedRequired).toHaveLength(1);
    expect(plan.unmatchedRequired[0]?.label).toBe("Gender");
  });

  it("leaves radios without a group label untouched", () => {
    const plan = buildFillPlan(
      [field("Yes", { type: "radio", name: "solo", selectorIndex: 0 })],
      [answer("Yes", "Yes")],
    );
    expect(plan.toFill).toHaveLength(1);
  });
});

describe("fallbackAnswersForFields with a personal resolver", () => {
  const resolver = (label: string) => {
    if (/gender/i.test(label)) {
      return { answer: "Decline to self-identify", citation: "personal.demographics.gender", category: "demographic", authorized: true };
    }
    if (/veteran/i.test(label)) {
      return { answer: "I am not a protected veteran", citation: "personal.demographics.veteranStatus", category: "veteran", authorized: true };
    }
    if (/date of birth/i.test(label)) {
      return { answer: "1997-01-01", citation: "personal.dateOfBirth", category: "personal-identifier", authorized: false };
    }
    return null;
  };

  it("supplies a demographic answer the packet never carried", () => {
    const extra = fallbackAnswersForFields([field("Gender", { type: "radio", name: "g", optionLabel: "Male" })], [], [], resolver);
    expect(extra).toHaveLength(1);
    expect(extra[0]?.answer).toBe("Decline to self-identify");
    expect(extra[0]?.category).toBe("demographic");
    expect(extra[0]?.citation).toBe("personal.demographics.gender");
  });

  it("refuses fields the candidate did not opt in for auto-fill", () => {
    expect(fallbackAnswersForFields([field("Date of Birth")], [], [], resolver)).toEqual([]);
  });

  it("supplies one answer per radio group, not one per option", () => {
    const group = ["Male", "Female", "Decline to self-identify"].map((optionLabel, selectorIndex) =>
      field("Gender", { type: "radio", name: "eeoc_gender", optionLabel, selectorIndex }),
    );
    expect(fallbackAnswersForFields(group, [], [], resolver)).toHaveLength(1);
  });

  it("prefers the approved answer bank over the personal resolver", () => {
    const bank = [{ key: "gender-pref", label: "Gender", patterns: ["gender"], answer: "From the bank", allowAutoFill: true }];
    const extra = fallbackAnswersForFields([field("Gender")], [], bank, resolver);
    expect(extra[0]?.answer).toBe("From the bank");
  });

  // Abridge asks "Which state do you currently reside in?". A work-authority
  // bank entry matched it and was correctly rejected - a residence question must
  // never take a work-authorisation answer - but the rejection also threw away
  // the personal answer that was right, and the required field aborted the
  // submission with no answer at all.
  it("falls back to the personal resolver when the bank answer is rejected", () => {
    const residence = (label: string) =>
      /reside/i.test(label)
        ? { answer: "British Columbia", citation: "personal.address.region", category: "contact", authorized: true }
        : null;
    const bank = [
      {
        key: "us-work-authorization-now",
        label: "Authorized to work in the United States",
        patterns: ["are you authorized", "reside"],
        answer: "Yes",
        allowAutoFill: true,
      },
    ];
    const extra = fallbackAnswersForFields(
      [field("Which state do you currently reside in?", { required: true })],
      [],
      bank,
      residence,
    );
    expect(extra).toHaveLength(1);
    expect(extra[0]?.answer).toBe("British Columbia");
    expect(extra[0]?.citation).toBe("personal.address.region");
  });

  it("still lets a compatible bank answer win over the personal resolver", () => {
    const residence = (label: string) =>
      /reside/i.test(label)
        ? { answer: "British Columbia", citation: "personal.address.region", category: "contact", authorized: true }
        : null;
    const bank = [
      { key: "residence-state", label: "State of residence", patterns: ["reside"], answer: "From the bank", allowAutoFill: true },
    ];
    const extra = fallbackAnswersForFields([field("Which state do you reside in?")], [], bank, residence);
    expect(extra[0]?.answer).toBe("From the bank");
  });

  it("drives a whole EEOC section end to end", () => {
    const options: Array<[string, string]> = [
      ["Gender", "Male"],
      ["Gender", "Female"],
      ["Gender", "Decline to self-identify"],
      ["Veteran Status", "I identify as one or more of the classifications of protected veteran"],
      ["Veteran Status", "I am not a protected veteran"],
      ["Veteran Status", "I decline to self-identify for protected veteran status"],
    ];
    const fields = options.map(([label, optionLabel], selectorIndex) =>
      field(label, { type: "radio", name: label.toLowerCase(), optionLabel, selectorIndex }),
    );
    const plan = buildFillPlan(fields, fallbackAnswersForFields(fields, [], [], resolver));
    expect(plan.toFill.map((match) => match.field.optionLabel)).toEqual([
      "Decline to self-identify",
      "I am not a protected veteran",
    ]);
  });
});

describe("reporting what a person must still complete", () => {
  it("lists visible fields nothing filled, required or not", () => {
    const plan = buildFillPlan(
      [
        field("Email", { required: true }),
        field("I acknowledge that I have read the Arbitration Agreement", { type: "checkbox", selectorIndex: 1 }),
        field("Additional Information", { type: "textarea", selectorIndex: 2 }),
      ],
      [answer("Email", "a@b.co")],
    );
    expect(plan.unfilled.map((entry) => entry.label)).toEqual([
      "I acknowledge that I have read the Arbitration Agreement",
      "Additional Information",
    ]);
  });

  it("does not report the resume upload, which is handled separately", () => {
    const plan = buildFillPlan([field("Resume", { type: "file", required: true })], []);
    expect(plan.unfilled).toEqual([]);
  });

  it("reports a radio group once", () => {
    const group = ["Male", "Female"].map((optionLabel, selectorIndex) =>
      field("Gender", { type: "radio", name: "g", optionLabel, selectorIndex }),
    );
    expect(buildFillPlan(group, []).unfilled.map((entry) => entry.label)).toEqual(["Gender"]);
  });
});

describe("single name inputs", () => {
  it("never fills a bare Name field with a first, last or preferred name", () => {
    const matches = matchFields(
      [field("Name *")],
      [
        answer("First Name", "Nirag"),
        answer("Last Name", "Mehta"),
        answer("Preferred name", "Nirag"),
        answer("Legal Name", "Nirag Mehta"),
      ],
    );
    expect(matches[0]?.answer?.answer).toBe("Nirag Mehta");
  });

  it("leaves a bare Name field unmatched rather than guessing a fragment", () => {
    const matches = matchFields([field("Name *")], [answer("First Name", "Nirag"), answer("Preferred name", "Nirag")]);
    expect(matches[0]?.answer).toBeNull();
  });

  it("still fills explicit first and last name fields", () => {
    const matches = matchFields(
      [field("First Name *"), field("Last Name *")],
      [answer("First Name", "Nirag"), answer("Last Name", "Mehta")],
    );
    expect(matches[0]?.answer?.answer).toBe("Nirag");
    expect(matches[1]?.answer?.answer).toBe("Mehta");
  });

  it("derives a Full Name alias so forms asking for a full name match", () => {
    const augmented = augmentAnswersForBrowser([answer("First Name", "Nirag"), answer("Last Name", "Mehta")]);
    const matches = matchFields([field("Full Name *")], augmented);
    expect(matches[0]?.answer?.answer).toBe("Nirag Mehta");
  });
});

describe("camel case brand names in patterns", () => {
  const bank = [
    { key: "github-url", label: "GitHub URL", patterns: ["github"], answer: "https://github.com/x", allowAutoFill: true },
    { key: "website", label: "Website", patterns: ["website", "portfolio"], answer: "https://x.dev", allowAutoFill: true },
  ];

  it("matches a GitHub field even though the label splits into two words", () => {
    const derived = fallbackAnswersForFields([field("GitHub", { required: false })], [], bank);
    expect(derived[0]?.answer).toBe("https://github.com/x");
  });

  it("still matches patterns that are already spaced", () => {
    const derived = fallbackAnswersForFields([field("Portfolio", { required: false })], [], bank);
    expect(derived[0]?.answer).toBe("https://x.dev");
  });

  it("does not let a de-spaced comparison create bogus matches", () => {
    const derived = fallbackAnswersForFields([field("Referral source", { required: false })], [], bank);
    expect(derived).toHaveLength(0);
  });
});

describe("radio groups whose question lives in the option text", () => {
  const bank = [
    {
      key: "sms-consent",
      label: "Consent to receive text message updates",
      patterns: ["consent to receiving text messages"],
      answer: "No - I do not consent to receiving text messages",
      allowAutoFill: true,
    },
  ];
  const consentGroup = [
    field("Phone Number", { type: "radio", name: "sms", required: true, optionLabel: "Yes - I consent to receiving text messages" }),
    field("Phone Number", { type: "radio", name: "sms", required: true, optionLabel: "No - I do not consent to receiving text messages" }),
  ];

  it("reads the option text when the group label is uninformative", () => {
    const derived = fallbackAnswersForFields(consentGroup, [], bank);
    expect(derived).toHaveLength(1);
    expect(derived[0]?.answer).toBe("No - I do not consent to receiving text messages");
  });

  it("selects the declining option and leaves nothing required", () => {
    const plan = buildFillPlan(consentGroup, fallbackAnswersForFields(consentGroup, [], bank));
    expect(plan.unmatchedRequired).toHaveLength(0);
    expect(plan.toFill).toHaveLength(1);
    expect(plan.toFill[0]?.field.optionLabel).toBe("No - I do not consent to receiving text messages");
  });

  it("does not put the consent answer in the phone number text box", () => {
    const phone = field("Phone Number", { type: "tel", name: "phone", required: true });
    const derived = fallbackAnswersForFields([phone], [], bank);
    expect(derived).toHaveLength(0);
  });
});

describe("radio groups competing with a same-named text answer", () => {
  const consentGroup = [
    field("Phone Number", { type: "radio", name: "sms", required: true, optionLabel: "Yes - I consent to receiving text messages" }),
    field("Phone Number", { type: "radio", name: "sms", required: true, optionLabel: "No - I do not consent to receiving text messages" }),
  ];

  it("ignores an answer that matches no option and uses one that does", () => {
    const answers = [
      answer("Phone Number", "555-0100"),
      answer("Phone Number", "No - I do not consent to receiving text messages", { questionKey: "sms-consent" }),
    ];
    const plan = buildFillPlan(consentGroup, answers);
    expect(plan.unmatchedRequired).toHaveLength(0);
    expect(plan.toFill[0]?.field.optionLabel).toBe("No - I do not consent to receiving text messages");
  });

  it("still leaves the group unfilled when no answer maps to an option", () => {
    const plan = buildFillPlan(consentGroup, [answer("Phone Number", "555-0100")]);
    expect(plan.unmatchedRequired).toHaveLength(1);
  });

  it("does not borrow an unrelated answer just because its value looks like an option", () => {
    const plan = buildFillPlan(consentGroup, [answer("Are you a veteran?", "No")]);
    expect(plan.unmatchedRequired).toHaveLength(1);
  });
});

describe("narrative fallback for open-ended questions", () => {
  const narrative = (label: string) =>
    /draws you to|interested in/i.test(label)
      ? { answer: "Rendered narrative.", citation: "profile.narratives.why-company", authorized: true }
      : null;

  it("fills an open-ended question the packet never saw", () => {
    const derived = fallbackAnswersForFields(
      [field("What draws you to this specific role or team?", { type: "textarea", required: true })],
      [],
      [],
      undefined,
      narrative,
    );
    expect(derived[0]?.answer).toBe("Rendered narrative.");
  });

  it("never puts a narrative into a radio option", () => {
    const derived = fallbackAnswersForFields(
      [field("Why are you interested in this role?", { type: "radio", name: "g", optionLabel: "Yes" })],
      [],
      [],
      undefined,
      narrative,
    );
    expect(derived).toHaveLength(0);
  });

  it("leaves unrelated questions alone", () => {
    const derived = fallbackAnswersForFields(
      [field("Exercise Submission (Shared URL)", { required: true })],
      [],
      [],
      undefined,
      narrative,
    );
    expect(derived).toHaveLength(0);
  });

  it("respects a narrative the candidate did not authorise", () => {
    const derived = fallbackAnswersForFields(
      [field("What draws you to this specific role or team?", { type: "textarea", required: true })],
      [],
      [],
      undefined,
      () => ({ answer: "Rendered narrative.", citation: "profile.narratives.why-company", authorized: false }),
    );
    expect(derived).toHaveLength(0);
  });
});

describe("boolean checkbox compatibility", () => {
  const sponsorship = field("Will you now or in the future require sponsorship in the country you are applying to?", {
    type: "checkbox",
    required: true,
  });

  it("rejects a non-boolean answer for a bare yes/no checkbox", () => {
    const [match] = matchFields([sponsorship], [answer("Country you are applying to", "Canada")]);
    expect(match.answer).toBeNull();
  });

  it("still selects the boolean answer for that checkbox", () => {
    const [match] = matchFields(
      [sponsorship],
      [
        answer("Country you are applying to", "Canada"),
        answer("Will you now or in the future require sponsorship?", "No"),
      ],
    );
    expect(match.answer?.answer).toBe("No");
  });

  it("leaves checkbox options that carry their own label alone", () => {
    const option = field("Preferred Work Location", { type: "checkbox", optionLabel: "San Francisco" });
    const [match] = matchFields([option], [answer("Preferred Work Location", "San Francisco")]);
    expect(match.answer?.answer).toBe("San Francisco");
  });
});

describe("residence questions versus work authorisation", () => {
  const locatedInUs = field("Are you located in the United States?", { type: "checkbox", required: true });

  it("never answers a residence question with a work authorisation answer", () => {
    const [match] = matchFields(
      [locatedInUs],
      [answer("Are you legally authorized to work in the United States?", "Yes")],
    );
    expect(match.answer).toBeNull();
  });

  it("rejects a sponsorship answer for a residence question", () => {
    const [match] = matchFields(
      [locatedInUs],
      [answer("Will you now or in the future require visa sponsorship?", "No")],
    );
    expect(match.answer).toBeNull();
  });

  it("uses the residence answer when one exists", () => {
    const [match] = matchFields(
      [locatedInUs],
      [
        answer("Are you legally authorized to work in the United States?", "Yes"),
        answer("Are you located in the United States?", "No"),
      ],
    );
    expect(match.answer?.answer).toBe("No");
  });

  it("still answers genuine work authorisation questions", () => {
    const authField = field("Are you legally authorized to work in the United States?", { type: "checkbox" });
    const [match] = matchFields(
      [authField],
      [answer("Are you legally authorized to work in the United States?", "Yes")],
    );
    expect(match.answer?.answer).toBe("Yes");
  });

  it("answers an authorisation question that is phrased in terms of location", () => {
    const authField = field("Are you legally authorized to work in the location where this role is based?", {
      type: "checkbox",
      required: true,
    });
    const [match] = matchFields(
      [authField],
      [
        answer("Are you legally authorized to work in the country of this role?", "Yes"),
        answer("Are you located in the United States?", "No"),
      ],
    );
    expect(match.answer?.answer).toBe("Yes");
  });
});

describe("self-identification questions", () => {
  const disabilityField = field(
    "Do you have a disability or chronic condition (physical, visual, auditory, cognitive, mental, emotional, other) that substantially limits 1 or more of your major life activities, including mobility, communication (seeing, hearing, speaking), and learning?",
    { required: true },
  );

  it("never answers a disability question with an unrelated answer", () => {
    // "major life activities" overlaps a stored degree major, which put
    // "Computer Science" into a disability field on a live Greenhouse form.
    const [match] = matchFields([disabilityField], [answer("Major/Field of Study", "Computer Science")]);
    expect(match.answer).toBeNull();
  });

  it("uses the demographic answer for a disability question", () => {
    const [match] = matchFields(
      [disabilityField],
      [
        answer("Major/Field of Study", "Computer Science"),
        answer("Disability Status", "I do not wish to answer", { category: "demographic" }),
      ],
    );
    expect(match.answer?.answer).toBe("I do not wish to answer");
  });

  it("does not let a school answer take a gender or veteran question", () => {
    const genderField = field("How would you describe your gender identity?", { required: true });
    const veteranField = field("Are you a veteran, active member or reservist of the US Armed Forces?", {
      required: true,
    });
    const school = [answer("Last University Attended", "University of British Columbia")];
    expect(matchFields([genderField], school)[0].answer).toBeNull();
    expect(matchFields([veteranField], school)[0].answer).toBeNull();
  });
});

describe("self-identification questions", () => {
  const disabilityField = field(
    "Do you have a disability or chronic condition (physical, visual, auditory, cognitive, mental, emotional, other) that substantially limits 1 or more of your major life activities, including mobility, communication (seeing, hearing, speaking), and learning?",
    { required: true },
  );

  it("never lets a bank answer hijack a self-identification question", () => {
    // A bank pattern of "major" matches "major life activities", which put a
    // degree subject into a live disability field.
    const bank = [
      {
        key: "discipline",
        label: "Discipline",
        patterns: ["discipline", "field of study", "major"],
        answer: "Computer Science",
        allowAutoFill: true,
      },
    ];
    expect(fallbackAnswersForFields([disabilityField], [], bank)).toHaveLength(0);
  });

  it("still supplies a demographic bank answer for the same question", () => {
    const bank = [
      {
        key: "disability-self-id",
        label: "Disability self-identification",
        patterns: ["disability or chronic condition"],
        answer: "I don't wish to answer",
        allowAutoFill: true,
      },
    ];
    const extra = fallbackAnswersForFields([disabilityField], [], bank);
    expect(extra).toHaveLength(1);
    expect(extra[0]?.answer).toBe("I don't wish to answer");
  });
});

describe("age questions", () => {
  const ageField = field("At the time of application, are you 18+ years of age?", { required: true });

  it("never answers an age question from a years-of-experience answer", () => {
    // Only the word "years" is shared, but it was enough for the experience
    // threshold answer to declare an experienced engineer a minor on a live
    // Greenhouse form.
    const [match] = matchFields(
      [ageField],
      [answer("Do you have 6+ years of experience", "No")],
    );
    expect(match.answer).toBeNull();
  });

  it("uses a real age answer when one exists", () => {
    const [match] = matchFields(
      [ageField],
      [
        answer("Do you have 6+ years of experience", "No"),
        answer("Are you 18 years of age or older", "Yes"),
      ],
    );
    expect(match.answer?.answer).toBe("Yes");
  });

  it("still answers a genuine experience-threshold question", () => {
    const [match] = matchFields(
      [field("Do you have 6+ years of professional experience?", { required: true })],
      [answer("Do you have 6+ years of experience", "No")],
    );
    expect(match.answer?.answer).toBe("No");
  });
});

describe("degree option candidates", () => {
  const degreeField = field("Degree", { type: "select" });

  it("offers the platform's wording for a credential stated as awarded", () => {
    // Greenhouse lists "Bachelor's Degree"; the profile says "Bachelor of
    // Science (BSc)". Neither contains the other, so the field stayed empty.
    const candidates = optionSearchCandidates(degreeField, answer("Degree", "Bachelor of Science (BSc)"));
    expect(candidates[0]).toBe("Bachelor of Science (BSc)");
    expect(candidates).toContain("Bachelor's Degree");
  });

  it("never widens to a level above the one actually held", () => {
    const candidates = optionSearchCandidates(degreeField, answer("Degree", "Bachelor of Science (BSc)"));
    expect(candidates.some((entry) => /master|doctor|ph\.?d/i.test(entry))).toBe(false);
  });

  it("maps a master's credential to the master's option", () => {
    const candidates = optionSearchCandidates(degreeField, answer("Degree", "Master of Science (MSc)"));
    expect(candidates).toContain("Master's Degree");
  });

  it("leaves unrelated fields alone", () => {
    const candidates = optionSearchCandidates(field("School"), answer("School", "Simon Fraser University"));
    expect(candidates).toEqual(["Simon Fraser University"]);
  });
});

describe("link fields", () => {
  it("does not put a LinkedIn address into a portfolio field", () => {
    const matches = matchFields(
      [field("Portfolio URL")],
      [answer("LinkedIn Profile", "https://www.linkedin.com/in/example/")],
    );
    expect(matches[0]?.answer ?? undefined).toBeUndefined();
  });

  it("does not put a LinkedIn address into an other-website field", () => {
    const matches = matchFields(
      [field("Other website")],
      [answer("LinkedIn Profile", "https://www.linkedin.com/in/example/")],
    );
    expect(matches[0]?.answer ?? undefined).toBeUndefined();
  });

  it("still fills the field naming the same service", () => {
    const matches = matchFields(
      [field("LinkedIn Profile", { required: true })],
      [answer("LinkedIn Profile", "https://www.linkedin.com/in/example/")],
    );
    expect(matches[0]?.answer?.answer).toBe("https://www.linkedin.com/in/example/");
  });

  it("leaves unnamed link fields alone", () => {
    const matches = matchFields([field("GitHub URL")], [answer("GitHub", "https://github.com/example")]);
    expect(matches[0]?.answer?.answer).toBe("https://github.com/example");
  });
});

describe("permission and date-component questions", () => {
  it("refuses to answer a contact-permission question with an employer name", () => {
    const matches = matchFields(
      [field("May we contact your current employer?*", { required: true })],
      [answer("Current company", "Microsoft")],
    );
    expect(matches[0]?.answer ?? undefined).toBeUndefined();
  });

  it("still answers a contact-permission question with yes or no", () => {
    const matches = matchFields(
      [field("May we contact your current employer?*", { required: true })],
      [answer("May we contact your current employer", "No")],
    );
    expect(matches[0]?.answer?.answer).toBe("No");
  });

  it("refuses to put a notice period into an employment-history date select", () => {
    const matches = matchFields(
      [field("Start date month*", { required: true })],
      [answer("Start date", "Approximately four weeks from offer acceptance")],
    );
    expect(matches[0]?.answer ?? undefined).toBeUndefined();
  });

  it("still answers a plain start date question with a notice period", () => {
    const matches = matchFields(
      [field("Start date")],
      [answer("Start date", "Approximately four weeks from offer acceptance")],
    );
    expect(matches[0]?.answer?.answer).toBe("Approximately four weeks from offer acceptance");
  });
});

describe("qualified affirmative options", () => {  const options = [
    "Yes, no restriction.",
    "Yes, but I will need sponsorship in the future.",
    "No, I need sponsorship now.",
  ];

  it("reads a bare Yes as the unqualified option", () => {
    expect(pickOptionIndex(options, ["Yes"])).toBe(0);
  });

  it("does not depend on the order the board lists the options in", () => {
    const reordered = [options[1] as string, options[0] as string, options[2] as string];
    expect(pickOptionIndex(reordered, ["Yes"])).toBe(1);
  });

  it("still honours a candidate that names the qualification", () => {
    expect(pickOptionIndex(options, ["Yes, but I will need sponsorship in the future."])).toBe(1);
  });

  it("reads a bare No as the negative option", () => {
    expect(pickOptionIndex(options, ["No"])).toBe(2);
  });
});

describe("product usage options", () => {  const usageField = field("We're always curious - have you used Tailscale before?*", { required: true });
  const options = [
    "Yes, on my personal devices.",
    "Yes, at work.",
    "Yes, both personally and at work.",
    "I haven't used it, but I'm excited to learn more!",
  ];

  it("reaches the negative option when the list offers no plain No", () => {
    const candidates = optionSearchCandidates(usageField, answer("Have you used our product", "No"));
    expect(pickOptionIndex(options, candidates)).toBe(3);
  });

  it("does not widen a yes into a claim about how the product was used", () => {
    const candidates = optionSearchCandidates(usageField, answer("Have you used our product", "Yes"));
    expect(candidates).toEqual(["Yes"]);
  });

  it("leaves unrelated questions alone", () => {
    const candidates = optionSearchCandidates(field("Are you legally authorized to work?"), answer("Work auth", "No"));
    expect(candidates).toEqual(["No"]);
  });
});

describe("sole consent option", () => {
  const options = ["I agree to these expectations"];
  it("consents when nothing else can be selected", () => {
    // Block's 700-character interview-expectations block mentions "previous
    // employers", which pulled in a stored employer answer of "Microsoft".
    // That is not an affirmative, but consent is the only available action.
    expect(pickOptionIndex(options, ["Microsoft"])).toBe(0);
  });

  it("still consents for a plainly affirmative answer", () => {
    expect(pickOptionIndex(options, ["Yes"])).toBe(0);
  });

  it("does not override an explicit decline", () => {
    expect(pickOptionIndex(options, ["I do not wish to answer"])).toBe(-1);
  });

  it("does not override an explicit no", () => {
    expect(pickOptionIndex(options, ["No"])).toBe(-1);
  });

  it("does not invent consent when the sole option is not a consent phrase", () => {
    expect(pickOptionIndex(["Microsoft"], ["Yes"])).toBe(-1);
  });
});

describe("repeated standalone fields", () => {
  const bank = [
    { key: "acknowledgement", label: "I acknowledge and agree", patterns: ["i acknowledge", "i certify"], answer: "Yes", allowAutoFill: true },
    { key: "linkedin", label: "LinkedIn", patterns: ["linkedin"], answer: "https://www.linkedin.com/in/example/", allowAutoFill: true },
  ];

  it("answers every acknowledgement box on a form, not just the first", () => {
    const fields = [
      field("I acknowledge the privacy policy", { selectorIndex: 0, type: "checkbox", required: true }),
      field("I certify that the information I have provided is accurate", { selectorIndex: 1, type: "checkbox", required: true }),
    ];
    const derived = fallbackAnswersForFields(fields, [], bank);
    expect(derived).toHaveLength(2);
    expect(derived.every((entry) => entry.answer === "Yes")).toBe(true);
  });

  it("fills a duplicated profile field such as LinkedIn twice", () => {
    const fields = [
      field("LinkedIn", { selectorIndex: 0 }),
      field("LinkedIn Profile", { selectorIndex: 1 }),
    ];
    expect(fallbackAnswersForFields(fields, [], bank)).toHaveLength(2);
  });

  it("still spends a radio answer only once across its options", () => {
    const fields = [
      field("Consent", { selectorIndex: 0, type: "radio", optionLabel: "Yes" }),
      field("Consent", { selectorIndex: 1, type: "radio", optionLabel: "No" }),
    ];
    const derived = fallbackAnswersForFields(fields, [], [
      { key: "consent", label: "Consent", patterns: ["consent"], answer: "Yes", allowAutoFill: true },
    ]);
    expect(derived.length).toBeLessThanOrEqual(1);
  });
});

describe("looksLikeApplicationForm", () => {
  it("rejects a job index page that only exposes board filters", () => {
    const fields = [field("Search"), field("Department", { type: "select" })];
    expect(looksLikeApplicationForm(fields)).toBe(false);
  });

  it("accepts a form carrying a resume upload", () => {
    const fields = [field("Search"), field("Resume/CV", { type: "file" })];
    expect(looksLikeApplicationForm(fields)).toBe(true);
  });

  it("accepts a form carrying core applicant fields", () => {
    const fields = [field("First Name"), field("Last Name"), field("Email")];
    expect(looksLikeApplicationForm(fields)).toBe(true);
  });

  it("accepts a form whose only core field is a single full name box", () => {
    expect(looksLikeApplicationForm([field("Full name"), field("Department")])).toBe(true);
  });
});
describe("how did you hear about us", () => {
  const sourceField = field("How did you hear about this job?", { optionLabel: "LinkedIn" });

  it("walks the preference order until the board offers an option", () => {
    const candidates = optionSearchCandidates(sourceField, answer("How did you hear about us?", "Friend"));
    const notionOptions = [
      "LinkedIn",
      "Glassdoor",
      "Notion Blog",
      "Notion Employee",
      "Notion Website",
      "Billboard/Outdoor Ads",
      "Conference or Meetup",
    ];
    expect(pickOptionIndex(notionOptions, candidates)).toBe(4);
  });

  it("never claims an employee referral that did not happen", () => {
    const candidates = optionSearchCandidates(sourceField, answer("How did you hear about us?", "Friend"));
    expect(pickOptionIndex(["Notion Employee", "Conference or Meetup"], candidates)).toBe(-1);
  });

  it("prefers the stated answer when the board offers it", () => {
    const candidates = optionSearchCandidates(sourceField, answer("How did you hear about us?", "Friend"));
    expect(pickOptionIndex(["LinkedIn", "Friend", "Other"], candidates)).toBe(1);
  });

  it("leaves unrelated option groups untouched", () => {
    const candidates = optionSearchCandidates(field("Preferred office"), answer("Preferred office", "Friend"));
    expect(candidates).toEqual(["Friend"]);
  });
});
describe("whole-name questions", () => {
  const nameAnswers = [
    answer("Full Name", "Nirag Mehta"),
    answer("First Name", "Nirag"),
    answer("Last Name", "Mehta"),
  ];

  it("fills a combined first-and-last name field with the whole name", () => {
    const [match] = matchFields([field("Legal First and Last Name *", { required: true })], nameAnswers);
    expect(match.answer?.answer).toBe("Nirag Mehta");
  });

  it("never lets a name fragment answer a combined name field", () => {
    for (const label of ["First and Last Name", "First & Last Name", "First, Middle and Last Name"]) {
      const [match] = matchFields([field(label)], [answer("Last Name", "Mehta"), answer("First Name", "Nirag")]);
      expect(match.answer ?? null).toBeNull();
    }
  });

  it("still fills the separate name fields from their own fragments", () => {
    const matches = matchFields(
      [field("Preferred First Name"), field("Preferred Last Name")],
      nameAnswers,
    );
    expect(matches[0]?.answer?.answer).toBe("Nirag");
    expect(matches[1]?.answer?.answer).toBe("Mehta");
  });
});
describe("decline answers in free-text boxes", () => {
  const decline = answer("Pronouns", "I prefer not to say");

  it("types the answer as written into a plain text box", () => {
    expect(answerValueForField(field("Pronouns"), decline)).toBe("I prefer not to say");
    expect(answerValueForField(field("Pronouns", { type: "textarea" }), decline)).toBe("I prefer not to say");
  });

  it("still uses the decline search key for controls that offer options", () => {
    expect(answerValueForField(field("Gender", { type: "select-one" }), decline)).toBe("wish to answer");
    expect(answerValueForField(field("Gender", { type: "radio", optionLabel: "I do not wish to answer" }), decline)).toBe(
      "wish to answer",
    );
    expect(answerValueForField(field("Gender", { type: "text", role: "combobox" }), decline)).toBe("wish to answer");
  });
});
describe("greenhouse education blocks", () => {
  const eduFields = [
    field("School*", { selectorIndex: 0, domId: "school--0", required: true }),
    field("End date year*", { selectorIndex: 1, domId: "end-year--0", required: true, type: "number" }),
  ];

  it("recognises the graduation year behind an ambiguous label", () => {
    const labels = educationDateLabels(eduFields);
    expect(labels.get(1)).toBe("Graduation year");
  });

  it("leaves an employment end date alone", () => {
    const labels = educationDateLabels([
      field("Company*", { selectorIndex: 0, domId: "company--0" }),
      field("End date year*", { selectorIndex: 1, domId: "end-year--0" }),
    ]);
    expect(labels.size).toBe(0);
  });

  it("declines when one index carries both a school and a company", () => {
    const labels = educationDateLabels([
      field("School*", { selectorIndex: 0, domId: "school--0" }),
      field("Company*", { selectorIndex: 1, domId: "company--0" }),
      field("End date year*", { selectorIndex: 2, domId: "end-year--0" }),
    ]);
    expect(labels.size).toBe(0);
  });

  it("asks the resolver for the graduation year, and binds it to the live label", () => {
    const asked: string[] = [];
    const derived = fallbackAnswersForFields(eduFields, [], [], (label) => {
      asked.push(label);
      if (!/graduation/i.test(label)) return null;
      return { answer: "2020", authorized: true, citation: "education[0].end", category: "education" };
    });
    expect(asked).toContain("Graduation year");
    const year = derived.find((entry) => entry.citation === "education[0].end");
    expect(year?.answer).toBe("2020");
    expect(year?.label).toBe("End date year*");
  });
});
describe("questions about where the candidate is right now", () => {
  const harveyLabel =
    "Are you currently based in the listed location and able to work in person 3 days per week?";
  const options = [
    "Yes, I'm based in this location and able to work from the office 3 days per week",
    "No, I'm not based in this location but willing to relocate",
    "No, I'm only able to work remotely",
    "Other (optional context)",
  ];

  function radios(label: string) {
    return options.map((optionLabel, index) =>
      field(label, { type: "radio", optionLabel, selectorIndex: index }),
    );
  }

  it("refuses a willing-to-commute answer on the residence half of a compound question", () => {
    const hybrid = answer("Able to work in person 3 days per week", "Yes");
    const matches = matchFields(radios(harveyLabel), [hybrid]);
    expect(matches.filter((match) => match.answer)).toEqual([]);
  });

  it("still lets a willing-to-commute answer fill a question that only asks about commuting", () => {
    const hybrid = answer("Able to work in person 3 days per week", "Yes");
    const commute = [
      field("Are you able to work in person 3 days per week?", { type: "radio", optionLabel: "Yes", selectorIndex: 0 }),
      field("Are you able to work in person 3 days per week?", { type: "radio", optionLabel: "No", selectorIndex: 1 }),
    ];
    const chosen = matchFields(commute, [hybrid]).find((match) => match.answer);
    expect(chosen?.field.optionLabel).toBe("Yes");
  });

  it("answers the compound question from the stored residence fact", () => {
    const based = answer(
      "Currently based in the role's location",
      "No - based in Vancouver, Canada and willing to relocate.",
    );
    const chosen = matchFields(radios(harveyLabel), [based]).find((match) => match.answer);
    expect(chosen?.field.optionLabel).toBe("No, I'm not based in this location but willing to relocate");
  });

  it("keeps the residence fact when a relocation-willingness answer competes for it", () => {
    const based = answer(
      "Currently based in the role's location",
      "No - based in Vancouver, Canada and willing to relocate.",
    );
    const relocation = answer("Open to relocation", "Yes");
    const chosen = matchFields(radios(harveyLabel), [relocation, based]).find((match) => match.answer);
    expect(chosen?.field.optionLabel).toBe("No, I'm not based in this location but willing to relocate");
  });
});
describe("choosing between options that all match", () => {
  const options = [
    "Yes, I'm based in this location and able to work from the office 3 days per week",
    "No, I'm not based in this location but willing to relocate",
    "No, I'm only able to work remotely",
    "Other (optional context)",
  ];

  it("prefers the option carrying what the answer actually says over the shortest one", () => {
    const index = pickOptionIndex(options, ["No - based in Vancouver, Canada and willing to relocate."]);
    expect(options[index]).toBe("No, I'm not based in this location but willing to relocate");
  });

  it("still prefers the least elaborated option when the answer is bare", () => {
    const sponsorship = [
      "Yes, no restriction.",
      "Yes, but I will need sponsorship in the future.",
      "No, I need sponsorship now.",
    ];
    const index = pickOptionIndex(sponsorship, ["Yes"]);
    expect(sponsorship[index]).toBe("Yes, no restriction.");
  });
});
describe("contact fields judged by the shape of the value", () => {
  it("does not write an SMS consent sentence into the phone box", () => {
    const matches = matchFields(
      [field("Phone Number", { type: "text", selectorIndex: 0 })],
      [
        answer("Phone Number", "No - I do not consent to receiving text messages"),
        answer("Phone", "604-653-6919"),
      ],
    );
    expect(matches[0]?.answer?.answer).toBe("604-653-6919");
  });

  it("still accepts a phone number written in any punctuation", () => {
    const matches = matchFields(
      [field("Mobile phone", { type: "text", selectorIndex: 0 })],
      [answer("Phone", "+1 (604) 653 6919")],
    );
    expect(matches[0]?.answer?.answer).toBe("+1 (604) 653 6919");
  });

  it("does not write a sentence into an email box", () => {
    const matches = matchFields(
      [field("Email", { type: "text", selectorIndex: 0 })],
      [answer("Email preference", "I do not wish to be emailed")],
    );
    expect(matches[0]?.answer).toBeNull();
  });
});
describe("a contact detail may not answer a question about its kind", () => {
  // Workday renders "Phone Number" and "Phone Device Type" side by side. Both
  // carry the word "phone", so the stored number won the type question and the
  // filler searched a Home/Home Cellular menu for a telephone number. Step one
  // of the wizard then refused to save, and every Workday application stalled.
  const phoneType = field("Phone Device Type", { type: "select", required: true });

  it("does not let the phone number fill the device type", () => {
    const matches = matchFields([phoneType], [answer("Phone", "+1 604 555 0134")]);
    expect(matches[0]?.answer).toBeNull();
  });

  it("still lets a device-type answer fill it", () => {
    const matches = matchFields([phoneType], [answer("Phone Device Type", "Mobile")]);
    expect(matches[0]?.answer?.answer).toBe("Mobile");
  });

  it("prefers the device type when both answers are offered", () => {
    const matches = matchFields(
      [phoneType],
      [answer("Phone", "+1 604 555 0134"), answer("Phone Device Type", "Mobile")],
    );
    expect(matches[0]?.answer?.answer).toBe("Mobile");
  });

  it("leaves the phone number field itself alone", () => {
    const matches = matchFields(
      [field("Phone Number", { required: true })],
      [answer("Phone", "+1 604 555 0134"), answer("Phone Device Type", "Mobile")],
    );
    expect(matches[0]?.answer?.answer).toBe("+1 604 555 0134");
  });

  // NVIDIA's review page read "+1 (604) 6536919 x604-653-6919": the number had
  // also been typed into the extension beside it, giving a number that cannot
  // be dialled. No stored answer is an extension, so none may fill one.
  it("does not let the phone number fill the extension", () => {
    const matches = matchFields(
      [field("Phone Extension", { required: false })],
      [answer("Phone", "+1 604 555 0134")],
    );
    expect(matches[0]?.answer).toBeNull();
  });

  it("still lets an extension answer fill an extension field", () => {
    const matches = matchFields([field("Extension", { required: true })], [answer("Extension", "204")]);
    expect(matches[0]?.answer?.answer).toBe("204");
  });
});


describe("a place name may not answer a work authorization question", () => {
  // NVIDIA asks "Are you legally authorized to work in the country where this
  // position is located?". It shares the word "country" with the stored country
  // answer, which outscored the work-authorization answer, so the filler offered
  // "Canada" to a Yes/No menu. Nothing matched and the wizard stalled - but on a
  // menu that did list countries it would have answered a legal question with a
  // place name and never noticed.
  const authField = field("Are you legally authorized to work in the country where this position is located?", {
    type: "select",
    required: true,
    options: ["Select One", "Yes", "No"],
  });

  it("does not let a country answer fill it", () => {
    const matches = matchFields([authField], [answer("Country", "Canada")]);
    expect(matches[0]?.answer).toBeNull();
  });

  it("prefers the work authorization answer when both are offered", () => {
    const matches = matchFields(
      [authField],
      [
        answer("Country", "Canada"),
        answer("Are you legally authorized to work in the country of this role?", "Yes"),
      ],
    );
    expect(matches[0]?.answer?.answer).toBe("Yes");
  });

  it("keeps a sponsorship question away from the country answer too", () => {
    const sponsorField = field(
      "Will you require employer support to obtain or maintain authorization to work in that country? e.g. (work permit)",
      { type: "select", required: true, options: ["Select One", "Yes", "No"] },
    );
    const matches = matchFields([sponsorField], [answer("Country", "Canada")]);
    expect(matches[0]?.answer).toBeNull();
  });

  it("still fills a plain country field", () => {
    const matches = matchFields([field("Country", { required: true })], [answer("Country", "Canada")]);
    expect(matches[0]?.answer?.answer).toBe("Canada");
  });
});

describe("sponsorship asked without the word", () => {
  // NVIDIA: "Will you require employer support to obtain or maintain
  // authorization to work in that country? e.g. (work permit)". Thirteen stored
  // patterns cover this question and none of them matches this wording, so a
  // decision already on file was left blank and the Workday wizard stalled.
  const bank = [
    {
      key: "visa-sponsorship",
      label: "Will you now or in the future require visa sponsorship?",
      answer: "No",
      patterns: ["require visa sponsorship", "need sponsorship"],
      allowAutoFill: true,
    },
  ];
  const ask = (label: string) =>
    fallbackAnswersForFields(
      [field(label, { type: "select", required: true, options: ["Yes", "No"] })],
      [],
      bank as never,
    );

  it("routes the stored answer to the paraphrase", () => {
    const derived = ask("Will you require employer support to obtain or maintain authorization to work in that country? e.g. (work permit)");
    expect(derived[0]?.answer).toBe("No");
    expect(derived[0]?.citation).toBe("profile.answers.visa-sponsorship");
  });

  it("still matches the ordinary wording", () => {
    expect(ask("Will you now or in the future require visa sponsorship?")[0]?.answer).toBe("No");
  });

  it("refuses a form that defines sponsorship by naming TN", () => {
    // TN needs no petition but does need a letter of support, so the generic No
    // is the wrong answer to this question. It belongs to a person.
    const derived = ask("Will you require sponsorship (for example TN, H-1B or E-3) to work in the United States?");
    expect(derived).toHaveLength(0);
  });

  it("does not answer an unrelated support question", () => {
    expect(ask("Do you require any accommodations during the interview process?")).toHaveLength(0);
  });
});

describe("a field that arrives already answered", () => {
  it("is not reported as an unanswered required field", () => {
    // NVIDIA's disability form ships with Language set to English. Reporting it
    // as unanswered stalled the wizard on a question already answered.
    const plan = buildFillPlan(
      [{ ...field("Language", { type: "select", required: true }), value: "English" }],
      [],
      [],
    );
    expect(plan.unmatchedRequired).toHaveLength(0);
  });

  it("still reports one holding only a placeholder", () => {
    const plan = buildFillPlan(
      [{ ...field("Language", { type: "select", required: true }), value: "Select One" }],
      [],
      [],
    );
    expect(plan.unmatchedRequired).toHaveLength(1);
  });

  it("still reports a segmented date showing its parts as separate lines", () => {
    const plan = buildFillPlan(
      [{ ...field("Date", { type: "date", required: true }), value: "MM\n/\nDD\n/\nYYYY" }],
      [],
      [],
    );
    expect(plan.unmatchedRequired).toHaveLength(1);
  });
});

describe("a form the candidate signs", () => {
  const dateField = (name: string, questionLabel?: string) => ({
    ...field("Date", { type: "date", required: true }),
    name,
    questionLabel,
  });

  it("dates the signature today", () => {
    const derived = fallbackAnswersForFields([dateField("dateSignedOn", "date signed on")], [], []);
    const now = new Date();
    const expected = `${String(now.getMonth() + 1).padStart(2, "0")}/${String(now.getDate()).padStart(2, "0")}/${now.getFullYear()}`;
    expect(derived[0]?.answer).toBe(expected);
    expect(derived[0]?.citation).toBe("system.today");
  });

  it("leaves a remembered date to the profile", () => {
    // "Start date" is employment history, not a signature.
    expect(fallbackAnswersForFields([dateField("startDate", "start date")], [], [])).toHaveLength(0);
  });
});

describe("a date control only takes a date", () => {
  // Adobe's education block asks "From" and "To" as date controls. The stored
  // notice period ("Approximately four weeks from offer acceptance") shares
  // "from" with the label and won it, and a bare "Yes" won "To". The browser
  // refused to type either, so both required fields stayed empty, the step
  // would not advance, and the run spent its whole step budget retrying.
  it("refuses a notice period on a date field", () => {
    const matches = matchFields(
      [field("From", { type: "date", required: true })],
      [answer("Notice period", "Approximately four weeks from offer acceptance.")],
    );
    expect(matches[0]?.answer).toBeNull();
  });

  it("refuses a bare yes on a date field", () => {
    const matches = matchFields(
      [field("To", { type: "date", required: true })],
      [answer("To", "Yes")],
    );
    expect(matches[0]?.answer).toBeNull();
  });

  it("still fills a date field with a date", () => {
    const matches = matchFields(
      [field("Date", { type: "date", required: true })],
      [answer("Date", "08/16/2026")],
    );
    expect(matches[0]?.answer?.answer).toBe("08/16/2026");
  });
});
