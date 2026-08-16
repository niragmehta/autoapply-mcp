import { describe, expect, it } from "vitest";
import { draftAnswers, type FormQuestion } from "../src/drafting/answers.js";
import { autoFillableFields, resolvePersonal } from "../src/drafting/personal.js";
import { computeManifestHash } from "../src/db/repositories/batches.js";
import { ProfileSchema } from "../src/domain/profile.js";
import { makeCampaign, makeProfile } from "./factories.js";

const campaign = makeCampaign();

function withPersonal(personal: Record<string, unknown>) {
  const base = makeProfile();
  return ProfileSchema.parse({ ...base, personal });
}

function question(label: string, overrides: Partial<FormQuestion> = {}): FormQuestion {
  return { key: label.toLowerCase().replace(/\W+/g, "_"), label, required: false, type: "input_text", ...overrides };
}

describe("personal data defaults", () => {
  it("defaults to storing nothing and auto-filling nothing", () => {
    const profile = makeProfile();
    expect(profile.personal.dateOfBirth.value).toBe("");
    expect(profile.personal.dateOfBirth.autoFill).toBe(false);
    expect(profile.personal.demographics.gender.autoFill).toBe(false);
    expect(autoFillableFields(profile)).toEqual([]);
  });
});

describe("resolvePersonal", () => {
  const profile = withPersonal({
    dateOfBirth: { value: "1998-04-12", autoFill: true },
    address: { street: "1 Main St", city: "Vancouver", region: "BC", postalCode: "V6B 1A1", country: "Canada" },
    addressAutoFill: true,
    demographics: {
      gender: { value: "Decline to self-identify", autoFill: true },
      disabilityStatus: { value: "I do not wish to answer", autoFill: false },
    },
  });

  it("resolves an opted-in field as authorized", () => {
    const result = resolvePersonal("Date of Birth", profile);
    expect(result?.answer).toBe("1998-04-12");
    expect(result?.authorized).toBe(true);
    expect(result?.citation).toBe("personal.dateOfBirth");
  });

  it("resolves a stored but not opted-in field as unauthorized", () => {
    const result = resolvePersonal("Do you have a disability?", profile);
    expect(result?.answer).toBe("I do not wish to answer");
    expect(result?.authorized).toBe(false);
  });

  it("formats a full address", () => {
    expect(resolvePersonal("Street Address", profile)?.answer).toContain("1 Main St");
  });

  it("keeps a Current Location question on the identity location", () => {
    // A geocoded location control takes the metro area from identity. A bare
    // "City" does not: it belongs to an address block, and his decision of
    // 2026-08-16 is that it must agree with the street and postal code beside
    // it rather than contradict them.
    expect(resolvePersonal("Current Location", profile)?.citation).toBe("identity.location");
    expect(resolvePersonal("City", profile)?.citation).toBe("personal.address.city");
  });

  it("does not treat an email field as a postal address", () => {
    expect(resolvePersonal("Email Address", profile)).toBeNull();
  });

  it("answers numbered address lines with the street only", () => {
    const result = resolvePersonal("Address Line 1", profile);
    expect(result?.answer).toBe("1 Main St");
    expect(result?.citation).toBe("personal.address.street");
  });

  it("returns null when nothing is stored", () => {
    expect(resolvePersonal("What is your favourite colour?", profile)).toBeNull();
    expect(resolvePersonal("Are you a protected veteran?", profile)).toBeNull();
  });

  it("lists only opted-in fields", () => {
    const fields = autoFillableFields(profile);
    expect(fields).toContain("personal.dateOfBirth");
    expect(fields).toContain("personal.demographics.gender");
    expect(fields).not.toContain("personal.demographics.disabilityStatus");
  });

  it("resolves camel case compliance labels", () => {
    const p = withPersonal({
      demographics: {
        gender: { value: "Decline to self-identify", autoFill: true },
        veteranStatus: { value: "I am not a protected veteran", autoFill: true },
        disabilityStatus: { value: "I do not want to answer", autoFill: true },
        hispanicLatino: { value: "Decline to self-identify", autoFill: true },
      },
    });
    expect(resolvePersonal("DisabilityStatus", p)?.answer).toBe("I do not want to answer");
    expect(resolvePersonal("VeteranStatus", p)?.answer).toBe("I am not a protected veteran");
    expect(resolvePersonal("HispanicLatino", p)?.answer).toBe("Decline to self-identify");
    expect(resolvePersonal("Gender", p)?.authorized).toBe(true);
  });
});

