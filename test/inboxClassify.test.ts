import { describe, expect, it } from "vitest";
import { classifyReply, normalizeReplyText } from "../src/inbox/classify.js";

/**
 * The classifier decides what may be recorded without a person, so the
 * phrases that matter are pinned here, along with the wording that looks
 * like one kind and is another.
 */

const AUTO = 0.85;

describe("classifying employer replies", () => {
  it("reads a typical ATS rejection as a confident rejection", () => {
    const result = classifyReply({
      subject: "Acme | Update on Your Application",
      body: [
        "Hi Alex,",
        "Thank you for your interest in Acme and for taking the time to apply for the Senior Software Engineer role.",
        "Unfortunately, we have decided to move forward with other candidates whose experience more closely aligns with the needs of the team.",
        "We encourage you to join our talent community and wish you the best in your search.",
      ].join("\n"),
    });
    expect(result.kind).toBe("rejected");
    expect(result.confidence).toBeGreaterThanOrEqual(AUTO);
    expect(result.evidence).toContain("move forward with other candidates");
  });

  it.each([
    "We are not able to move forward with your application at this time.",
    "We won't be moving forward with your candidacy.",
    "After careful review, we have decided not to proceed with your application.",
    "The position has been filled.",
    "You have not been selected for this role.",
    "We regret to inform you that we have decided to pursue other candidates.",
    "We are unable to offer you the position.",
    "Unfortunately the role you applied for has been closed.",
    "You are no longer under consideration for this position.",
    "We've decided to go in a different direction.",
  ])("treats %j as a rejection", (body) => {
    const result = classifyReply({ body });
    expect(result.kind).toBe("rejected");
  });

  it("tells 'not able to move forward' from 'would like to move forward'", () => {
    const declined = classifyReply({ body: "We are not able to move forward with your application." });
    const advancing = classifyReply({
      body: "We'd like to move forward with your application and schedule a phone screen with our recruiter.",
    });
    expect(declined.kind).toBe("rejected");
    expect(declined.confidence).toBeGreaterThanOrEqual(AUTO);
    expect(advancing.kind).toBe("recruiter_screen");
    expect(advancing.scores.rejected ?? 0).toBe(0);
  });

  it("does not read 'moving forward with other candidates' as progress", () => {
    const result = classifyReply({ body: "We have decided to move forward with other applicants for this role." });
    expect(result.kind).toBe("rejected");
    expect(result.scores.recruiter_screen ?? 0).toBe(0);
  });

  it("keeps a rejection that mentions the interview stage a rejection", () => {
    const result = classifyReply({ body: "We will not be moving forward to the interview stage." });
    expect(result.kind).toBe("rejected");
    expect(result.scores.interview ?? 0).toBe(0);
  });

  it("ignores interview wording that is negated in its own clause", () => {
    const result = classifyReply({ body: "We are not looking to schedule an interview at this time." });
    expect(result.kind).not.toBe("interview");
  });

  it("reads an application confirmation as an acknowledgement", () => {
    const result = classifyReply({
      subject: "Thank you for applying to Acme",
      body: "We have received your application for Senior Software Engineer. Our team will review your application and if your experience matches what we are looking for, we'll be in touch.",
    });
    expect(result.kind).toBe("acknowledged");
    expect(result.confidence).toBeGreaterThanOrEqual(AUTO);
  });

  it("does not take a high-volume disclaimer for a rejection", () => {
    const result = classifyReply({
      body: "Thanks for applying! We've received your application. Unfortunately we can't respond to every applicant individually, but we will review your application carefully.",
    });
    expect(result.kind).toBe("acknowledged");
  });

  it.each([
    ["You have been invited to take a HackerRank test for Acme.", "hackerrank"],
    ["Please complete the online assessment within 7 days.", "online assessment"],
    ["The next step is a take-home exercise.", "take-home"],
    ["Here is your CodeSignal coding challenge link.", "coding challenge"],
  ])("reads %j as an assessment", (body, phrase) => {
    const result = classifyReply({ body });
    expect(result.kind).toBe("assessment");
    expect(result.evidence.join(" ")).toContain(phrase);
  });

  it("reads a scheduling request as a recruiter screen", () => {
    const result = classifyReply({
      body: "I'd love to set up a quick 30-minute call to learn more about your background. Please pick a time that works: calendly.com/recruiter",
    });
    expect(result.kind).toBe("recruiter_screen");
    expect(result.confidence).toBeGreaterThanOrEqual(AUTO);
  });

  it.each([
    "We'd like to invite you to a virtual onsite with the team.",
    "Congratulations, you've advanced to the next round: a system design interview.",
    "Please share your availability so we can schedule your panel interview.",
    "Your final round interview is confirmed for Tuesday.",
  ])("reads %j as an interview", (body) => {
    expect(classifyReply({ body }).kind).toBe("interview");
  });

  it("keeps an interview reschedule an interview despite 'unfortunately'", () => {
    const result = classifyReply({ body: "Unfortunately our hiring manager is out, so we need to reschedule your interview." });
    expect(result.kind).toBe("interview");
  });

  it("reads an offer as an offer", () => {
    const result = classifyReply({
      subject: "Offer letter",
      body: "We are delighted to extend you an offer to join Acme. Your offer letter and compensation package are attached.",
    });
    expect(result.kind).toBe("offer");
    expect(result.confidence).toBeGreaterThanOrEqual(AUTO);
  });

  it("does not read 'not extending an offer' as an offer", () => {
    const result = classifyReply({ body: "We will not be extending an offer at this time." });
    expect(result.kind).toBe("rejected");
  });

  it("reads a withdrawal confirmation as withdrawn", () => {
    expect(classifyReply({ body: "You have successfully withdrawn your application for Senior Engineer." }).kind).toBe("withdrawn");
  });

  it.each([
    ["Job alert: 12 new jobs matching your search", "New roles you may be interested in at Acme. Unsubscribe."],
    ["Acme newsletter", "Our monthly newsletter: product news and a webinar invite."],
    ["Recommended jobs for you", "Jobs you might like based on your profile."],
  ])("sets aside %j as noise", (subject, body) => {
    expect(classifyReply({ subject, body }).kind).toBe("noise");
  });

  it("marks verification-code mail as noise whose text must not be kept", () => {
    const result = classifyReply({
      subject: "Security code for your application to Acme",
      body: "Copy and paste this code into the security code field on your application: pvlqH9IO",
    });
    expect(result.kind).toBe("noise");
    expect(result.sensitive).toBe(true);
  });

  it("returns unknown, with no confidence, for mail it cannot read", () => {
    const result = classifyReply({ subject: "Re: documents", body: "Here is the document you asked for." });
    expect(result).toMatchObject({ kind: "unknown", confidence: 0, evidence: [] });
  });

  it("lowers confidence when the message argues both ways", () => {
    const mixed = classifyReply({
      body: "We regret to inform you the position has been filled. We'd like to invite you to interview for another team.",
    });
    expect(mixed.kind).toBe("rejected");
    expect(mixed.confidence).toBeLessThan(AUTO);
  });

  it("normalises curly quotes and spacing before matching", () => {
    expect(normalizeReplyText("We\u2019re  NOT\u00a0able")).toBe("we're not able");
    expect(classifyReply({ body: "We\u2019re not able to move forward with your application." }).kind).toBe("rejected");
  });
});
