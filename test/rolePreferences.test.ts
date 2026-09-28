import { describe, expect, it } from "vitest";
import { ProfileSchema } from "../src/domain/profile.js";
import { evaluateGates } from "../src/ranking/gates.js";
import { makeCampaign, makeJob, makeProfile } from "./factories.js";

describe("role search preferences", () => {
  it("preserves the candidate's search notes through profile validation", () => {
    const profile = makeProfile();
    const notes = "Consider reasonable non-security matches. Do not apply to frontend roles.";
    const parsed = ProfileSchema.parse({
      ...profile,
      preferences: { ...profile.preferences, roleSearchNotes: notes },
    });
    expect(parsed.preferences).toMatchObject({ roleSearchNotes: notes });
    expect(parsed.workAuthorization).toEqual(profile.workAuthorization);
    expect(parsed.personal.demographics).toEqual(profile.personal.demographics);
  });

  it("keeps profiles without search notes backward compatible", () => {
    expect(makeProfile().preferences).toMatchObject({ roleSearchNotes: "" });
  });
});

/**
 * Search notes are guidance for a person, not a gate. The owner's "no frontend
 * roles" rule is enforced by campaign title exclusions; these guard that rule.
 */
describe("frontend exclusion through campaign title patterns", () => {
  const context = {
    profile: makeProfile(),
    campaign: makeCampaign({
      exclusions: { titlePatterns: ["frontend", "front-end", "front end"], companies: [], descriptionPatterns: [] },
    }),
  };

  it.each(["Senior Frontend Engineer", "Front-End Software Engineer", "Senior Front End Developer"])(
    "uses existing campaign exclusions to block %s", (title) => {
      expect(evaluateGates(makeJob({ title }), context).rule).toBe("title-excluded");
    },
  );

  it("does not block a backend role merely because the description mentions frontend partners", () => {
    expect(evaluateGates(makeJob({
      title: "Senior Backend Software Engineer",
      descriptionText: "Build distributed services and collaborate with frontend engineers.",
    }), context).passed).toBe(true);
  });
});
