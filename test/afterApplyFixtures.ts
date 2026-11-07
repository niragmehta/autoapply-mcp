import { mkdirSync, rmdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import type { Workspace } from "../src/config/load.js";
import type { WorkspacePaths } from "../src/config/paths.js";
import { openDatabase, type Db } from "../src/db/database.js";
import { saveApplication } from "../src/db/repositories/applications.js";
import { saveEvaluation, upsertJobs } from "../src/db/repositories/jobs.js";
import type { Application, Evaluation, Job } from "../src/domain/job.js";
import { makeCampaign, makeJob, makeProfile } from "./factories.js";

/** Seeded databases and workspaces for the after-apply tests. Nothing here touches a real mailbox or home folder. */

const SCRATCH_ROOT = fileURLToPath(new URL("../artifacts/test-scratch/", import.meta.url));

/** A throwaway folder inside the repository's ignored artifacts directory. */
export function scratchDir(name: string): { path: string; cleanup: () => void } {
  const path = join(SCRATCH_ROOT, `${name}-${randomUUID().slice(0, 8)}`);
  mkdirSync(path, { recursive: true });
  return {
    path,
    cleanup: () => {
      rmSync(path, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
      // Remove the shared parents once the last test file is done with them.
      for (const parent of [SCRATCH_ROOT, dirname(SCRATCH_ROOT)]) {
        try {
          rmdirSync(parent);
        } catch {
          break;
        }
      }
    },
  };
}

export function testPaths(home: string): WorkspacePaths {
  return {
    home,
    profile: join(home, "profile.json"),
    campaign: join(home, "campaign.json"),
    companies: join(home, "companies.json"),
    database: ":memory:",
    artifacts: join(home, "artifacts"),
    resumeSource: join(home, "resume.json"),
    fonts: join(home, "fonts"),
    documents: join(home, "documents"),
    reports: join(home, "reports"),
    exports: join(home, "exports"),
    secrets: join(home, ".env"),
  };
}

export function makeWorkspace(options: { home?: string; campaign?: Record<string, unknown>; db?: Db } = {}): Workspace {
  return {
    paths: testPaths(options.home ?? join(SCRATCH_ROOT, "unused")),
    profile: makeProfile(),
    campaign: makeCampaign(options.campaign ?? {}),
    companies: [],
    db: options.db ?? openDatabase(":memory:"),
  };
}

export type SeedInput = {
  id: string;
  company: string;
  title: string;
  ats?: Job["ats"];
  board?: string;
  url?: string;
  externalId?: string;
  status?: Application["status"];
  submittedAt?: string | null;
  createdAt?: string;
  approvedAt?: string | null;
  submissionMode?: string | null;
  score?: number;
  tier?: Evaluation["tier"];
  trackId?: string | null;
  decision?: Evaluation["decision"];
  locationClass?: Job["locationClass"];
  companyTier?: Job["companyTier"];
  description?: string;
  firstSeenAt?: string;
};

/** Stores a job, its evaluation and an application for it. */
export function seedApplication(db: Db, input: SeedInput): void {
  const jobId = `job_${input.id}`;
  const submittedAt = input.submittedAt === undefined ? "2026-09-01T12:00:00.000Z" : input.submittedAt;
  const job = makeJob({
    id: jobId,
    fingerprint: `fp_${input.id}`,
    ats: input.ats ?? "greenhouse",
    companyName: input.company,
    companyTier: input.companyTier ?? "B",
    board: input.board ?? input.company.toLowerCase().replace(/[^a-z0-9]/g, ""),
    externalId: input.externalId ?? input.id,
    title: input.title,
    url: input.url ?? `https://job-boards.greenhouse.io/${input.company.toLowerCase().replace(/[^a-z0-9]/g, "")}/jobs/${input.id}`,
    applyUrl: input.url ?? `https://job-boards.greenhouse.io/${input.company.toLowerCase().replace(/[^a-z0-9]/g, "")}/jobs/${input.id}`,
    locationClass: input.locationClass ?? "bay-area",
    descriptionText: input.description ?? "Build reliable systems.",
  });
  upsertJobs(db, [job]);
  if (input.firstSeenAt) db.prepare("UPDATE jobs SET first_seen_at = ? WHERE id = ?").run(input.firstSeenAt, jobId);
  saveEvaluation(db, {
    jobId,
    decision: input.decision ?? "accept",
    gate: { passed: true, rule: null, reason: "ok", evidence: "" },
    trackId: input.trackId === undefined ? "ai-security" : input.trackId,
    score: input.score ?? 85,
    tier: input.tier ?? "A",
    components: [],
    flags: [],
    evaluatedAt: input.createdAt ?? "2026-08-30T12:00:00.000Z",
  });
  saveApplication(db, {
    id: input.id,
    jobId,
    status: input.status ?? "submitted",
    resumeId: "general",
    resumePath: "resume.pdf",
    packetHash: `hash_${input.id}`,
    coverLetter: "",
    answers: [],
    blockedQuestions: [],
    createdAt: input.createdAt ?? "2026-08-31T12:00:00.000Z",
    approvedAt: input.approvedAt === undefined ? (submittedAt ? "2026-08-31T13:00:00.000Z" : null) : input.approvedAt,
    submittedAt,
    submissionMode: input.submissionMode === undefined ? (submittedAt ? "auto" : null) : input.submissionMode,
    confirmationRef: null,
    artifactPath: null,
    notes: "",
  });
}

/** Writes an outcome with an explicit timestamp, as if recorded then. */
export function seedOutcome(db: Db, applicationId: string, status: string, notedAt: string, detail = ""): void {
  db.prepare("INSERT INTO outcomes (application_id, status, noted_at, detail) VALUES (?,?,?,?)").run(applicationId, status, notedAt, detail);
}

/** A gate-rejected posting, for discard analytics. */
export function seedRejectedPosting(db: Db, id: string, rule: string, reason: string, ats: Job["ats"] = "greenhouse", evaluatedAt = "2026-09-02T10:00:00.000Z"): void {
  const jobId = `job_${id}`;
  upsertJobs(db, [makeJob({ id: jobId, fingerprint: `fp_${id}`, ats, title: `Posting ${id}`, companyName: `Company ${id}` })]);
  saveEvaluation(db, {
    jobId,
    decision: "reject",
    gate: { passed: false, rule, reason, evidence: "" },
    trackId: null,
    score: 0,
    tier: "none",
    components: [],
    flags: [],
    evaluatedAt,
  });
}
