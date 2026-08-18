import { describe, expect, it } from "vitest";
import {
  detectAlreadyApplied,
  detectSubmissionConfirmation,
  detectSubmissionRejection,
} from "../src/submission/formFields.js";

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

/**
 * Cisco's Workday tenant answers a re-entry with a page carrying no form at
 * all: "Principal Tetragon Software Engineer. You've already applied for this
 * job. View My Applications". The dead-posting check read that as the posting
 * having been removed - the most damaging possible reading, because it says a
 * live application does not exist.
 */
const CISCO_ALREADY_APPLIED =
  "Principal Tetragon Software Engineer\nYou've already applied for this job.\nView My Applications";

describe("a board that says the application is already on file", () => {
  it("recognises the phrasing whichever way the board writes it", () => {
    expect(detectAlreadyApplied(CISCO_ALREADY_APPLIED)).toBe(true);
    expect(detectAlreadyApplied("You have already applied to this position.")).toBe(true);
    expect(detectAlreadyApplied("An application already exists for this requisition.")).toBe(true);
  });

  it("treats it as confirmation, because the application demonstrably exists", () => {
    expect(detectSubmissionConfirmation(CISCO_ALREADY_APPLIED)).toBe(true);
  });

  it("does not fire on an ordinary posting inviting an application", () => {
    expect(detectAlreadyApplied("Apply for this job. Already have an account? Sign in.")).toBe(false);
    expect(detectAlreadyApplied("Staff Engineer - Analytics. Apply for this job.")).toBe(false);
  });

  it("still lets an explicit refusal win", () => {
    // Both statements cannot be true; the refusal is the specific claim about
    // this attempt, so it decides.
    expect(detectSubmissionConfirmation(`${ASHBY_SPAM_BANNER} You've already applied.`)).toBe(false);
  });
});
