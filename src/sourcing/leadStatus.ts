import type { Workspace } from "../config/load.js";
import { appendEvent } from "../db/repositories/events.js";
import { listLeads, setLeadStatus } from "../db/repositories/leads.js";
import { AppError } from "../util/errors.js";

const MAX_IDS = 500;

export type LeadStatusInput = { ids: readonly string[]; status: "ignored" | "new" };

/**
 * Sets leads aside (ignored) or back to new. A lead already resolved to a
 * board in companies.json keeps that status: it records a decision that was
 * acted on, which neither choice should undo.
 */
export function setLeadsStatus(workspace: Workspace, input: LeadStatusInput) {
  const ids = [...new Set(input.ids)];
  if (ids.length === 0) throw new AppError("invalid_input", "name at least one lead id");
  if (ids.length > MAX_IDS) throw new AppError("invalid_input", `at most ${MAX_IDS} leads can be changed at once`);

  const known = new Map(listLeads(workspace.db, { ids, limit: ids.length }).map((lead) => [lead.id, lead]));
  const changeable = ids.filter((id) => {
    const lead = known.get(id);
    return lead !== undefined && lead.status !== "resolved" && lead.status !== input.status;
  });
  if (changeable.length > 0) {
    setLeadStatus(workspace.db, changeable, input.status);
    appendEvent(workspace.db, "leads.status", input.status, { count: changeable.length });
  }
  return { status: input.status, updated: changeable.length, missing: ids.filter((id) => !known.has(id)) };
}
