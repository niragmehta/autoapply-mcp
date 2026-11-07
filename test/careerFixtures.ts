import { openDatabase, type Db } from "../src/db/database.js";
import { saveApplication } from "../src/db/repositories/applications.js";
import { upsertJobs } from "../src/db/repositories/jobs.js";
import type { CareerWorkspace } from "../src/career/context.js";
import type { Application, Job } from "../src/domain/job.js";
import { ProfileSchema, type Profile } from "../src/domain/profile.js";
import { AppError } from "../src/util/errors.js";
import { makeCampaign, makeJob } from "./factories.js";

/**
 * Fictional fixtures for the career features. Everything is in memory: no
 * file is written and nothing points at a real person or account.
 */

export const CAREER_JD = [
  "About the role",
  "Acme Robotics is hiring a Senior Security Engineer to protect our AI platform.",
  "What you'll do",
  "- Design and build guardrails that enforce policy for AI agents",
  "- Lead incident response for production security events",
  "- Automate compliance reviews across hundreds of repositories",
  "- Mentor engineers and raise the security bar across teams",
  "What we're looking for",
  "- 5+ years of experience in security engineering",
  "- Hands-on experience with Rust and Haskell compilers",
  "Benefits",
  "- Comprehensive health insurance and 401(k) matching",
  "We are an equal opportunity employer and welcome applicants from all backgrounds.",
].join("\n");

export function careerProfile(overrides: Record<string, unknown> = {}): Profile {
  return ProfileSchema.parse({
    version: 1,
    identity: {
      fullName: "Alex Candidate",
      headline: "Senior Security Engineer",
      email: "alex@example.com",
      phone: "555-0100",
      location: { city: "Vancouver", region: "BC", country: "Canada" },
      links: { linkedin: "https://www.linkedin.com/in/alex-candidate-123" },
    },
    workAuthorization: {
      citizenships: ["Canada"],
      authorizedIn: ["CA"],
      noSponsorshipRequiredIn: ["US"],
      statement: "Canadian citizen; eligible for TN status in the US.",
      alwaysReviewManually: true,
    },
    compensation: { currency: "USD", targetTotal: 300000, minimumTotal: 220000, disclosurePolicy: "decline" },
    resumes: [{ id: "general", label: "General", path: "fixtures/alex-resume.pdf", isDefault: true }],
    skills: [
      { name: "Python", level: "strong" },
      { name: "Open Policy Agent", aliases: ["OPA"], level: "expert" },
      { name: "Kubernetes", aliases: ["K8s"] },
      { name: "threat modeling" },
    ],
    facts: [
      {
        id: "guardrails",
        statement: "Built an AI guardrail framework enforcing policy with Open Policy Agent, adopted by 12 product teams.",
        metrics: ["12 product teams"],
        tags: ["ai security", "guardrails", "policy"],
      },
      {
        id: "compliance",
        statement: "Automated security compliance review across 300+ repositories, cutting review time by 40%.",
        metrics: ["300+ repositories", "40% faster reviews"],
        tags: ["automation", "compliance", "policy"],
      },
      {
        id: "incident",
        statement: "Led the response to a production credential leak and cut time to remediate from 6 hours to 45 minutes.",
        metrics: ["6 hours to 45 minutes"],
        tags: ["incident response", "leadership"],
      },
      {
        id: "mentoring",
        statement: "Mentored 4 engineers through promotion to senior.",
        category: "leadership",
        tags: ["leadership", "mentoring"],
      },
      {
        id: "cost",
        statement: "Saved $1.2M a year in cloud spend by consolidating Kubernetes clusters.",
        metrics: ["$1.2M annual savings"],
        tags: ["cost"],
      },
    ],
    experience: [
      { company: "Acme Cloud", title: "Senior Security Engineer", start: "2021-02", end: "present", highlights: ["Owned the guardrail platform"] },
      { company: "Globex", title: "Software Engineer", start: "2017-06", end: "2021-01", highlights: ["Built CI pipelines for 50 services"] },
    ],
    ...overrides,
  });
}

export type TestWorkspace = CareerWorkspace & { db: Db };

export function careerWorkspace(profile: Profile = careerProfile()): TestWorkspace {
  return { db: openDatabase(":memory:"), profile, campaign: makeCampaign() };
}

export function seedApplication(
  db: Db,
  options: { id?: string; job?: Partial<Job>; application?: Partial<Application> } = {},
): { job: Job; application: Application } {
  const suffix = options.id ?? "1";
  const job = makeJob({
    id: `job_career${suffix}`,
    fingerprint: `fp_career${suffix}`,
    externalId: `ext${suffix}`,
    companyName: "Acme Robotics",
    title: "Senior Security Engineer",
    descriptionText: CAREER_JD,
    ...options.job,
  });
  upsertJobs(db, [job]);
  const now = new Date().toISOString();
  const application: Application = {
    id: `app_career${suffix}`,
    jobId: job.id,
    status: "submitted",
    resumeId: "general",
    resumePath: "fixtures/alex-resume.pdf",
    packetHash: "",
    coverLetter: "",
    answers: [],
    blockedQuestions: [],
    createdAt: now,
    approvedAt: now,
    submittedAt: now,
    submissionMode: "manual",
    confirmationRef: null,
    artifactPath: null,
    notes: "",
    ...options.application,
  };
  saveApplication(db, application);
  return { job, application };
}

/** Days from now as an ISO instant. */
export function inDays(days: number): string {
  return new Date(Date.now() + days * 86_400_000).toISOString();
}

/** The AppError code `fn` throws, or null when it does not throw. */
export function errorCode(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (error) {
    return error instanceof AppError ? error.code : `not an AppError: ${String(error)}`;
  }
}

/** The message of the error `fn` throws. */
export function errorMessage(fn: () => unknown): string {
  try {
    fn();
    return "";
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}
