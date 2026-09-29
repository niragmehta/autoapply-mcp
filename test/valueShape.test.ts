import { describe, expect, it } from "vitest";
import { numberInputValue } from "../src/drafting/valueShape.js";

describe("numberInputValue", () => {
  it("takes the stated quantity from an answer written in words", () => {
    expect(numberInputValue("5+ years")).toBe("5");
    expect(numberInputValue("3+ days in office")).toBe("3");
    expect(numberInputValue("5000+")).toBe("5000");
  });

  it("keeps plain numbers and years as written", () => {
    expect(numberInputValue("250000")).toBe("250000");
    expect(numberInputValue("2019")).toBe("2019");
    expect(numberInputValue("-3")).toBe("-3");
    expect(numberInputValue("4.5")).toBe("4.5");
  });

  // "$250,000" typed as its first digit run would state a salary of 250.
  it("reads digit grouping as one number", () => {
    expect(numberInputValue("250,000")).toBe("250000");
    expect(numberInputValue("$1,250,000")).toBe("1250000");
    expect(numberInputValue("$250,000 - $300,000")).toBe("250000");
  });

  // A Canadian postal code reduced to its first digit sent a ZIP code of "5".
  it("refuses a code that mixes letters and digits", () => {
    expect(numberInputValue("V5K 0A1")).toBeNull();
    expect(numberInputValue("V5K0A1")).toBeNull();
    expect(numberInputValue("250k")).toBeNull();
  });

  it("refuses an answer with no number in it", () => {
    expect(numberInputValue("n/a")).toBeNull();
    expect(numberInputValue("No - I do not consent to receiving text messages")).toBeNull();
    expect(numberInputValue("")).toBeNull();
  });
});
