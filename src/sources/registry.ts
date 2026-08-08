import type { AtsKind, Company } from "../domain/campaign.js";
import type { Job } from "../domain/job.js";
import { AppError, toErrorMessage } from "../util/errors.js";
import { nowIso } from "../util/hash.js";
import { logger } from "../util/logger.js";
import { ashbyAdapter } from "./ashby.js";
import { greenhouseAdapter } from "./greenhouse.js";
import { leverAdapter } from "./lever.js";
import { workdayAdapter } from "./workday.js";
import { probeJson } from "./http.js";
import type { BoardVerification, DiscoveryIssue, SourceAdapter } from "./types.js";

const ADAPTERS: Record<AtsKind, SourceAdapter> = {
  greenhouse: greenhouseAdapter,
  lever: leverAdapter,
  ashby: ashbyAdapter,
  workday: workdayAdapter,
};

export function adapterFor(kind: AtsKind): SourceAdapter {
  const adapter = ADAPTERS[kind];
  if (!adapter) throw new AppError("unknown_ats", `no adapter registered for "${kind}"`);
  return adapter;
}

export function allAdapters(): SourceAdapter[] {
  return Object.values(ADAPTERS);
}

export type DiscoveryResult = {
  jobs: Job[];
  issues: DiscoveryIssue[];
  boardsQueried: number;
};

/**
 * Fetches every configured board. One failing board never aborts the run; it is
 * reported as an issue so a stale slug can be fixed.
 */
export async function discoverJobs(companies: readonly Company[]): Promise<DiscoveryResult> {
  const capturedAt = nowIso();
  const issues: DiscoveryIssue[] = [];
  const jobs: Job[] = [];
  const active = companies.filter((company) => company.active);

  for (const company of active) {
    try {
      const adapter = adapterFor(company.ats);
      const found = await adapter.listJobs(company, capturedAt);
      jobs.push(...found);
      logger.debug("board fetched", { company: company.name, ats: company.ats, count: found.length });
    } catch (error) {
      issues.push({
        company: company.name,
        ats: company.ats,
        board: company.board,
        code: error instanceof AppError ? error.code : "error",
        message: toErrorMessage(error),
      });
      logger.warn("board fetch failed", { company: company.name, error: toErrorMessage(error) });
    }
  }

  return { jobs, issues, boardsQueried: active.length };
}

/**
 * Confirms a board slug serves real postings.
 *
 * Board slugs increasingly come from outside this server — a web search, a
 * careers-page URL, a human's guess — and a wrong one is not reliably an error:
 * some ATS hosts answer 200 with a generic page carrying no postings. So a slug
 * is only trusted once postings have actually been seen. This costs one request
 * and no third-party credits, which is why verification lives here rather than
 * wherever the candidate came from.
 */
export async function verifyBoard(company: Company): Promise<BoardVerification> {
  const adapter = adapterFor(company.ats);
  try {
    if (adapter.verifyBoard) return await adapter.verifyBoard(company);
    const jobs = await adapter.listJobs(company, nowIso());
    return {
      ok: jobs.length > 0,
      postings: jobs.length,
      sampleTitles: jobs.slice(0, 3).map((job) => job.title),
      detail: jobs.length > 0 ? "board returned postings" : "board responded but published no postings",
    };
  } catch (error) {
    return { ok: false, postings: 0, sampleTitles: [], detail: toErrorMessage(error) };
  }
}

export type BoardCandidate = {
  ats: AtsKind;
  board: string;
  url: string;
  ok: boolean;
  status: string;
};

function slugVariants(companyName: string): string[] {
  const base = companyName.trim().toLowerCase();
  const alphanumeric = base.replace(/[^a-z0-9]+/g, "");
  const hyphenated = base.replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  const noSuffix = base.replace(/\b(inc|llc|ltd|corp|technologies|labs|ai)\b/g, "").replace(/[^a-z0-9]+/g, "");
  return [...new Set([alphanumeric, hyphenated, noSuffix, companyName.trim()])].filter((value) => value.length > 1);
}

/**
 * Probes ATS endpoints to find a company's real board slug. Board tokens are
 * not published anywhere central, so guesses must be verified rather than
 * trusted.
 */
export async function resolveBoards(companyName: string, extraSlugs: readonly string[] = []): Promise<BoardCandidate[]> {
  const slugs = [...new Set([...slugVariants(companyName), ...extraSlugs])];
  const results: BoardCandidate[] = [];

  for (const slug of slugs) {
    for (const adapter of allAdapters()) {
      for (const url of adapter.probeUrls(slug)) {
        const probe = await probeJson(url);
        if (probe.ok) {
          results.push({ ats: adapter.kind, board: slug, url, ok: true, status: probe.status });
        }
      }
    }
  }
  return results;
}
