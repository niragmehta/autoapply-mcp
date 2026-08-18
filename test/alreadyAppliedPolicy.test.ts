import { describe, expect, it } from "vitest";

import {
  detectAlreadyApplied,
  detectSubmissionConfirmation,
} from "../src/submission/formFields.js";

const PLAID_BANNER =
  "This job has application limits. We're excited that you're interested in opportunities with us! " +
  "Candidates may submit up to three applications within a 60-day period. " +
  "If you've already applied and been considered for a specific role, you'll need to wait 12 months " +
  "before reapplying for that same position. You're still welcome to apply for other roles.";

describe("detectAlreadyApplied", () => {
  it("ignores a policy notice about hypothetical prior applications", () => {
    // Observed live on Plaid's Ashby posting, printed above an empty form.
    expect(detectAlreadyApplied(PLAID_BANNER)).toBe(false);
  });

  it("still recognises a board stating an application is on file", () => {
    expect(detectAlreadyApplied("You have already applied to this job.")).toBe(true);
    expect(detectAlreadyApplied("An application already exists for this posting.")).toBe(true);
  });

  it("recognises the statement even when a conditional appears elsewhere", () => {
    expect(
      detectAlreadyApplied("If you need help, contact us. You have already applied for this job."),
    ).toBe(true);
  });
});

describe("detectSubmissionConfirmation", () => {
  it("does not confirm a submission from an application-limits notice", () => {
    // The whole point of the guard: this text sat on an unsubmitted form and
    // caused the run to report "submitted".
    expect(detectSubmissionConfirmation(PLAID_BANNER, "https://jobs.ashbyhq.com/plaid/x/application")).toBe(
      false,
    );
  });
});