describe("draftAnswers with personal data", () => {
  it("auto-fills demographic questions only when opted in", () => {
    const profile = withPersonal({
      demographics: {
        gender: { value: "Decline to self-identify", autoFill: true },
        raceEthnicity: { value: "Decline to self-identify", autoFill: false },
      },
    });
    const { answers } = draftAnswers(
      [question("Please select your gender"), question("What is your race/ethnicity?")],
      profile,
      campaign,
    );
    const gender = answers.find((a) => a.label.includes("gender"));
    const race = answers.find((a) => a.label.includes("race"));

    expect(gender?.requiresHuman).toBe(false);
    expect(gender?.answer).toBe("Decline to self-identify");
    expect(gender?.citation).toBe("personal.demographics.gender");

    expect(race?.requiresHuman).toBe(true);
  });

  it("still blocks demographic questions when nothing is stored", () => {
    const { answers } = draftAnswers([question("Please select your gender")], makeProfile(), campaign);
    expect(answers[0]?.requiresHuman).toBe(true);
    expect(answers[0]?.source).toBe("blocked");
  });

  it("never auto-fills work authorization from personal data", () => {
    const profile = withPersonal({ dateOfBirth: { value: "1998-04-12", autoFill: true } });
    const { answers } = draftAnswers(
      [question("Will you now or in the future require visa sponsorship?")],
      profile,
      campaign,
    );
    expect(answers[0]?.requiresHuman).toBe(true);
    expect(answers[0]?.category).toBe("sponsorship");
  });

  it("honours an explicit pre-approved answer for a blocked category", () => {
    const base = makeProfile();
    const profile = ProfileSchema.parse({
      ...base,
      answers: [
        ...base.answers,
        {
          key: "salary",
          label: "Desired salary",
          patterns: ["desired salary"],
          answer: "Open to discussion",
          allowAutoFill: true,
        },
      ],
    });
    const { answers } = draftAnswers([question("Desired salary")], profile, campaign);
    expect(answers[0]?.requiresHuman).toBe(false);
    expect(answers[0]?.source).toBe("approved-answer");
  });
});

describe("computeManifestHash", () => {
  const items = [
    { applicationId: "app_2", packetHash: "hash-b" },
    { applicationId: "app_1", packetHash: "hash-a" },
  ];

  it("is independent of ordering", () => {
    expect(computeManifestHash(items)).toBe(computeManifestHash([...items].reverse()));
  });

  it("changes when any packet changes", () => {
    const changed = [{ applicationId: "app_1", packetHash: "hash-a" }, { applicationId: "app_2", packetHash: "hash-CHANGED" }];
    expect(computeManifestHash(items)).not.toBe(computeManifestHash(changed));
  });

  it("changes when an application is added or removed", () => {
    const extra = [...items, { applicationId: "app_3", packetHash: "hash-c" }];
    expect(computeManifestHash(items)).not.toBe(computeManifestHash(extra));
    expect(computeManifestHash(items)).not.toBe(computeManifestHash([items[0]!]));
  });

  it("is stable for an empty batch", () => {
    expect(computeManifestHash([])).toBe(computeManifestHash([]));
  });
});

