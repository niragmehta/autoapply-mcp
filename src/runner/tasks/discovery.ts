import { z } from "zod";
import { mergeSummaries, type PipelineSummary } from "../../pipeline.js";
import { runDiscovery } from "../../services/discovery.js";
import type { DiscoveryIssue } from "../../sources/types.js";
import { AppError } from "../../util/errors.js";
import type { TaskContext } from "../types.js";
import { chunk } from "../util.js";

/**
 * Discovery as a run: active boards are fetched in chunks, each chunk through
 * the same runDiscovery service the discover_jobs tool uses. Every board is
 * stored as soon as it arrives, so cancelling between chunks keeps everything
 * fetched so far.
 */

export const DiscoveryParamsSchema = z
  .object({
    /** Company names to refresh; every active board when absent or empty. */
    companies: z.array(z.string().trim().min(1)).max(5000).optional(),
    /** Boards per runDiscovery call. Smaller chunks make cancel and config edits take effect sooner. */
    chunkSize: z.number().int().min(1).max(200).default(10),
  })
  .strict();
export type DiscoveryParams = z.infer<typeof DiscoveryParamsSchema>;

export type DiscoveryRunSummary = {
  boards: number;
  boardsQueried: number;
  postingsFetched: number;
  newPostings: number;
  refreshedPostings: number;
  evaluation: PipelineSummary;
  boardIssues: number;
  issues: DiscoveryIssue[];
  stoppedEarly: boolean;
};

function selectBoards(ctx: TaskContext, names: readonly string[] | undefined): string[] {
  const companies = ctx.workspace.companies;
  if (!names || names.length === 0) return companies.filter((company) => company.active).map((company) => company.name);
  const wanted = new Map(names.map((name) => [name.toLowerCase(), name]));
  const known = companies.filter((company) => wanted.has(company.name.toLowerCase()));
  const unknown = [...wanted.entries()]
    .filter(([key]) => !companies.some((company) => company.name.toLowerCase() === key))
    .map(([, name]) => name);
  if (unknown.length > 0) ctx.log("warn", `Not in companies.json, skipped: ${unknown.join(", ")}`);
  const inactive = known.filter((company) => !company.active).map((company) => company.name);
  if (inactive.length > 0) ctx.log("info", `Inactive boards skipped: ${inactive.join(", ")}`);
  return [...new Set(known.filter((company) => company.active).map((company) => company.name))];
}

export async function runDiscoveryTask(ctx: TaskContext, params: DiscoveryParams): Promise<DiscoveryRunSummary> {
  const boards = selectBoards(ctx, params.companies);
  if (boards.length === 0) {
    throw new AppError("no_companies", "no active boards match; check companies.json or the companies filter");
  }
  const chunks = chunk(boards, params.chunkSize);
  const summaries: PipelineSummary[] = [];
  const issues: DiscoveryIssue[] = [];
  const totals = { boardsQueried: 0, postingsFetched: 0, newPostings: 0, refreshedPostings: 0 };
  let done = 0;
  let reached = 0;

  ctx.progress(0, boards.length);
  ctx.log("info", `Discovering ${boards.length} board(s) in ${chunks.length} chunk(s) of up to ${params.chunkSize}.`);

  for (const [index, names] of chunks.entries()) {
    if (ctx.signal.aborted) break;
    const outcome = await runDiscovery(ctx.workspace, {
      companies: names,
      onBoard: (company, jobs) => {
        done += 1;
        ctx.progress(done, boards.length);
        ctx.log("info", `${company.name}: ${jobs.length} posting(s)`, { company: company.name, postings: jobs.length });
      },
    });
    // A board that failed to fetch never reports back, so progress catches up per chunk.
    reached += names.length;
    done = Math.max(done, reached);
    ctx.progress(done, boards.length);

    totals.boardsQueried += outcome.boardsQueried;
    totals.postingsFetched += outcome.postingsFetched;
    totals.newPostings += outcome.newPostings;
    totals.refreshedPostings += outcome.refreshedPostings;
    summaries.push(outcome.evaluation);
    for (const issue of outcome.boardIssues) {
      issues.push(issue);
      ctx.log("warn", `${issue.company} (${issue.ats}/${issue.board}): ${issue.code} - ${issue.message}`, issue);
    }
    ctx.log(
      "info",
      `Chunk ${index + 1}/${chunks.length}: ${outcome.newPostings} new, ${outcome.evaluation.accepted} accepted, ${outcome.boardIssues.length} board issue(s).`,
    );
  }

  const evaluation = mergeSummaries(summaries);
  ctx.log(
    "info",
    `Discovery done: ${totals.postingsFetched} posting(s) from ${totals.boardsQueried} board(s), ${totals.newPostings} new, ${evaluation.accepted} accepted.`,
  );
  return {
    boards: boards.length,
    ...totals,
    evaluation,
    boardIssues: issues.length,
    issues: issues.slice(0, 50),
    stoppedEarly: ctx.signal.aborted,
  };
}
