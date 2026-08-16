import { describe, expect, it } from "vitest";
import { detectSubmissionConfirmation, detectSubmissionRejection } from "../src/submission/formFields.js";

const ASHBY_SPAM_BANNER =
  "We couldn't submit your application. Your application submission was flagged as possible spam. " +
  "If you believe this was a mistake, please submit your application again.";

describe("an employer that refuses the submission outright", () => {
  it("recognises the rejection Ashby shows a headless run", () => {
    expect(detectSubmissionRejection(ASHBY_SPAM_BANNER)).toBe(true);
  });

  it("is not confused by an ordinary job page", () => {
    expect(detectSubmissionRejection("Staff Engineer - Analytics. Apply for this job.")).toBe(false);
  });

  it("never reports a refused submission as confirmed", () => {
    expect(detectSubmissionConfirmation(ASHBY_SPAM_BANNER)).toBe(false);
  });

  it("keeps the refusal decisive even on a confirmation-looking url", () => {
    expect(detectSubmissionConfirmation(ASHBY_SPAM_BANNER, "https://jobs.ashbyhq.com/x/confirmation")).toBe(false);
  });

  it("still confirms a genuine success", () => {
    expect(detectSubmissionConfirmation("Thank you for applying to GitLab!")).toBe(true);
    expect(detectSubmissionRejection("Thank you for applying to GitLab!")).toBe(false);
  });

  it("does not fire on copy that merely discusses spam", () => {
    expect(detectSubmissionRejection("We filter spam from our careers inbox.")).toBe(false);
  });
});
