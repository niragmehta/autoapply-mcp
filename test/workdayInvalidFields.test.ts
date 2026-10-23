import { describe, expect, it } from "vitest";
import { clearInvalidOptionalFields, parseWorkdayInvalidFieldErrors } from "../src/submission/workdayFlow.js";

const KLA_BANNER =
  "My Experience * Indicates a required field Errors Found 1. Error - Please provide your Facebook profile: Invalid Facebook URL Work Experience";

describe("parseWorkdayInvalidFieldErrors", () => {
  it("names the field the banner rejects for its value", () => {
    // KLA's optional Facebook field held the LinkedIn URL and My Experience
    // would not advance on any attempt.
    expect(parseWorkdayInvalidFieldErrors(KLA_BANNER)).toEqual(["Please provide your Facebook profile"]);
  });

  it("leaves required-and-empty errors to the required-field reader", () => {
    const text = "Errors Found 1. Error - The field Country is required and must have a value";
    expect(parseWorkdayInvalidFieldErrors(text)).toEqual([]);
  });
});

describe("clearInvalidOptionalFields", () => {
  function fakePage(bodyText: string, markedLabels: string[]) {
    const filled: string[] = [];
    const marked = {
      count: async () => markedLabels.length,
      nth: (index: number) => ({ fill: async (value: string) => void filled.push(`${index}:${value}`) }),
    };
    const page = {
      locator: (selector: string) => (selector === "body" ? { first: () => ({ count: async () => 1 }) } : marked),
      // visibleText reads the body through a script that queries "body"; the
      // other script is the one that marks the rejected fields.
      evaluate: async (script: string) => (script.includes('querySelector("body")') ? bodyText : markedLabels),
    };
    return { page, filled };
  }

  it("empties an optional field the banner rejects", async () => {
    const { page, filled } = fakePage(KLA_BANNER, ["Please provide your Facebook profile:"]);
    expect(await clearInvalidOptionalFields(page as never)).toEqual(["Please provide your Facebook profile:"]);
    expect(filled).toEqual(["0:"]);
  });

  it("does nothing when the banner rejects no value", async () => {
    const { page, filled } = fakePage("My Experience * Indicates a required field", ["unused"]);
    expect(await clearInvalidOptionalFields(page as never)).toEqual([]);
    expect(filled).toEqual([]);
  });
});
