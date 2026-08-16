import { describe, expect, it } from "vitest";

import { pickOptionIndex } from "../src/submission/formFields.js";

/**
 * A required choice offering exactly one consent option carries no decision.
 * The rule tested the option against the base verb only, so Coinbase's sole
 * option "Confirmed" was not recognised and every Coinbase application blocked
 * on a field with nothing else to select.
 */
describe("a lone consent option written in an inflected form", () => {
  it("accepts a past-tense confirmation", () => {
    expect(pickOptionIndex(["Confirmed"], ["Yes"])).toBe(0);
  });

  it("accepts other inflections of the same formality", () => {
    expect(pickOptionIndex(["Acknowledged"], ["Yes"])).toBe(0);
    expect(pickOptionIndex(["Agreed"], ["Yes"])).toBe(0);
    expect(pickOptionIndex(["I certified"], ["Yes"])).toBe(0);
  });

  it("still blocks a lone option that states a fact rather than a formality", () => {
    // No consent verb: agreeing here would claim something about the candidate.
    expect(pickOptionIndex(["I have 6 or more years of experience"], ["Yes"])).toBe(-1);
  });

  it("does not convert a stored decline into consent", () => {
    expect(pickOptionIndex(["Confirmed"], ["Decline to self-identify"])).toBe(-1);
  });

  it("does not fire when the question offers a real choice", () => {
    // Two options is a decision, so the sole-consent rule stays out of it and
    // an answer that matches neither is handed back rather than guessed.
    expect(pickOptionIndex(["Confirmed", "Not confirmed"], ["Yes"])).toBe(-1);
  });
});
