import { z } from "zod";
import { countHarvestedBoards, listHarvestRuns, matchingHarvestedBoards } from "../../db/repositories/harvest.js";
import { countLeads, LEAD_STATUSES, listLeads } from "../../db/repositories/leads.js";
import { AtsKindSchema } from "../../domain/campaign.js";
import { invalidateWorkspace } from "../../runner/workspace.js";
import { setLeadsStatus } from "../../sourcing/leadStatus.js";
import { acceptCompanyProposals } from "../../sourcing/proposals.js";
import { pendingProposals } from "../queries/leads.js";
import { parseBody, parseQuery, type Router } from "../router.js";
import { queryInt, queryText } from "./shared.js";

/**
 * Leads: companies seen hiring in job alerts, funding news and harvested
 * boards; setting them aside or back; the boards a "propose" run verified for
 * them, saved only when the person accepts; and what board harvesting found.
 */

const HARVEST_MATCHING_SHOWN = 25;
const HARVEST_RUNS_SHOWN = 10;

const LeadsQuery = z.object({
  status: z.preprocess((value) => (value === "" ? undefined : value), z.enum(LEAD_STATUSES).optional()),
  source: queryText(60),
  limit: queryInt(1, 500, 100),
});

const AcceptBody = z
  .object({
    proposals: z
      .array(
        z
          .object({
            company: z.string().trim().min(1).max(200),
            ats: AtsKindSchema,
            board: z.string().trim().min(1).max(200),
            region: z.enum(["global", "eu"]).optional(),
            tier: z.enum(["A", "B", "C"]).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(25),
  })
  .strict();

/** Ignore sets leads aside; "new" restores them. Resolved leads are never changed by the service. */
const LeadStatusBody = z
  .object({
    ids: z.array(z.string().trim().min(1).max(200)).min(1).max(500),
    status: z.enum(["ignored", "new"]),
  })
  .strict();

export function registerRoutes(router: Router): void {
  router.get("/api/leads", (request) => {
    const query = parseQuery(LeadsQuery, request);
    const { db } = request.ctx.workspace();
    const leads = listLeads(db, { status: query.status, source: query.source, limit: query.limit });
    return { counts: countLeads(db), count: leads.length, leads };
  });

  router.get("/api/leads/proposals", ({ ctx }) => pendingProposals(ctx.workspace()));

  router.post("/api/leads/status", (request) => {
    const body = parseBody(LeadStatusBody, request);
    return setLeadsStatus(request.ctx.workspace(), body);
  });

  /** Each board is verified again before it is written; an existing company entry is never replaced. */
  router.post("/api/leads/proposals/accept", async (request) => {
    const body = parseBody(AcceptBody, request);
    const result = await acceptCompanyProposals(request.ctx.workspace(), body.proposals);
    if (result.saved.length > 0) invalidateWorkspace();
    return {
      ...result,
      nextStep: result.saved.length > 0 ? "Saved boards are live; start a discovery run to read their postings." : "Nothing was saved.",
    };
  });

  router.get("/api/harvest", ({ ctx }) => {
    const { db } = ctx.workspace();
    return {
      boards: countHarvestedBoards(db),
      matching: matchingHarvestedBoards(db, HARVEST_MATCHING_SHOWN),
      runs: listHarvestRuns(db, HARVEST_RUNS_SHOWN),
      leads: countLeads(db).filter((count) => count.source === "common-crawl"),
    };
  });
}
