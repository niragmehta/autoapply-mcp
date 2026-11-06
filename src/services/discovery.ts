import type { Workspace } from "../config/load.js";
import { appendEvent } from "../db/repositories/events.js";
import { countJobs, upsertJobs } from "../db/repositories/jobs.js";
import type { Company } from "../domain/campaign.js";
import type { Job } from "../domain/job.js";
import { evaluateAndStore, mergeSummaries, type PipelineSummary } from "../pipeline.js";
import { discoverJobs } from "../sources/registry.js";
import type { DiscoveryIssue } from "../sources/types.js";
import { AppError } from "../util/errors.js";

/**
 * Discovery as a service: fetch boards, store and evaluate each one as soon as
 * it arrives. Shared by the discover_jobs tool and the run queue, which reports
 * per-board progress while a long refresh runs.
 */

export type DiscoveryInput = {
  /** Company names to refresh; every active board when absent or empty. */
  companies?: readonly string[];
  /** Called after each board is stored, with that board's postings. */
  onBoard?: (company: Company, jobs: readonly Job[], index: number, total: number) => void;
};

export type DiscoveryOutcome = {
  boardsQueried: number;
  postingsFetched: number;
  newPostings: number;
  refreshedPostings: number;
  evaluation: PipelineSummary;
  totalStoredJobs: number;
  boardIssues: DiscoveryIssue[];
};

/** Resolves company names to configured boards, case-insensitively. */
export function selectCompanies(workspace: Workspace, names?: readonly string[]): Company[] {
  if (!names || names.length === 0) return workspace.companies;
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  return workspace.companies.filter((company) => wanted.has(company.name.toLowerCase()));
}

export async function runDiscovery(workspace: Workspace, input: DiscoveryInput = {}): Promise<DiscoveryOutcome> {
  const selected = selectCompanies(workspace, input.companies);
  if (selected.length === 0) {
    throw new AppError("no_companies", "no matching companies configured; check companies.json");
  }

  // Each board is stored and evaluated as soon as it is fetched, so a run that
  // outlives its client still keeps every board it reached.
  let inserted = 0;
  let updated = 0;
  let index = 0;
  const total = selected.filter((company) => company.active).length;
  const summaries: PipelineSummary[] = [];
  const discovery = await discoverJobs(selected, (found, company) => {
    index += 1;
    if (found.length > 0) {
      const stored = upsertJobs(workspace.db, found);
      inserted += stored.inserted;
      updated += stored.updated;
      summaries.push(evaluateAndStore(workspace.db, found, workspace.campaign, workspace.profile));
    }
    input.onBoard?.(company, found, index, total);
  });
  const summary = mergeSummaries(summaries);

  appendEvent(workspace.db, "discovery.run", "campaign", {
    boards: discovery.boardsQueried,
    found: discovery.jobs.length,
    accepted: summary.accepted,
  });

  return {
    boardsQueried: discovery.boardsQueried,
    postingsFetched: discovery.jobs.length,
    newPostings: inserted,
    refreshedPostings: updated,
    evaluation: summary,
    totalStoredJobs: countJobs(workspace.db),
    boardIssues: discovery.issues,
  };
}
