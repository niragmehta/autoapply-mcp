import { describe, expect, it } from "vitest";
import { reviewOmissions } from "../src/submission/workdayFlow.js";

function reviewPage(body: string): Parameters<typeof reviewOmissions>[0] {
  const present = { count: async () => 1 };
  return {
    locator: () => ({ first: () => present }),
    evaluate: async () => body,
  } as unknown as Parameters<typeof reviewOmissions>[0];
}

const SOURCE = "How Did You Hear About Us?";
const RACE = "Please indicate your race / ethnic group (choose all that apply).";

describe("reviewOmissions", () => {
  it("accepts a pay band on the page that holds the stated figure", async () => {
    // CVS Health's Review prints the selected band "$220,000 - $240,000" for an
    // answer of "Around USD 222,480 base ...", so the figure itself never
    // appears and a correct application was stopped before submitting.
    const label = "What is your base pay expectation for this position?";
    const value = "Around USD 222,480 base (the top of the posted range), flexible depending on level and total compensation.";
    const page = reviewPage(`Application Questions ${label} $220,000 - $240,000 Do you currently work at CVS Health? No`);

    expect(await reviewOmissions(page, [{ label, value }], "CVS Health")).toEqual([]);
  });

  it("still stops on a band that does not hold the stated figure", async () => {
    const label = "What is your base pay expectation for this position?";
    const value = "Around USD 222,480 base";
    const page = reviewPage(`Application Questions ${label} $80,000 - $100,000 Do you currently work at CVS Health? No`);

    expect(await reviewOmissions(page, [{ label, value }], "CVS Health")).toEqual([{ label, value }]);
  });

  it("accepts a decline the tenant prints in its own words after the question", async () => {
    const page = reviewPage(
      `Voluntary Disclosures Please indicate your gender. Wish Not To Answer ${RACE} Wish Not To Answer (United States of America) Are you hispanic or Latino descent? No`,
    );

    expect(await reviewOmissions(page, [{ label: RACE, value: "Decline to self-identify" }], "Palo Alto Networks")).toEqual([]);
  });

  it("accepts a decline printed without the 'to' of wishing", async () => {
    // Global Payments (TSYS) prints its veteran decline as "I do not wish self-identify".
    const label = "Please select your status.";
    const page = reviewPage(`Voluntary Disclosures ${label} I do not wish self-identify Self Identify Name`);

    expect(await reviewOmissions(page, [{ label, value: "Decline to self-identify" }], "Global Payments")).toEqual([]);
  });

  it("does not take an unanswered question for a decline", async () => {
    const page = reviewPage(`Voluntary Disclosures ${RACE} No Response Please indicate your gender. Wish Not To Answer`);

    expect(await reviewOmissions(page, [{ label: RACE, value: "Decline to self-identify" }], "Palo Alto Networks")).toEqual([
      { label: RACE, value: "Decline to self-identify" },
    ]);
  });

  it("does not let another question's refusal vouch for this one", async () => {
    const page = reviewPage(
      `Voluntary Disclosures ${RACE} Asian (United States of America) Please indicate your gender. Wish Not To Answer`,
    );

    expect(await reviewOmissions(page, [{ label: RACE, value: "Decline to self-identify" }], "Palo Alto Networks")).toEqual([
      { label: RACE, value: "Decline to self-identify" },
    ]);
  });

  it("accepts the tenant's synonym for an answer", async () => {
    // NVIDIA's phone types are "Home" and "Home Cellular"; "Mobile" selected the latter.
    const page = reviewPage("My Information Phone Device Type Home Cellular Country Phone Code Canada (+1)");

    expect(await reviewOmissions(page, [{ label: "Phone Device Type", value: "Mobile" }], "NVIDIA")).toEqual([]);
  });
  it("flags an answer naming the employer when the page only names the employer", async () => {
    // Every Review page says "Adobe", so finding the word proves nothing about
    // whether the source prompt says "Adobe.com" or the vendor a draft kept.
    const page = reviewPage(`Adobe Careers Review ${SOURCE} Findem Senior Software Engineer at Adobe`);

    const missing = await reviewOmissions(page, [{ label: SOURCE, value: "Adobe.com" }], "Adobe");

    expect(missing).toEqual([{ label: SOURCE, value: "Adobe.com" }]);
  });

  it("accepts an answer naming the employer when the page states it", async () => {
    const page = reviewPage(`Adobe Careers Review ${SOURCE} Adobe.com Senior Software Engineer at Adobe`);

    expect(await reviewOmissions(page, [{ label: SOURCE, value: "Adobe.com" }], "Adobe")).toEqual([]);
  });

  it("still accepts a tenant's own wording of an answer", async () => {
    const page = reviewPage("Adobe Careers Review Field of Study Science, Computer");

    expect(await reviewOmissions(page, [{ label: "Field of Study", value: "Computer Science" }], "Adobe")).toEqual([]);
  });

  it("checks the words beside the employer's name", async () => {
    const page = reviewPage(`Adobe Careers Review ${SOURCE} Adobe Careers Website`);

    expect(await reviewOmissions(page, [{ label: SOURCE, value: "Adobe Employee Referral" }], "Adobe")).toEqual([
      { label: SOURCE, value: "Adobe Employee Referral" },
    ]);
  });

  it("accepts a sentence answer whose figure a number field kept", async () => {
    // Cboe's Salary Expectations is a number field: the sentence went in as
    // 192500, and that is what its Review page says back.
    const page = reviewPage("Cboe Review Application Questions Salary Expectations* 192500 Are you 18 years of age or older? Yes");
    const answer = "Around USD 192,500 base (the top of the posted range), flexible depending on level and total compensation.";

    expect(await reviewOmissions(page, [{ label: "Salary Expectations", value: answer }], "Cboe")).toEqual([]);
  });

  it("accepts the figure with digit grouping", async () => {
    const page = reviewPage("Review Salary Expectations 192,500");

    expect(await reviewOmissions(page, [{ label: "Salary Expectations", value: "Around USD 192,500 base" }], "Cboe")).toEqual([]);
  });

  it("flags a figure the page states differently", async () => {
    const page = reviewPage("Review Salary Expectations 1925000");

    expect(await reviewOmissions(page, [{ label: "Salary Expectations", value: "Around USD 192,500 base" }], "Cboe")).toEqual([
      { label: "Salary Expectations", value: "Around USD 192,500 base" },
    ]);
  });

  describe("wordings the fill was approved to choose", () => {
    // Sony's at-will notice was answered "I acknowledge"; the option the fill
    // chose, and the Review page prints, is "Yes, I understand".
    const AT_WILL =
      "NO EMPLOYMENT RELATIONSHIP I recognize that this employment application is not an offer of employment and the employment relationship is at-will.";
    const value = "I acknowledge";
    const alternatives = ["I acknowledge", "Acknowledged", "I Acknowledge", "Acknowledge", "I understand", "Understood"];

    it("accepts an approved wording stated right after the question", async () => {
      const page = reviewPage(`Application Questions ${AT_WILL} Yes, I understand Are you a resident of Maryland? No`);

      expect(await reviewOmissions(page, [{ label: AT_WILL, value, alternatives }], "Sony")).toEqual([]);
    });

    it("does not let another question's answer vouch for this one", async () => {
      const page = reviewPage(`Application Questions ${AT_WILL} No Do you understand the travel policy? Yes, I understand`);

      expect(await reviewOmissions(page, [{ label: AT_WILL, value, alternatives }], "Sony")).toEqual([{ label: AT_WILL, value }]);
    });

    it("does not take a refusal for an approved wording", async () => {
      const page = reviewPage(`Application Questions ${AT_WILL} Not understood Are you a resident of Maryland? No`);

      expect(await reviewOmissions(page, [{ label: AT_WILL, value, alternatives }], "Sony")).toEqual([{ label: AT_WILL, value }]);
    });
  });
});
