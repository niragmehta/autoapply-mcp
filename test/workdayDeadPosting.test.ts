import { describe, expect, it } from "vitest";

import { isDeadPostingText, isSignInStepLabel } from "../src/submission/workdayFlow.js";

describe("isDeadPostingText", () => {
  it("does not mistake the account gate for the application form", () => {
    // Observed live on Workday's own tenant: step 1 of 8 is "Create Account/Sign
    // In", and it renders both the progress bar and formField- divs for email
    // and password - every signal the form check relied on.
    expect(isSignInStepLabel("current step 1 of 8Create Account/Sign In")).toBe(true);
    expect(isSignInStepLabel("current step 2 of 8My Information")).toBe(false);
    expect(isSignInStepLabel("current step 8 of 8Review")).toBe(false);
  });

  it("recognises Workday's not-found page", () => {
    expect(
      isDeadPostingText(
        "Skip to main content Careers English Sign In Search for Jobs The page you are looking for doesn't exist. Search for Jobs Follow Us",
      ),
    ).toBe(true);
  });

  it("recognises a withdrawn posting", () => {
    expect(isDeadPostingText("This job is no longer available.")).toBe(true);
  });

  it("does not fire on a live advert", () => {
    expect(
      isDeadPostingText(
        "Senior Software Engineer - Application Reliability. San Jose, California. Apply. Cisco is looking for engineers who exist to make networks reliable.",
      ),
    ).toBe(false);
  });

  it("does not fire on an ordinary validation error", () => {
    expect(isDeadPostingText("Error: Password does not meet the requirements.")).toBe(false);
  });
});
