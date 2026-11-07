import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Workspace } from "../src/config/load.js";
import type { WorkspacePaths } from "../src/config/paths.js";
import { openDatabase } from "../src/db/database.js";
import { saveApplication } from "../src/db/repositories/applications.js";
import { saveEvaluation, upsertJobs } from "../src/db/repositories/jobs.js";
import type { Campaign } from "../src/domain/campaign.js";
import type { Application, Evaluation, Job } from "../src/domain/job.js";
import { ProfileSchema, type Profile } from "../src/domain/profile.js";
import { parseResumeSource, type ResumeSource } from "../src/documents/resumeSource.js";
import { buildPacket } from "../src/services/applications.js";
import { computePacketHash } from "../src/submission/packet.js";
import { makeCampaign } from "./factories.js";

/** Fictional fixtures for the documents tests. Nothing here describes a real person. */

const here = dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = join(here, "..");
// Scratch files stay inside the project, under a git-ignored cache folder.
const SCRATCH_ROOT = join(REPO_ROOT, "node_modules", ".cache", "autoapply-documents-tests");
// Each test file has its own copy of this module, so this lists only its own folders.
const created: string[] = [];

export function scratchDir(name: string): string {
  const dir = join(SCRATCH_ROOT, `${name}-${randomUUID().slice(0, 8)}`);
  mkdirSync(dir, { recursive: true });
  created.push(dir);
  return dir;
}

export function removeScratch(dir: string): void {
  rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
}

/** Removes every scratch folder this test file created. */
export function removeAllScratch(): void {
  for (const dir of created.splice(0)) removeScratch(dir);
}

export function exampleResumeJson(): unknown {
  return JSON.parse(readFileSync(join(REPO_ROOT, "examples", "resume.example.json"), "utf8"));
}

export function exampleResume(): ResumeSource {
  return parseResumeSource(exampleResumeJson());
}

export function docProfile(overrides: Record<string, unknown> = {}): Profile {
  return ProfileSchema.parse({
    version: 1,
    identity: {
      fullName: "Alex Candidate",
      headline: "Software Engineer",
      email: "alex@example.com",
      phone: "555-0100",
      location: { city: "Toronto", region: "ON", country: "Canada" },
      links: { website: "https://www.example.com" },
    },
    workAuthorization: {
      citizenships: ["Canada"],
      authorizedIn: ["CA"],
      requiresSponsorshipIn: ["US"],
      statement: "Canadian citizen; US roles require employer support for work authorization.",
    },
    compensation: { currency: "USD", targetTotal: 250000, minimumTotal: 180000 },
    resumes: [
      { id: "backend", label: "Backend", path: "variants/backend.pdf", tracks: ["backend"], isDefault: true },
      { id: "platform", label: "Platform", path: "variants/platform.pdf", tracks: ["platform"] },
    ],
    skills: [
      { name: "Kubernetes", aliases: ["k8s"], level: "strong" },
      { name: "PostgreSQL", aliases: ["Postgres"], level: "strong" },
      { name: "Python", level: "expert" },
      { name: "Go", aliases: ["golang"], level: "strong" },
    ],
    facts: [
      {
        id: "scaling",
        statement: "Scaled a payments API from 2k to 40k requests per second by redesigning its caching layer.",
        metrics: ["40k rps", "60% latency reduction"],
        tags: ["distributed systems", "performance", "caching"],
      },
      {
        id: "mentoring",
        statement: "Mentored 4 engineers through their first on-call rotations.",
        tags: ["mentoring", "on-call"],
      },
    ],
    experience: [
      { company: "Northwind Logistics", title: "Senior Software Engineer", location: "Toronto, Canada", start: "2021-03", end: "present" },
    ],
    education: [{ institution: "University of Example", credential: "BASc", field: "Software Engineering", start: "2015-09", end: "2020-04" }],
    ...overrides,
  });
}

export const PLATFORM_POSTING = [
  "Acme Freight is hiring a Senior Platform Engineer to own our Kubernetes platform.",
  "",
  "What you'll do",
  "- Run and scale our Kubernetes clusters and the CI/CD pipeline every team ships through",
  "- Improve build times and developer experience on GitHub Actions",
  "- Partner with service owners on observability and incident response",
  "",
  "Requirements",
  "- 5+ years building distributed systems in Go or Python",
  "- Deep experience with Kubernetes, Terraform and AWS",
  "- Experience operating Kafka or another event streaming system",
  "",
  "Nice to have",
  "- Rust or Elixir",
  "",
  "Benefits",
  "- Kubernetes-themed swag, generous parental leave and a learning budget",
].join("\n");

