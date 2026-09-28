import { describe, expect, it } from "vitest";
import { recordStepFailures, stepFailureList, wizardStepKey } from "../src/submission/wizardFailures.js";

describe("wizard step failures", () => {
  it("replaces a step's failures when the step is filled again after refusing to advance", () => {
    // Salesforce: "How Did You Hear About Us?" failed on the first pass over My
    // Information, took on the second, and the wizard reached Review complete.
    // The first pass's failure alone aborted the application.
    const step = wizardStepKey("current step 1 of 5\nMy Information", 0);
    const firstPass = recordStepFailures(new Map(), step, ["How Did You Hear About Us?*"]);
    const secondPass = recordStepFailures(firstPass, step, []);

    expect(stepFailureList(secondPass)).toEqual([]);
  });

  it("still reports a failure the second pass over the same step repeats", () => {
    const step = wizardStepKey("current step 4 of 6\nVoluntary Disclosures", 3);
    const firstPass = recordStepFailures(new Map(), step, ["Please select your gender."]);
    const secondPass = recordStepFailures(firstPass, step, ["Please select your gender."]);

    expect(stepFailureList(secondPass)).toEqual(["Please select your gender."]);
  });

  it("keeps failures from every distinct step", () => {
    const first = wizardStepKey("current step 1 of 5\nMy Information", 0);
    const third = wizardStepKey("current step 3 of 5\nApplication Questions", 2);
    const failures = recordStepFailures(
      recordStepFailures(new Map(), first, ["Phone Number*"]),
      third,
      ["Are you legally authorized to work in the US?*"],
    );

    expect(stepFailureList(failures)).toEqual(["Phone Number*", "Are you legally authorized to work in the US?*"]);
  });

  it("never lets unnamed steps overwrite each other", () => {
    const failures = recordStepFailures(
      recordStepFailures(new Map(), wizardStepKey("", 0), ["First Name*"]),
      wizardStepKey("  ", 1),
      [],
    );

    expect(stepFailureList(failures)).toEqual(["First Name*"]);
  });

  it("reports each failure once, in the order the steps were first seen", () => {
    const first = wizardStepKey("current step 1 of 3\nMy Information", 0);
    const second = wizardStepKey("current step 2 of 3\nApplication Questions", 1);
    let failures = recordStepFailures(new Map(), first, ["Country*"]);
    failures = recordStepFailures(failures, second, ["Country*", "Degree*"]);
    failures = recordStepFailures(failures, first, ["Country*"]);

    expect(stepFailureList(failures)).toEqual(["Country*", "Degree*"]);
  });

  it("leaves the record it was given unchanged", () => {
    const step = wizardStepKey("current step 1 of 5\nMy Information", 0);
    const before = recordStepFailures(new Map(), step, ["Postal Code*"]);
    recordStepFailures(before, step, []);

    expect(stepFailureList(before)).toEqual(["Postal Code*"]);
  });
});