describe("education resolution", () => {
  const graduate = ProfileSchema.parse({
    ...makeProfile(),
    education: [
      { institution: "Older College", credential: "Diploma", field: "General", end: "2016-05" },
      { institution: "Simon Fraser University", credential: "Bachelor of Science (BSc)", field: "Computer Science", end: "2020-12" },
    ],
  });

  it("answers school, degree, field and graduation year from the most recent entry", () => {
    expect(resolvePersonal("What is the most recent school you attended?", graduate)?.answer).toBe(
      "Simon Fraser University",
    );
    expect(resolvePersonal("What is the most recent degree you obtained?", graduate)?.answer).toBe(
      "Bachelor of Science (BSc)",
    );
    expect(resolvePersonal("Field of study", graduate)?.answer).toBe("Computer Science");
    expect(resolvePersonal("Graduation year", graduate)?.answer).toBe("2020");
  });

  it("treats education as pre-authorized resume fact, not a sensitive disclosure", () => {
    expect(resolvePersonal("University", graduate)?.authorized).toBe(true);
  });

  it("stays silent when no education is recorded", () => {
    expect(resolvePersonal("What is the most recent school you attended?", makeProfile())).toBeNull();
  });

  it("does not let a school question claim a disability question", () => {
    // "major life activities" contains "major"; the disability resolver must
    // still own the label. It declines here only because nothing is stored.
    const disability = resolvePersonal(
      "Do you have a disability that substantially limits one or more major life activities?",
      graduate,
    );
    expect(disability?.category ?? null).not.toBe("education");
  });
});

describe("voluntary self-identification wording", () => {
  // Boards rarely use the words "sexual orientation": Faire asks about the
  // LGBTQIA+ community, which matched nothing and blocked the application.
  it("recognizes an LGBTQIA+ question as the orientation field", () => {
    const profile = withPersonal({
      demographics: { sexualOrientation: { value: "Decline to self-identify", autoFill: true } },
    });
    const resolved = resolvePersonal("Do you consider yourself a member of the LGBTQIA+ community?", profile);
    expect(resolved?.citation).toBe("personal.demographics.sexualOrientation");
    expect(resolved?.answer).toBe("Decline to self-identify");
  });

  it("still recognizes the formal wording", () => {
    const profile = withPersonal({
      demographics: { sexualOrientation: { value: "Decline to self-identify", autoFill: true } },
    });
    expect(resolvePersonal("What is your sexual orientation?", profile)?.citation).toBe(
      "personal.demographics.sexualOrientation",
    );
  });
});

/**
 * Greenhouse renders "Location (City)" as a core field that most boards omit
 * from their published question schema, so only this fallback can fill it.
 * Nothing resolved it, and otherwise complete applications aborted.
 */
describe("the location field Greenhouse renders but does not publish", () => {
  const profile = withPersonal({
    address: { street: "1 Main St", city: "Burnaby", region: "BC", postalCode: "V5H 0A1", country: "Canada" },
    addressAutoFill: true,
  });

  it("fills it with the whole identity location, not the mailing city", () => {
    const result = resolvePersonal("Location (City)*", profile);
    expect(result?.answer).toBe("Vancouver, BC, Canada");
    expect(result?.citation).toBe("identity.location");
    expect(result?.authorized).toBe(true);
  });

  it("leaves a bare City box on the address it belongs to", () => {
    expect(resolvePersonal("City", profile)?.answer).toBe("Burnaby");
  });

  it("does not claim a question that merely mentions a location", () => {
    expect(resolvePersonal("Are you willing to relocate to the location of this role?", profile)).toBeNull();
    expect(resolvePersonal("Are you authorized to work in the location of this role?", profile)).toBeNull();
  });

  it("still leaves component boxes to the rules written for them", () => {
    expect(resolvePersonal("Location - State", profile)?.citation).toBe("personal.address.region");
    expect(resolvePersonal("Location Postal Code", profile)?.citation).toBe("personal.address.postalCode");
  });
});
