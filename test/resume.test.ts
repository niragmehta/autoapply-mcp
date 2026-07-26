import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validateResumeFile } from "../src/submission/resume.js";
import { checkSubmissionAllowed } from "../src/submission/guards.js";
import type { Application, DraftAnswer } from "../src/domain/job.js";
import { makeCampaign, makeJob } from "./factories.js";

let dir: string;
let validPdf: string;

const MINIMAL_PDF = Buffer.from(
  "%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n",
  "latin1",
);

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "autoapply-resume-"));
  validPdf = join(dir, "resume.pdf");
  writeFileSync(validPdf, MINIMAL_PDF);
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

describe("validateResumeFile", () => {
  it("accepts a real PDF", () => {
    const result = validateResumeFile(validPdf);
    expect(result.ok).toBe(true);
    expect(result.format).toBe("pdf");
    expect(result.exists).toBe(true);
    expect(result.sizeBytes).toBeGreaterThan(0);
    expect(result.warnings).toEqual([]);
  });

  it("rejects an unconfigured path", () => {
    expect(validateResumeFile("").ok).toBe(false);
    expect(validateResumeFile("").reason).toContain("no resume path configured");
  });

  it("rejects a missing file", () => {
    const result = validateResumeFile(join(dir, "nope.pdf"));
    expect(result.ok).toBe(false);
    expect(result.exists).toBe(false);
    expect(result.reason).toContain("not found");
  });

  it("rejects a directory", () => {
    const sub = join(dir, "subdir");
    mkdirSync(sub, { recursive: true });
    const result = validateResumeFile(sub);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("not a file");
  });

  it("rejects an empty file", () => {
    const empty = join(dir, "empty.pdf");
    writeFileSync(empty, "");
    const result = validateResumeFile(empty);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("empty");
  });

  it("rejects a file that claims to be a PDF but is not", () => {
    const fake = join(dir, "fake.pdf");
    writeFileSync(fake, "This is plain text, not a PDF at all.");
    const result = validateResumeFile(fake);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("%PDF-");
  });

  it("rejects a .docx that is not a zip container", () => {
    const fake = join(dir, "fake.docx");
    writeFileSync(fake, "not a zip");
    const result = validateResumeFile(fake);
    expect(result.ok).toBe(false);
    expect(result.reason).toContain("zip container");
  });

  it("accepts a valid docx container", () => {
    const docx = join(dir, "resume.docx");
    writeFileSync(docx, Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00]));
    expect(validateResumeFile(docx).ok).toBe(true);
  });

  it("warns about unrecognized formats without failing", () => {
    const odd = join(dir, "resume.pages");
    writeFileSync(odd, "content");
    const result = validateResumeFile(odd);
    expect(result.ok).toBe(true);
    expect(result.warnings.join(" ")).toContain("unrecognized resume format");
  });

  it("warns when a file is large enough for an ATS to reject it", () => {
    const big = join(dir, "big.pdf");
    writeFileSync(big, Buffer.concat([MINIMAL_PDF, Buffer.alloc(6 * 1024 * 1024)]));
    const result = validateResumeFile(big);
    expect(result.ok).toBe(true);
    expect(result.warnings.join(" ")).toContain("5 MB");
  });
});

describe("submission guard: resume", () => {
  const job = makeJob();

  function answer(): DraftAnswer {
    return {
      questionKey: "email",
      label: "Email",
      answer: "alex@example.com",
      source: "profile",
      citation: "identity.email",
      requiresHuman: false,
      category: "contact",
    };
  }

  function application(resumePath: string): Application {
    return {
      id: "app_1",
      jobId: job.id,
      status: "approved",
      resumeId: "ai-security",
      resumePath,
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

  function input(resumePath: string) {
    return {
      application: application(resumePath),
      job,
      campaign: makeCampaign(),
      approval,
      submittedToday: 0,
      lastSubmissionAt: null,
      requestedMode: "manual" as const,
    };
  }

  it("allows submission when the resume is valid", () => {
    expect(checkSubmissionAllowed(input(validPdf)).allowed).toBe(true);
  });

  it("refuses submission when the resume file is missing", () => {
    const result = checkSubmissionAllowed(input(join(dir, "gone.pdf")));
    expect(result.allowed).toBe(false);
    expect(result.code).toBe("resume_unusable");
  });

  it("refuses submission when no resume is configured", () => {
    expect(checkSubmissionAllowed(input("")).code).toBe("resume_unusable");
  });
});
