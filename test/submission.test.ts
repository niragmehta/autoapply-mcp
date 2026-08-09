import { describe, expect, it } from "vitest";
import { checkSubmissionAllowed } from "../src/submission/guards.js";
import { checkUrlAllowed } from "../src/submission/allowlist.js";
import { computePacketHash, renderPacketPreview } from "../src/submission/packet.js";
import type { Application, DraftAnswer } from "../src/domain/job.js";
import { makeCampaign, makeJob, fixtureResumePath } from "./factories.js";

const campaign = makeCampaign();
const job = makeJob();

function answer(overrides: Partial<DraftAnswer> = {}): DraftAnswer {
  return {
    questionKey: "email",
    label: "Email",
    answer: "alex@example.com",
    source: "profile",
    citation: "identity.email",
    requiresHuman: false,
    category: "contact",
    ...overrides,
  };
}

function application(overrides: Partial<Application> = {}): Application {
  return {
    id: "app_1",
    jobId: job.id,
    status: "approved",
    resumeId: "ai-security",
    resumePath: fixtureResumePath(),
    packetHash: "hash-1",
    coverLetter: "",
    answers: [answer()],
    blockedQuestions: [],
    createdAt: new Date().toISOString(),
    approvedAt: new Date().toISOString(),
    submittedAt: null,
    submissionMode: null,
    confirmationRef: null,
    artifactPath: null,
    notes: "",
    ...overrides,
  };
}

const approval = {
  id: "apr_1",
  applicationId: "app_1",
  packetHash: "hash-1",
  decision: "approved",
  decidedAt: new Date().toISOString(),
  note: "",
};

const baseInput = {
  application: application(),
  job,
  campaign,
  approval,
  submittedToday: 0,
  lastSubmissionAt: null,
  requestedMode: "manual" as const,
};

describe("checkUrlAllowed", () => {
  it("allows known ATS hosts", () => {
    expect(checkUrlAllowed("https://job-boards.greenhouse.io/acme/jobs/1", campaign.submission).allowed).toBe(true);
    expect(checkUrlAllowed("https://jobs.lever.co/acme/1", campaign.submission).allowed).toBe(true);
  });

  it("rejects unknown hosts, http and malformed urls", () => {
    expect(checkUrlAllowed("https://evil.example.com/apply", campaign.submission).allowed).toBe(false);
    expect(checkUrlAllowed("http://jobs.lever.co/acme/1", campaign.submission).allowed).toBe(false);
    expect(checkUrlAllowed("not-a-url", campaign.submission).allowed).toBe(false);
  });
});

