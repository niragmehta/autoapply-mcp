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

/**
 * The mirror of the case above, and a live failure: the stored residence answer
 * "No - based in Vancouver, Canada and willing to relocate." matched nothing at
 * all against a bare "Yes"/"No" pair, because the answer is not bare and "no"
 * is below the substring floor. Dialpad's "Are you currently based in Buenos
 * Aires, Argentina?" was therefore handed back to a person even though it was
 * answered on file, blocking the whole application.
 */
describe("a qualified yes or no against bare options", () => {
  const relocation = "No - based in Vancouver, Canada and willing to relocate.";

  it("takes the bare option matching the answer's leading polarity", () => {
    const match = selectBestOption([relocation], ["Yes", "No"]);
    expect(match.matchedOption).toBe(true);
    expect(match.value).toBe("No");
  });

  it("reads the polarity of a qualified yes", () => {
    expect(selectBestOption(["Yes, I have used it extensively"], ["Yes", "No"]).value).toBe("Yes");
  });

  it("refuses to adopt a claim the answer never made", () => {
    // The option is not bare, so taking it would assert something about
    // government office on the strength of an answer about where he lives.
    expect(
      selectBestOption([relocation], ["Yes, I am a Government Official", "No, I am not a Government Official"])
        .matchedOption,
    ).toBe(false);
  });

  it("declines when two options carry the answer's polarity", () => {
    expect(selectBestOption([relocation], ["Yes", "No", "No, with conditions"]).matchedOption).toBe(false);
  });

  it("does not read a leading word that merely starts with a polarity", () => {
    // "None of the above" and "Nothing" open with the letters of "no" but not
    // the word, so they state no polarity.
    expect(selectBestOption(["Nothing to declare"], ["Yes", "No"]).matchedOption).toBe(false);
  });

  it("still refuses an answer that states no polarity at all", () => {
    // The bug this guards: a location answer was winning a sponsorship
    // question and silently filling nothing useful.
    expect(selectBestOption(["Canada"], ["Yes", "No"]).matchedOption).toBe(false);
  });
});
