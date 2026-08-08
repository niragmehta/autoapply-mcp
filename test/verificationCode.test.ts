import { describe, expect, it } from "vitest";

import { detectVerificationCodeGate } from "../src/submission/browser.js";

/** Verbatim from Stripe's Greenhouse form on 2026-08-08. */
const STRIPE = `A verification code was sent to candidate@example.com. To submit your
application, enter the 8-character code to confirm you're a human. Security code`;

describe("emailed verification code detection", () => {
  it("names the gate instead of reporting an unexplained failure", () => {
    expect(detectVerificationCodeGate(STRIPE)).toBe(
      "A verification code was sent to candidate@example.com.",
    );
  });

  it("recognises the code prompt on its own", () => {
    expect(
      detectVerificationCodeGate("Please enter the 6-character code to confirm you're a human."),
    ).toContain("6-character code");
  });

  it("recognises other one-time code phrasings", () => {
    expect(detectVerificationCodeGate("We sent a one-time code to n@example.com.")).toBeDefined();
    expect(detectVerificationCodeGate("Check your email for a verification code")).toBeDefined();
  });

  it("does not fire on an ordinary confirmation page", () => {
    expect(
      detectVerificationCodeGate("Thank you for applying. Your application has been received."),
    ).toBeUndefined();
  });

  it("does not fire on a validation error", () => {
    expect(detectVerificationCodeGate("This field is required.")).toBeUndefined();
  });
});
