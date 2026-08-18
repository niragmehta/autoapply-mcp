import { describe, expect, it } from "vitest";

import { isDeadPostingText } from "../src/submission/workdayFlow.js";

describe("isDeadPostingText", () => {
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
