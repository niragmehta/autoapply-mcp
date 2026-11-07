import { z } from "zod";
import { FOLLOWUP_KINDS } from "../../db/repositories/followups.js";
import { followUpsDue, markFollowUp } from "../../followup/cadence.js";
import { careerContactLookup } from "../../followup/contacts.js";
import { resetAfterApplyCache } from "../queries/afterApply.js";
import { handledFollowUps } from "../queries/followups.js";
import { parseBody, parseQuery, type Router } from "../router.js";
import { queryInt } from "./shared.js";

/**
 * Follow-ups: what is due, with drafts to copy, what was handled lately, and
 * marking each one done (you sent it), skipped (resolved without sending, so
 * it counts as no contact) or snoozed. Nothing is ever sent from here.
 */

const DueQuery = z.object({ horizonDays: queryInt(0, 60, 7) });

const MarkBody = z
  .object({
    applicationId: z.string().trim().min(1).max(200),
    kind: z.enum(FOLLOWUP_KINDS),
    action: z.enum(["done", "skip", "snooze"]),
    days: z.number().int().min(1).max(90).optional(),
    note: z.string().trim().max(500).optional(),
  })
  .strict();

export function registerRoutes(router: Router): void {
  router.get("/api/follow-ups", (request) => {
    const query = parseQuery(DueQuery, request);
    const workspace = request.ctx.workspace();
    const plan = followUpsDue(workspace, { horizonDays: query.horizonDays, contactLookup: careerContactLookup(workspace.db) });
    return { ...plan, handled: handledFollowUps(workspace.db, { sinceDays: 30, limit: 30 }) };
  });

  router.post("/api/follow-ups/mark", (request) => {
    const body = parseBody(MarkBody, request);
    const result = markFollowUp(request.ctx.workspace(), body);
    resetAfterApplyCache();
    return { action: body.action, ...result };
  });
}
