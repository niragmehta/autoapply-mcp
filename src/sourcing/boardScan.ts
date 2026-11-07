import type { Workspace } from "../config/load.js";
import { CompanySchema, type Campaign, type Company } from "../domain/campaign.js";
import type { Job } from "../domain/job.js";
import type { Profile } from "../domain/profile.js";
import {
  finishHarvestRun,
  HARVEST_STATUSES,
  listHarvestedBoards,
  recordBoardScan,
  startHarvestRun,
  type HarvestAts,
  type HarvestStatus,
} from "../db/repositories/harvest.js";
import { upsertLeads } from "../db/repositories/leads.js";
import { evaluateJob } from "../pipeline.js";
import { fetchJson } from "../sources/http.js";
import { adapterFor } from "../sources/registry.js";
import { AppError, toErrorMessage } from "../util/errors.js";
import { harvestKey } from "./ccIndex.js";
import { scanWorkdayBoard } from "./workdayScan.js";

/**
 * Scans harvested boards for postings this campaign would accept.
 *
 * Each board's postings are fetched through the regular adapters and run
 * through the same gates and scoring as discovery, but only in memory:
 * nothing is stored in the jobs table, because these companies are not part of
 * the campaign yet. A board with fitting roles is recorded as a lead naming its
 * board, which propose_companies then offers to the candidate.
 */

export const COMMON_CRAWL_SOURCE = "common-crawl";

export type BoardMatch = { title: string; location: string; score: number; tier: string; track: string | null; url: string; compensation: string };

export type BoardScanResult = {
  ats: HarvestAts;
  board: string;
  company: string;
  status: HarvestStatus;
  postings: number;
  matching: number;
  review: number;
  topMatches: BoardMatch[];
  detail: string;
};

export type ScanDeps = {
  fetchBoard: (company: Company, campaign: Campaign, capturedAt: string) => Promise<{ jobs: Job[]; postings: number }>;
  /** The employer's display name, for a board worth showing; null to keep the slug-derived name. */
  boardName: (company: Company) => Promise<string | null>;
};

const DEFAULT_DEPS: ScanDeps = {
  fetchBoard: async (company, campaign, capturedAt) => {
    if (company.ats === "workday") return scanWorkdayBoard(company, campaign, capturedAt);
    const jobs = await adapterFor(company.ats).listJobs(company, capturedAt);
    return { jobs, postings: jobs.length };
  },
  boardName: async (company) => {
    if (company.ats !== "greenhouse") return null;
    const meta = await fetchJson<{ name?: unknown }>(`https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(company.board)}`, { retries: 0 });
    return typeof meta.name === "string" && meta.name.trim() ? meta.name.trim().slice(0, 80) : null;
  },
};