export function docJob(overrides: Partial<Job> = {}): Job {
  return {
    id: "job_doc1",
    fingerprint: "fp_doc1",
    ats: "external",
    companyName: "Acme Freight",
    companyTier: "A",
    board: "acmefreight",
    externalId: "42",
    title: "Senior Platform Engineer",
    locationsRaw: ["Toronto, ON"],
    locationClass: "canada",
    country: "CA",
    workplaceType: "hybrid",
    employmentType: "fulltime",
    url: "https://jobs.example.com/acme/42",
    applyUrl: "https://jobs.example.com/acme/42/apply",
    descriptionText: PLATFORM_POSTING,
    descriptionHash: "hash",
    compensation: null,
    postedAt: new Date().toISOString(),
    capturedAt: new Date().toISOString(),
    ...overrides,
  };
}

export function docCampaign(documents: Record<string, unknown> = {}): Campaign {
  return makeCampaign({
    tracks: [
      {
        id: "platform",
        label: "Platform",
        allocation: 1,
        titleIncludes: ["platform engineer"],
        keywords: [{ term: "kubernetes", weight: 3 }],
        resumeId: "platform",
      },
    ],
    locations: { allow: ["canada", "remote-canada"], workplaceTypes: ["onsite", "hybrid", "remote", "unknown"] },
    compensation: { currency: "USD", floors: { CA: 100000 }, fx: { USD: 1, CAD: 0.73 }, allowUnknown: true, rejectBelowFloor: true },
    documents,
    hygiene: { liveness: { beforePrepare: false } },
  });
}

export type DocWorkspace = Workspace & { home: string };

/**
 * A workspace on an in-memory database with its files in a scratch folder.
 * `source` is written as resume.json when given; fonts are absent unless a
 * test supplies a fonts folder.
 */
export function docWorkspace(options: { source?: unknown; campaign?: Campaign; profile?: Profile; fonts?: string } = {}): DocWorkspace {
  const home = scratchDir("workspace");
  const paths: WorkspacePaths = {
    home,
    profile: join(home, "profile.json"),
    campaign: join(home, "campaign.json"),
    companies: join(home, "companies.json"),
    database: ":memory:",
    artifacts: join(home, "artifacts"),
    resumeSource: join(home, "resume.json"),
    fonts: options.fonts ?? join(home, "fonts"),
    documents: join(home, "documents"),
    reports: join(home, "reports"),
    exports: join(home, "exports"),
    secrets: join(home, ".env"),
  };
  if (options.source !== undefined) writeFileSync(paths.resumeSource, JSON.stringify(options.source));
  return {
    home,
    paths,
    profile: options.profile ?? docProfile(),
    campaign: options.campaign ?? docCampaign(),
    companies: [],
    db: openDatabase(":memory:"),
  };
}

export function seedApplication(workspace: Workspace, job: Job = docJob(), overrides: Partial<Application> = {}): Application {
  upsertJobs(workspace.db, [job]);
  const base: Application = {
    id: `app_${job.id}`,
    jobId: job.id,
    status: "awaiting_approval",
    resumeId: "platform",
    resumePath: join(workspace.paths.home, "variants", "platform.pdf"),
    packetHash: "",
    coverLetter: "",
    answers: [],
    blockedQuestions: [],
    createdAt: new Date().toISOString(),
    approvedAt: null,
    submittedAt: null,
    submissionMode: null,
    confirmationRef: null,
    artifactPath: null,
    notes: "",
    ...overrides,
  };
  const application = { ...base, packetHash: computePacketHash(buildPacket(base, job)) };
  saveApplication(workspace.db, application);
  return application;
}

export function acceptEvaluation(workspace: Workspace, job: Job, trackId = "platform"): Evaluation {
  const evaluation: Evaluation = {
    jobId: job.id,
    decision: "accept",
    gate: { passed: true, rule: null, reason: "passed", evidence: "" },
    trackId,
    score: 90,
    tier: "A",
    components: [],
    flags: [],
    evaluatedAt: new Date().toISOString(),
  };
  saveEvaluation(workspace.db, evaluation);
  return evaluation;
}

let chromium: Promise<boolean> | null = null;

/** Whether Playwright's Chromium can launch here; rendering tests skip when it cannot. */
export function chromiumAvailable(): Promise<boolean> {
  chromium ??= (async () => {
    try {
      const specifier = "playwright";
      const playwright = (await import(specifier)) as { chromium: { launch: () => Promise<{ close: () => Promise<void> }> } };
      const browser = await playwright.chromium.launch();
      await browser.close();
      return true;
    } catch {
      return false;
    }
  })();
  return chromium;
}
