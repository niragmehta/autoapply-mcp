import { z } from "zod";
import type { Workspace } from "../../config/load.js";
import { listRuns } from "../../db/repositories/runs.js";
import { companyKey } from "../../sourcing/fundedParse.js";

/**
 * Company proposals are not stored on their own: a "propose" run returns them
 * in its summary. The Leads page reads the latest successful run's summary
 * and hides companies already in companies.json, so an accepted proposal
 * drops out without another run.
 */

const ProposedBoardSchema = z.object({
  ats: z.string(),
  board: z.string(),
  region: z.enum(["global", "eu"]).catch("global"),
  postings: z.number().catch(0),
  sampleTitles: z.array(z.string()).catch([]),
});

const ProposalSchema = z.object({
  company: z.string(),
  leadIds: z.array(z.string()).catch([]),
  sources: z.array(z.string()).catch([]),
  boards: z.array(ProposedBoardSchema).catch([]),
});

const SummarySchema = z.object({
  proposals: z.array(z.unknown()).catch([]),
  unresolved: z.array(z.object({ company: z.string(), leadIds: z.array(z.string()).catch([]) })).catch([]),
  remaining: z.number().catch(0),
});

export type PendingProposal = z.infer<typeof ProposalSchema>;

export type PendingProposals = {
  runId: string | null;
  finishedAt: string | null;
  proposals: PendingProposal[];
  unresolved: Array<{ company: string; leadIds: string[] }>;
  remaining: number;
  alreadyTracked: number;
};

const NONE: PendingProposals = { runId: null, finishedAt: null, proposals: [], unresolved: [], remaining: 0, alreadyTracked: 0 };

export function pendingProposals(workspace: Pick<Workspace, "db" | "companies">): PendingProposals {
  const [run] = listRuns(workspace.db, { type: "propose", statuses: ["succeeded"], limit: 1 });
  if (!run) return NONE;
  const summary = SummarySchema.safeParse(run.summary);
  if (!summary.success) return { ...NONE, runId: run.id, finishedAt: run.finishedAt };
  const tracked = new Set(workspace.companies.map((company) => companyKey(company.name)));
  const proposals = summary.data.proposals.flatMap((item) => {
    const parsed = ProposalSchema.safeParse(item);
    return parsed.success && parsed.data.boards.length > 0 ? [parsed.data] : [];
  });
  const pending = proposals.filter((proposal) => !tracked.has(companyKey(proposal.company)));
  return {
    runId: run.id,
    finishedAt: run.finishedAt,
    proposals: pending,
    unresolved: summary.data.unresolved,
    remaining: summary.data.remaining,
    alreadyTracked: proposals.length - pending.length,
  };
}