describe("checkSubmissionAllowed", () => {
  it("allows a fully approved manual submission", () => {
    expect(checkSubmissionAllowed(baseInput).allowed).toBe(true);
  });

  it("refuses without an approval record", () => {
    const result = checkSubmissionAllowed({ ...baseInput, approval: null });
    expect(result.code).toBe("not_approved");
  });

  it("refuses when content changed after approval", () => {
    const result = checkSubmissionAllowed({
      ...baseInput,
      application: application({ packetHash: "hash-2" }),
    });
    expect(result.code).toBe("packet_changed");
  });

  it("refuses when a required human answer is still empty", () => {
    const result = checkSubmissionAllowed({
      ...baseInput,
      application: application({
        answers: [
          answer({ questionKey: "auth", label: "Work authorization", answer: "", requiresHuman: true, required: true }),
        ],
      }),
    });
    expect(result.code).toBe("unresolved_questions");
  });

  it("allows an empty optional question the candidate chose not to answer", () => {
    // Lyft's optional pronouns list offers no decline option, so the standing
    // "prefer not to say" has nowhere to go. A blank optional field asserts
    // nothing and cannot stop the form submitting, so it must not block.
    const result = checkSubmissionAllowed({
      ...baseInput,
      application: application({
        answers: [
          answer({ questionKey: "pronouns", label: "Pronouns", answer: "", requiresHuman: true, required: false }),
        ],
      }),
    });
    expect(result.code).toBe("ok");
  });

  it("refuses a mode stronger than the campaign allows", () => {
    const result = checkSubmissionAllowed({ ...baseInput, requestedMode: "auto" });
    expect(result.code).toBe("mode_not_permitted");
  });

  it("refuses destinations off the allowlist", () => {
    const result = checkSubmissionAllowed({
      ...baseInput,
      job: makeJob({ applyUrl: "https://careers.evil.example.com/apply" }),
    });
    expect(result.code).toBe("destination_not_allowed");
  });

  it("enforces the daily limit", () => {
    const result = checkSubmissionAllowed({ ...baseInput, submittedToday: campaign.submission.dailyLimit });
    expect(result.code).toBe("daily_limit_reached");
  });

  it("enforces the per-company ceiling", () => {
    // The count includes this approved application, so the ceiling is only
    // breached once another one sits beyond it.
    const result = checkSubmissionAllowed({
      ...baseInput,
      companyApplicationCount: campaign.submission.maxPerCompany + 1,
    });
    expect(result.code).toBe("company_cap_reached");
  });

  it("lets an approved application spend the slot it already holds", () => {
    const result = checkSubmissionAllowed({
      ...baseInput,
      companyApplicationCount: campaign.submission.maxPerCompany,
    });
    expect(result.allowed).toBe(true);
  });

  it("enforces pacing between submissions", () => {
    const result = checkSubmissionAllowed({ ...baseInput, lastSubmissionAt: new Date().toISOString() });
    expect(result.code).toBe("pacing");
    expect(result.waitSeconds).toBeGreaterThan(0);
  });

  it("refuses to submit twice", () => {
    const result = checkSubmissionAllowed({
      ...baseInput,
      application: application({ status: "submitted", submittedAt: new Date().toISOString() }),
    });
    expect(result.code).toBe("already_submitted");
  });

  it("restricts auto mode to allowlisted companies", () => {
    const autoCampaign = makeCampaign({
      submission: { mode: "auto", allowedCompanies: ["Other Corp"] },
    });
    const result = checkSubmissionAllowed({ ...baseInput, campaign: autoCampaign, requestedMode: "auto" });
    expect(result.code).toBe("company_not_allowlisted");
  });
});

describe("packet hashing", () => {
  it("is stable for identical content regardless of answer order", () => {
    const a = { ...application(), answers: [answer({ questionKey: "a" }), answer({ questionKey: "b" })] };
    const b = { ...application(), answers: [answer({ questionKey: "b" }), answer({ questionKey: "a" })] };
    const base = { jobId: job.id, company: "c", jobTitle: "t", applyUrl: job.applyUrl, resumeId: "r", resumePath: "p", coverLetter: "" };
    expect(computePacketHash({ ...base, answers: a.answers })).toBe(computePacketHash({ ...base, answers: b.answers }));
  });

  it("changes when any answer changes", () => {
    const base = { jobId: job.id, company: "c", jobTitle: "t", applyUrl: job.applyUrl, resumeId: "r", resumePath: "p", coverLetter: "" };
    const first = computePacketHash({ ...base, answers: [answer()] });
    const second = computePacketHash({ ...base, answers: [answer({ answer: "different@example.com" })] });
    expect(first).not.toBe(second);
  });

  it("renders a preview that marks unresolved questions", () => {
    const preview = renderPacketPreview({
      applicationId: "app_1",
      jobId: job.id,
      company: "Test Corp",
      jobTitle: "Senior Security Engineer",
      applyUrl: job.applyUrl,
      resumeId: "ai-security",
      resumePath: fixtureResumePath(),
      coverLetter: "",
      answers: [answer({ label: "Work authorization", answer: "", requiresHuman: true })],
    });
    expect(preview).toContain("[NEEDS HUMAN]");
    expect(preview).toContain("(empty)");
  });
});
