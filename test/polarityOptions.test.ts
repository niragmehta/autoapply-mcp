import { describe, expect, it } from "vitest";

import { selectBestOption } from "../src/drafting/options.js";

/**
 * Employers spell yes and no out as sentences. A stored answer of "No" is not a
 * substring of "No, I am not a current or former Government Official" and is
 * too short to match as one safely, so a question already decided on file was
 * blocked on every board that writes its options this way.
 */
describe("a bare yes or no against sentence-form options", () => {
  const governmentOfficial = [
    "No, I am not a current or former Government Official",
    "Yes, I am a current Government Official",
    "Yes, I am a former Government Official",
  ];

  it("takes the single option opening with the answer's polarity", () => {
    const match = selectBestOption(["No"], governmentOfficial);
    expect(match.matchedOption).toBe(true);
    expect(match.value).toBe("No, I am not a current or former Government Official");
  });

  it("falls back to the older rules when two options share the answer's polarity", () => {
    // "Yes, I am a current" and "Yes, I am a former" are different claims, so
    // the polarity rule declines to choose and containment decides as before.
    const match = selectBestOption(["Yes"], governmentOfficial);
    expect(match.matchedOption).toBe(true);
    expect(match.value).toBe("Yes, I am a current Government Official");
  });

  it("matches a no against a reversed option order", () => {
    const match = selectBestOption(
      ["No"],
      ["Yes, I am a relative of a government official.", "No, I am not a relative of a government official."],
    );
    expect(match.value).toBe("No, I am not a relative of a government official.");
  });

  it("does not read 'Not applicable' or 'None of the above' as a no", () => {
    expect(selectBestOption(["No"], ["Not applicable", "None of the above"]).matchedOption).toBe(false);
  });

  it("only applies to an answer that says nothing beyond its polarity", () => {
    // A qualified answer carries content that must be matched on its merits.
    expect(
      selectBestOption(["No - based in Vancouver"], ["No, I am not a current or former Government Official"])
        .matchedOption,
    ).toBe(false);
  });

  it("still prefers an exact option over a polarity fallback", () => {
    const match = selectBestOption(["No"], ["No", "No, with conditions"]);
    expect(match.value).toBe("No");
  });

  it("leaves preference order intact", () => {
    // "Careers page" is offered, so the polarity rule is never reached.
    const match = selectBestOption(["Careers page", "No"], ["Careers page", "No, I heard elsewhere"]);
    expect(match.value).toBe("Careers page");
  });
});
