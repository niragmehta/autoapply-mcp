import { describe, expect, it } from "vitest";

import { pickOptionIndex } from "../src/submission/formFields.js";

/**
 * Faire asks for a state of residence and offers "Not in the US" for everyone
 * else. The stored province is "British Columbia" - a true answer to the
 * question asked, but not one of the options - so the fill stage refused a
 * complete Senior Staff ML Platform Engineer application over a field whose
 * answer was already known.
 */
const FAIRE_OPTIONS = [
  "Alabama", "Alaska", "Arizona", "Arkansas", "California", "Colorado", "Connecticut",
  "Delaware", "Florida", "Georgia", "Hawaii", "Idaho", "Illinois", "Indiana", "Iowa",
  "Kansas", "Kentucky", "Louisiana", "Maine", "Maryland", "Massachusetts", "Michigan",
  "Minnesota", "Mississippi", "Missouri", "Montana", "Nebraska", "Nevada",
  "New Hampshire", "New Jersey", "New Mexico", "New York", "North Carolina",
  "North Dakota", "Ohio", "Oklahoma", "Oregon", "Pennsylvania", "Rhode Island",
  "South Carolina", "South Dakota", "Tennessee", "Texas", "Utah", "Vermont",
  "Virginia", "Washington", "West Virginia", "Wisconsin", "Wyoming", "Not in the US",
];

describe("a state-of-residence list that offers an outside-the-US option", () => {
  it("takes the escape option for a Canadian province", () => {
    const index = pickOptionIndex(FAIRE_OPTIONS, ["British Columbia"]);
    expect(FAIRE_OPTIONS[index]).toBe("Not in the US");
  });

  it("still picks the real state when he lives in one", () => {
    const index = pickOptionIndex(FAIRE_OPTIONS, ["Washington"]);
    expect(FAIRE_OPTIONS[index]).toBe("Washington");
  });

  it("leaves a list that is not US states alone", () => {
    // Without the quorum check any unmatched answer would be swept into an
    // option that merely reads like an escape.
    const options = ["Engineering", "Design", "Sales", "Not in the US"];
    expect(pickOptionIndex(options, ["British Columbia"])).toBe(-1);
  });

  it("does not take the escape for a yes/no answer", () => {
    expect(pickOptionIndex(FAIRE_OPTIONS, ["Yes"])).toBe(-1);
  });

  it("does not convert a decline into a claim about where he lives", () => {
    expect(pickOptionIndex(FAIRE_OPTIONS, ["Decline to self-identify"])).toBe(-1);
  });

  it("does not take the escape when the list has no escape option", () => {
    const noEscape = FAIRE_OPTIONS.filter((option) => option !== "Not in the US");
    expect(pickOptionIndex(noEscape, ["British Columbia"])).toBe(-1);
  });
});
