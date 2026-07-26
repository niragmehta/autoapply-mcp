import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CampaignSchema, type Campaign } from "../src/domain/campaign.js";
import { ProfileSchema, type Profile } from "../src/domain/profile.js";
import type { Job } from "../src/domain/job.js";

/** Test fixtures shared across the suite. */

const MINIMAL_PDF = Buffer.from(
  "%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n",
  "latin1",
);

let cachedResumePath: string | null = null;

/**
 * A real, structurally valid PDF on disk. Submission guards reject unusable
 * resume files, so fixtures need an actual file rather than a placeholder path.
 */
export function fixtureResumePath(): string {
  if (cachedResumePath) return cachedResumePath;
  const dir = mkdtempSync(join(tmpdir(), "autoapply-fixture-"));
  const path = join(dir, "resume.pdf");
  writeFileSync(path, MINIMAL_PDF);
  cachedResumePath = path;
  return path;
}

export function makeProfile(overrides: Record<string, unknown> = {}): Profile {
  return ProfileSchema.parse({
    version: 1,
    identity: {
      fullName: "Alex Candidate",
      headline: "Security Software Engineer",
      email: "alex@example.com",
      phone: "555-0100",
      location: { city: "Vancouver", region: "BC", country: "Canada" },
      links: { linkedin: "https://linkedin.com/in/alex", github: "https://github.com/alex" },
    },
    workAuthorization: {
      citizenships: ["Canada"],
      authorizedIn: ["CA"],
      requiresSponsorshipIn: ["US"],
      statement: "Canadian citizen; US roles require employer support for work authorization.",
      alwaysReviewManually: true,
    },
    compensation: { currency: "USD", targetTotal: 300000, minimumTotal: 200000, disclosurePolicy: "decline" },
    resumes: [
      { id: "ai-security", label: "AI Security", path: fixtureResumePath(), tracks: ["ai-security"] },
      { id: "general", label: "General", path: fixtureResumePath(), tracks: [], isDefault: true },
    ],
    skills: [
      { name: "Python", level: "strong", tags: ["language"] },
      { name: "Open Policy Agent", aliases: ["OPA"], level: "expert", tags: ["policy"] },
      { name: "Azure", level: "expert", tags: ["cloud"] },
      { name: "threat modeling", level: "strong", tags: ["security"] },
    ],
    facts: [
      {
        id: "guardrails",
        statement: "Built an AI guardrail framework enforcing information flow control policies using Open Policy Agent.",
        tags: ["ai security", "guardrails", "opa", "policy"],
      },
      {
        id: "compliance",
        statement: "Automated security compliance review across 300+ repositories with agentic AI.",
        tags: ["compliance", "automation"],
      },
    ],
    experience: [
      { company: "Acme", title: "Software Engineer II - Security", start: "2021-02", highlights: ["Built guardrails"] },
    ],
    answers: [
      {
        key: "source",
        label: "How did you hear about us?",
        patterns: ["how did you hear"],
        answer: "Company careers page",
        allowAutoFill: true,
      },
    ],
    ...overrides,
  });
}

export function makeCampaign(overrides: Record<string, unknown> = {}): Campaign {
  return CampaignSchema.parse({
    version: 1,
    name: "test-campaign",
    targetApplications: 100,
    tracks: [
      {
        id: "ai-security",
        label: "AI Security",
        allocation: 0.5,
        titleIncludes: ["security engineer", "ai security"],
        titleExcludes: ["sales"],
        keywords: [
          { term: "ai security", weight: 3 },
          { term: "guardrail", weight: 2 },
          { term: "threat modeling", weight: 2 },
          { term: "policy", weight: 1 },
        ],
        resumeId: "ai-security",
      },
      {
        id: "software",
        label: "Software",
        allocation: 0.5,
        titleIncludes: ["software engineer"],
        keywords: [
          { term: "distributed systems", weight: 2 },
          { term: "python", weight: 1 },
        ],
        resumeId: "general",
      },
    ],
    locations: { allow: ["bay-area", "canada", "remote-canada"], workplaceTypes: ["onsite", "hybrid", "remote", "unknown"] },
    compensation: {
      currency: "USD",
      floors: { US: 200000, CA: 180000 },
      fx: { USD: 1, CAD: 0.73 },
      allowUnknown: true,
      rejectBelowFloor: true,
    },
    freshnessDays: 45,
    ...overrides,
  });
}

export function makeJob(overrides: Partial<Job> = {}): Job {
  return {
    id: "job_test1",
    fingerprint: "fp_test1",
    ats: "greenhouse",
    companyName: "Test Corp",
    companyTier: "B",
    board: "testcorp",
    externalId: "123",
    title: "Senior Security Engineer",
    locationsRaw: ["San Francisco, CA"],
    locationClass: "bay-area",
    country: "US",
    workplaceType: "hybrid",
    employmentType: "fulltime",
    url: "https://job-boards.greenhouse.io/testcorp/jobs/123",
    applyUrl: "https://job-boards.greenhouse.io/testcorp/jobs/123",
    descriptionText: "We are hiring a senior security engineer to work on ai security guardrails and threat modeling with policy enforcement in Python.",
    descriptionHash: "hash",
    compensation: { min: 220000, max: 280000, currency: "USD", period: "year", source: "ats-structured", raw: "$220k-$280k" },
    postedAt: new Date().toISOString(),
    capturedAt: new Date().toISOString(),
    ...overrides,
  };
}
