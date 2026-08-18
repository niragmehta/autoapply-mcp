import { describe, expect, it } from "vitest";
import { consentsToDocument } from "../src/drafting/documentConsent.js";

describe("consentsToDocument", () => {
  it("accepts consent to a named document or process", () => {
    // IonQ's Greenhouse form: the sole option on "Background Check Disclosure
    // & Consent", which classifies as criminal-history and blocked the whole
    // application even though it discloses nothing about the candidate.
    for (const option of [
      "I agree and acknowledge to the IonQ Background Check Disclosure and Consent.",
      "I acknowledge and agree to the IonQ Applicant Privacy Notice",
      "I have read and accept the terms of this agreement",
      "I consent to a background check being conducted",
      "I confirm I have reviewed the code of conduct",
      // Block's Greenhouse form states its interview expectations - AI use,
      // recording, video, confidentiality - and offers this single option. It
      // classifies as "disability" because of the accommodation wording, and
      // so blocked every Block application.
      "I agree to these expectations",
    ]) {
      expect(consentsToDocument(option), option).toBe(true);
    }
  });

  it("refuses a lone option that states a fact about the candidate", () => {
    // These read as formalities and carry a consent verb, so the looser rule
    // would take them. Each is a claim the server has no standing to make.
    for (const option of [
      "I certify that I have never been convicted of a felony",
      "I certify that I have not been convicted of a crime",
      "I confirm I have no criminal record",
      "I certify that I am not a convicted felon",
    ]) {
      expect(consentsToDocument(option), option).toBe(false);
    }
  });

  it("refuses a consent verb with no document to consent to", () => {
    expect(consentsToDocument("I agree")).toBe(false);
    expect(consentsToDocument("I acknowledge")).toBe(false);
    expect(consentsToDocument("")).toBe(false);
  });
});
