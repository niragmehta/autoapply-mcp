import { describe, expect, it } from "vitest";

import { pickNumericBandIndex } from "../src/drafting/numericBands.js";
import { selectBestOption } from "../src/drafting/options.js";
import { pickOptionIndex } from "../src/submission/formFields.js";

/** The real option set from Figma's "Software Engineer, Traffic" posting. */
const FIGMA_BANDS = ["0 - 2 years", "3 - 4 years", "5 - 10 years", "10+ years"];

describe("numeric band matching", () => {
  it("places a stated figure in the band that contains it", () => {
    expect(pickNumericBandIndex(FIGMA_BANDS, ["5+ years"])).toBe(2);
    expect(pickNumericBandIndex(FIGMA_BANDS, ["3 years"])).toBe(1);
    expect(pickNumericBandIndex(FIGMA_BANDS, ["1"])).toBe(0);
  });

  it("prefers the open-ended band at a shared boundary", () => {
    expect(pickNumericBandIndex(FIGMA_BANDS, ["10+ years"])).toBe(3);
  });

  it("never selects a band starting above the stated figure", () => {
    // Two years of experience must not reach "3 - 4" or anything higher.
    expect(pickNumericBandIndex(["3 - 4 years", "5 - 10 years"], ["2 years"])).toBe(-1);
  });

  it("handles less-than and more-than phrasings", () => {
    const options = ["Less than 1 year", "1 - 3 years", "More than 3 years"];
    expect(pickNumericBandIndex(options, ["5+ years"])).toBe(2);
    expect(pickNumericBandIndex(options, ["0 years"])).toBe(0);
  });

  it("ignores option sets that are not numeric bands", () => {
    expect(pickNumericBandIndex(["Yes", "No"], ["5+ years"])).toBe(-1);
    expect(pickNumericBandIndex(["5 - 10 years", "Prefer not to say"], ["5+ years"])).toBe(-1);
  });

  it("ignores answers that state no figure", () => {
    expect(pickNumericBandIndex(FIGMA_BANDS, ["Yes"])).toBe(-1);
  });

  it("reaches both the drafting and the form-fill matchers", () => {
    expect(selectBestOption(["5+ years"], FIGMA_BANDS)).toEqual({
      value: "5 - 10 years",
      matchedOption: true,
    });
    expect(pickOptionIndex(FIGMA_BANDS, ["5+ years"])).toBe(2);
  });

  it("still prefers an exact textual match over a band", () => {
    expect(selectBestOption(["10+ years"], FIGMA_BANDS).value).toBe("10+ years");
  });
});
