import { describe, expect, it } from "vitest";
import { decodeEntitiesOnce, htmlToText, normalizeWhitespace } from "../src/text/html.js";
import {
  aboutRelocation,
  acceptsRelocationInstead,
  askedSentences,
  decidesRelocation,
  relocationAssistanceMismatch,
  relocationOption,
  residenceOnlyInCondition,
  writtenForChoiceList,
} from "../src/text/questionIntent.js";
import { asksAbilityToMeetRequirement } from "../src/text/requirementQuestion.js";
import {
  asksWhetherSponsorshipRequired,
  canonicalizeWorkPermission,
  definesSponsorshipWithTn,
  excludesTnFromSponsorship,
  namesTnRoute,
  sponsorshipIntentMismatch,
  tnSponsorshipMismatch,
  workPermissionScopeMismatch,
} from "../src/text/workPermission.js";

describe("html entities and whitespace", () => {
  it("decodes decimal, hex and named entities and drops impossible code points", () => {
    expect(decodeEntitiesOnce("&#65;&#x42;&amp;&nbsp;&bogus;&#x110000;&#99999999999;")).toBe("AB& &bogus;");
    expect(htmlToText("<p>R&amp;D&rsquo;s &ldquo;team&rdquo;</p><br/>Next")).toBe("R&D's \"team\"\n\nNext");
  });

  it("collapses spaces and blank lines", () => {
    expect(normalizeWhitespace(" a \t b\r\n\n\n\nc ")).toBe("a b\n\nc");
  });
});

describe("questionIntent", () => {
  it("reads only the sentences that ask", () => {
    expect(askedSentences("This role is based in San Francisco. Are you open to relocating? We offer support.")).toEqual([
      "Are you open to relocating?",
    ]);
    expect(askedSentences("Relocation assistance required")).toEqual(["Relocation assistance required"]);
    expect(askedSentences("Do you live near the U.S. office?")).toEqual(["Do you live near the U.S. office?"]);
  });

  it("keeps a relocation-assistance answer to questions about assistance", () => {
    const question = "Are you open to working in-office 5x per week in the San Francisco area? Retell AI offers relocation assistance";
    expect(relocationAssistanceMismatch(question, ["Do you need relocation assistance?"])).toBe(true);
    expect(relocationAssistanceMismatch("Will you need relocation assistance?", ["relocation assistance"])).toBe(false);
    expect(relocationAssistanceMismatch(question, ["Are you willing to relocate?"])).toBe(false);
  });

  it("recognises residence questions that accept relocation instead, or only as a condition", () => {
    expect(acceptsRelocationInstead("Are you located in, or willing to relocate to the SF area?")).toBe(true);
    expect(acceptsRelocationInstead("Are you located in the SF area?")).toBe(false);
    expect(residenceOnlyInCondition("If you are not currently located in the San Francisco Bay Area, would you be willing to relocate?")).toBe(true);
    expect(residenceOnlyInCondition("Are you located there? If not, would you be willing to relocate?")).toBe(false);
  });

  it("tells relocation decisions from relocation support", () => {
    expect(aboutRelocation({ key: "relocate", label: "Willing to relocate?" })).toBe(true);
    expect(aboutRelocation({ key: "relocation", label: "Relocation assistance needed?" })).toBe(false);
    expect(decidesRelocation({ key: "relocate", label: "Willing to relocate?", answer: "Yes, anywhere in the US" })).toBe(true);
    expect(decidesRelocation({ key: "relocate", label: "Willing to relocate?", answer: "No" })).toBe(false);
  });

  it("picks the one option that commits to relocating without claiming residence", () => {
    expect(relocationOption(["Yes, I live here", "Yes, I plan to relocate", "No"])).toBe("Yes, I plan to relocate");
    expect(
      relocationOption([
        "Yes, I am located in/near the Reno, NV area.",
        "I am open to relocation.",
        "I am not open to relocation.",
      ]),
    ).toBe("I am open to relocation.");
    expect(relocationOption(["No, I'm not based in this location but willing to relocate", "Yes, relocate with a package"])).toBe(
      "No, I'm not based in this location but willing to relocate",
    );
    expect(relocationOption(["Open to relocating", "Happy to move"])).toBeUndefined();
  });

  it("keeps a choice-list answer to choice lists", () => {
    expect(writtenForChoiceList({ label: "Why are you interested in working here? (select all that apply)" })).toBe(true);
    expect(writtenForChoiceList({ label: "Why are you interested in working at Abby Care?" })).toBe(false);
  });
});

describe("requirementQuestion", () => {
  it("recognises questions about meeting a condition of the job", () => {
    expect(asksAbilityToMeetRequirement("Can you provide tuberculosis screening unless you have a disability / medical reason?")).toBe(true);
    expect(asksAbilityToMeetRequirement("Do you have a disability?")).toBe(false);
  });
});

describe("workPermission", () => {
  it("folds every wording of legal permission to work onto one", () => {
    expect(canonicalizeWorkPermission("are you eligible to work or entitled to work here")).toBe(
      "are you authorized to work or authorized to work here",
    );
  });

  it("does not let a general permission answer a narrower scope", () => {
    const question = "Are you authorized to work for any employer in the U.S. without restriction?";
    expect(workPermissionScopeMismatch(question, ["currently authorized to work in the U.S."])).toBe(true);
    expect(workPermissionScopeMismatch(question, ["authorized to work for any employer without restriction"])).toBe(false);
    expect(workPermissionScopeMismatch("What is your favourite colour?", [])).toBe(false);
  });

  it("answers sponsorship questions only with sponsorship answers", () => {
    const zip = "Will you now or in the future require sponsorship to work in the country where this role is located?";
    expect(asksWhetherSponsorshipRequired(zip)).toBe(true);
    expect(asksWhetherSponsorshipRequired("Are you authorized to work without requiring sponsorship?")).toBe(false);
    expect(sponsorshipIntentMismatch(zip, ["currently authorized to work in the U.S."])).toBe(true);
    expect(sponsorshipIntentMismatch(zip, ["require visa sponsorship"])).toBe(false);
    expect(sponsorshipIntentMismatch("Are you over 18?", [])).toBe(false);
  });

  it("owes a TN-defined sponsorship question the answer written for that definition", () => {
    const hinge = "Will you require sponsorship (H-1B, H-1B1, E-3, O-1, or TN) now or in the future?";
    expect(definesSponsorshipWithTn(hinge)).toBe(true);
    expect(namesTnRoute(["sponsorship including TN status"])).toBe(true);
    expect(tnSponsorshipMismatch(hinge, ["require sponsorship"])).toBe(true);
    expect(tnSponsorshipMismatch(hinge, ["sponsorship including TN status"])).toBe(false);
    expect(excludesTnFromSponsorship("Do you require sponsorship? TN status is not considered sponsorship.")).toBe(true);
    expect(excludesTnFromSponsorship(hinge)).toBe(false);
  });
});
