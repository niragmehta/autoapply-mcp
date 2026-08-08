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
  /**
   * Cheaply confirms a board slug is real before it is trusted.
   *
   * Optional: the generic fallback in the registry just lists the board. Adapters
   * whose listing is expensive (Workday reads every posting's detail page)
   * override this so verification stays a single request.
   */
  verifyBoard?(company: Company): Promise<BoardVerification>;
};

/**
 * Result of checking that a board slug actually serves postings.
 *
 * Needed because a wrong slug does not reliably produce an HTTP error: several
 * ATS hosts answer 200 with a generic page, so "the request succeeded" is not
 * evidence the board exists. `ok` means postings were genuinely found.
 */
export type BoardVerification = {
  ok: boolean;
  postings: number;
  sampleTitles: string[];
  detail: string;
};

export type DiscoveryIssue = {
  company: string;
  ats: AtsKind;
  board: string;
  code: string;
  message: string;
};
