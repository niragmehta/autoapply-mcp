import type { AtsKind, Company } from "../domain/campaign.js";
import type { Job } from "../domain/job.js";

/** Contract every ATS adapter implements. */
export type SourceAdapter = {
  kind: AtsKind;
  /** Public listing endpoint for a board. */
  listUrl(company: Company): string;
  /** Human-facing board page. */
  boardUrl(company: Company): string;
  /** Fetches and normalizes all published postings for a board. */
  listJobs(company: Company, capturedAt: string): Promise<Job[]>;
  /** Candidate listing URLs used when resolving an unknown board slug. */
  probeUrls(slug: string): string[];
};

export type DiscoveryIssue = {
  company: string;
  ats: AtsKind;
  board: string;
  code: string;
  message: string;
};
