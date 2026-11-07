import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Workspace } from "../src/config/load.js";
import { resolvePaths } from "../src/config/paths.js";
import { openDatabase } from "../src/db/database.js";
import { saveEvaluation, upsertJobs } from "../src/db/repositories/jobs.js";
import type { Evaluation, Job } from "../src/domain/job.js";
import { makeCampaign, makeProfile } from "./factories.js";

/** Workspaces for the hygiene and evaluation suites: real schema, in-memory database, a scratch home. */

export type TestWorkspace = Workspace & { cleanup: () => void };

export function makeWorkspace(
  options: { campaign?: Record<string, unknown>; profile?: Record<string, unknown>; writeConfig?: boolean } = {},
): TestWorkspace {
  const home = mkdtempSync(join(tmpdir(), "autoapply-hygiene-"));
  const previous = process.env.AUTOAPPLY_HOME;
  process.env.AUTOAPPLY_HOME = home;
  const paths = resolvePaths();
  if (previous === undefined) delete process.env.AUTOAPPLY_HOME;
  else process.env.AUTOAPPLY_HOME = previous;
  const profile = makeProfile(options.profile ?? {});
  const campaign = makeCampaign(options.campaign ?? {});
  if (options.writeConfig) {
    writeFileSync(paths.profile, JSON.stringify(profile));
    writeFileSync(paths.campaign, JSON.stringify(campaign));
    writeFileSync(paths.companies, JSON.stringify({ version: 1, companies: [] }));
  }
  const db = openDatabase(":memory:");
  return {
    paths,
    profile,
    campaign,
    companies: [],
    db,
    cleanup: () => {
      try {
        db.close();
      } catch {
        // already closed by a reload
      }
      rmSync(home, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
    },
  };
}

export function acceptedEvaluation(job: Job, overrides: Partial<Evaluation> = {}): Evaluation {
  return {
    jobId: job.id,
    decision: "accept",
    gate: { passed: true, rule: null, reason: "all gates passed", evidence: "" },
    trackId: "ai-security",
    score: 88,
    tier: "A",
    components: [],
    flags: [],
    evaluatedAt: new Date().toISOString(),
    ...overrides,
  };
}

/** Stores jobs with an accepted evaluation each. */
export function storeJobs(workspace: Workspace, jobs: readonly Job[]): void {
  upsertJobs(workspace.db, jobs);
  for (const job of jobs) saveEvaluation(workspace.db, acceptedEvaluation(job));
}

/** Sets a stored job's discovery timestamps, which upsertJobs always stamps with the current time. */
export function setSeen(workspace: Workspace, jobId: string, firstSeenAt: string, lastSeenAt = firstSeenAt): void {
  workspace.db.prepare("UPDATE jobs SET first_seen_at = ?, last_seen_at = ? WHERE id = ?").run(firstSeenAt, lastSeenAt, jobId);
}

/** A posting with every section the evaluation reads. */
export const SAMPLE_JD = [
  "About Acme",
  "Acme builds payment infrastructure for 2,000 businesses.",
  "",
  "What you'll do",
  "- Design and build distributed systems in Go and Python",
  "- Own threat modeling for new product features",
  "",
  "Requirements",
  "- 5+ years of software engineering experience",
  "- Strong experience with Python and Kubernetes",
  "- Experience with AWS or GCP",
  "- BS in Computer Science or equivalent experience",
  "- You must be authorized to work in the United States",
  "",
  "Nice to have",
  "- Experience with Terraform",
  "- Familiarity with Rust is a plus",
  "",
  "Benefits",
  "- 401(k) match and Kubernetes training budget",
].join("\n");
