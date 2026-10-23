import { describe, expect, it } from "vitest";
import { retriesEmptyWorkdayStep } from "../src/submission/workdayFlow.js";

describe("retriesEmptyWorkdayStep", () => {
  it("reloads a form step that came back empty", () => {
    expect(retriesEmptyWorkdayStep("current step 3 of 5\nApplication Questions", 0, 0, 3)).toBe(true);
  });

  it("stops reloading once the retries are spent", () => {
    expect(retriesEmptyWorkdayStep("current step 3 of 5\nApplication Questions", 0, 3, 3)).toBe(false);
  });

  it("leaves a step that collected fields alone", () => {
    expect(retriesEmptyWorkdayStep("current step 2 of 5\nMy Experience", 4, 0, 3)).toBe(false);
  });

  it("never reloads a Review page that simply has no inputs", () => {
    // Tempus's Review collects nothing; three reloads ran the stall guard out.
    expect(retriesEmptyWorkdayStep("current step 5 of 5\nReview", 0, 0, 3)).toBe(false);
  });
});
