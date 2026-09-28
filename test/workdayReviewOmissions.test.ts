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

describe("reviewOmissions", () => {
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
});
