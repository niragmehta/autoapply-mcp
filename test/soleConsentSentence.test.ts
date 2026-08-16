import { describe, expect, it } from "vitest";

import { pickOptionIndex } from "../src/submission/formFields.js";

/**
 * A required select offering exactly one option carries no decision: the option
 * is the only submittable value. That was already handled for options written
 * as a bare verb ("Acknowledge/Confirm"), but Vercel writes the same formality
 * as a first-person sentence, and the anchored pattern missed it. A fully
 * prepared Product Security Engineer application aborted on a box a person
 * could only ever answer one way.
 */
const VERCEL_ATTESTATION =
  "I have reviewed and confirmed that all the information provided is accurate and complete.";

describe("a lone consent option written as a sentence", () => {
  it("takes Vercel's accuracy attestation from a stored yes", () => {
    expect(pickOptionIndex([VERCEL_ATTESTATION], ["Yes"])).toBe(0);
  });

  it("still takes the bare-verb wording other boards use", () => {
    expect(pickOptionIndex(["Acknowledge/Confirm"], ["Yes"])).toBe(0);
  });

  it("leaves a lone option that states a fact about the candidate alone", () => {
    // "I have 6 or more years of experience" opens the same way as the
    // attestation but is a claim, not a formality. years-experience-threshold
    // is deliberately a question for the candidate, so nothing may answer it.
    expect(pickOptionIndex(["I have 6 or more years of experience"], ["Maybe"])).toBe(-1);
  });

  it("does not consent on the candidate's behalf when he declined", () => {
    expect(pickOptionIndex([VERCEL_ATTESTATION], ["No"])).toBe(-1);
  });

  it("does not treat a lone option with no consent verb as a formality", () => {
    expect(pickOptionIndex(["I am a US Person"], ["Maybe"])).toBe(-1);
  });
});