/** "acme-robotics" -> "Acme Robotics"; Workday boards are named after their tenant. */
export function displayName(ats: string, board: string): string {
  const slug = ats === "workday" ? board.split("/")[0]! : board;
  return slug
    .replace(/[._-]+/g, " ")
    .trim()
    .split(/\s+/)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

export type ScanContext = { campaign: Campaign; profile: Profile; now: Date; maxMatches: number };

/** Fetches one board and evaluates its postings in memory. */
export async function scanBoard(
  target: { ats: HarvestAts; board: string; region: "global" | "eu" },
  context: ScanContext,
  deps: ScanDeps = DEFAULT_DEPS,
): Promise<BoardScanResult> {
  const company = CompanySchema.parse({ name: displayName(target.ats, target.board), ats: target.ats, board: target.board, region: target.region, tier: "C", tags: ["harvested"] });
  const base = { ats: target.ats, board: target.board, company: company.name, postings: 0, matching: 0, review: 0, topMatches: [], detail: "" };
  let fetched: { jobs: Job[]; postings: number };
  try {
    fetched = await deps.fetchBoard(company, context.campaign, context.now.toISOString());
  } catch (error) {
    const gone = error instanceof AppError && (error.code === "not_found" || error.code === "invalid_board");
    return { ...base, status: gone ? "dead" : "error", detail: toErrorMessage(error).slice(0, 300) };
  }
  if (fetched.jobs.length === 0 && fetched.postings === 0) return { ...base, status: "empty", detail: "the board publishes no postings" };

  const evaluated = fetched.jobs.map((job) => ({ job, evaluation: evaluateJob(job, context.campaign, context.profile, context.now) }));
  const accepted = evaluated.filter((entry) => entry.evaluation.decision === "accept").sort((a, b) => b.evaluation.score - a.evaluation.score);
  const review = evaluated.filter((entry) => entry.evaluation.decision === "review").length;
  let name = company.name;
  if (accepted.length > 0) name = (await deps.boardName(company).catch(() => null)) ?? name;
  return {
    ...base,
    company: name,
    status: accepted.length > 0 ? "matching" : "no-match",
    postings: Math.max(fetched.postings, fetched.jobs.length),
    matching: accepted.length,
    review,
    topMatches: accepted.slice(0, context.maxMatches).map(({ job, evaluation }) => ({
      title: job.title,
      location: job.locationsRaw.join(" | ").slice(0, 160),
      score: evaluation.score,
      tier: evaluation.tier,
      track: evaluation.trackId,
      url: job.url,
      compensation: job.compensation?.raw ?? "not published",
    })),
  };
}

export type ScanOptions = {
  ats?: readonly HarvestAts[];
  /** Boards per run. */
  limit?: number;
  statuses?: readonly HarvestStatus[];
  /** Also rescan scanned boards whose last scan is older than this. */
  rescanAfterDays?: number;
  concurrency?: number;
  maxMatchesPerBoard?: number;
  now?: Date;
  deps?: ScanDeps;
};

export type ScanProgress = { stage: "scan" | "board" | "done"; message: string; current?: number; total?: number; board?: string };

export type ScanSummary = {
  runId: string;
  scanned: number;
  counts: Record<string, number>;
  matching: BoardScanResult[];
  aborted: boolean;
};

export async function scanHarvestedBoards(
  workspace: Pick<Workspace, "db" | "companies" | "campaign" | "profile">,
  options: ScanOptions = {},
  onProgress: (progress: ScanProgress) => void = () => undefined,
  signal?: AbortSignal,
): Promise<ScanSummary> {
  const now = options.now ?? new Date();
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 25), 1), 5000);
  const statuses = (options.statuses ?? ["new"]).filter((status) => (HARVEST_STATUSES as readonly string[]).includes(status));
  const rescan = options.rescanAfterDays === undefined
    ? undefined
    : { statuses: ["matching", "no-match", "error"] as HarvestStatus[], before: new Date(now.getTime() - options.rescanAfterDays * 86_400_000).toISOString() };
  const targets = listHarvestedBoards(workspace.db, { ats: options.ats, statuses, rescan, limit });
  const tracked = new Set(workspace.companies.map((company) => harvestKey(company.ats, company.board)));
  const runId = startHarvestRun(workspace.db, "scan", { ats: options.ats ?? null, limit, statuses, rescanAfterDays: options.rescanAfterDays ?? null });
  const summary: ScanSummary = { runId, scanned: 0, counts: {}, matching: [], aborted: false };
  const context: ScanContext = { campaign: workspace.campaign, profile: workspace.profile, now, maxMatches: options.maxMatchesPerBoard ?? 5 };
  onProgress({ stage: "scan", message: `scanning ${targets.length} harvested board(s)`, total: targets.length });

  const queue = [...targets];
  let done = 0;
  const worker = async () => {
    for (let target = queue.shift(); target; target = queue.shift()) {
      if (signal?.aborted) {
        summary.aborted = true;
        return;
      }
      const result: BoardScanResult = tracked.has(harvestKey(target.ats, target.board))
        ? { ats: target.ats, board: target.board, company: target.company, status: "tracked", postings: 0, matching: 0, review: 0, topMatches: [], detail: "already in companies.json" }
        : await scanBoard(target, context, options.deps ?? DEFAULT_DEPS);
      recordBoardScan(workspace.db, target.ats, target.board, { status: result.status, postings: result.postings, matching: result.matching, company: result.company, detail: result.detail }, now.toISOString());
      if (result.status === "matching") {
        summary.matching.push(result);
        const top = result.topMatches[0];
        upsertLeads(workspace.db, [{
          source: COMMON_CRAWL_SOURCE,
          sourceId: harvestKey(result.ats, result.board),
          title: top?.title ?? "",
          company: result.company,
          location: top?.location ?? "",
          url: top?.url ?? "",
          details: { ats: result.ats, board: result.board, region: target.region, matching: result.matching, postings: result.postings },
        }]);
      }
      summary.counts[result.status] = (summary.counts[result.status] ?? 0) + 1;
      summary.scanned += 1;
      done += 1;
      onProgress({
        stage: "board",
        message: `${result.ats}/${result.board}: ${result.status}${result.status === "matching" ? `, ${result.matching} fitting of ${result.postings}` : ""}`,
        current: done,
        total: targets.length,
        board: `${result.ats}:${result.board}`,
      });
    }
  };
  await Promise.all(Array.from({ length: Math.min(Math.max(options.concurrency ?? 3, 1), 8) }, worker));
  summary.matching.sort((a, b) => b.matching - a.matching || a.company.localeCompare(b.company));
  finishHarvestRun(workspace.db, runId, summary.aborted ? "aborted" : "done", { scanned: summary.scanned, counts: summary.counts, matching: summary.matching.length });
  onProgress({ stage: "done", message: `${summary.aborted ? "cancelled" : "done"}: ${summary.scanned} scanned, ${summary.matching.length} with fitting roles` });
  return summary;
}
