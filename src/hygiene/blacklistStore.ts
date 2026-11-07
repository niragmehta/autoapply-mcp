import type { Workspace } from "../config/load.js";
import { reloadWorkspace } from "../config/load.js";
import { updateJsonFile } from "../config/write.js";
import { getJob } from "../db/repositories/jobs.js";
import { CampaignSchema } from "../domain/campaign.js";
import type { Job } from "../domain/job.js";
import { BlacklistEntrySchema, type BlacklistEntry } from "../domain/policies/hygiene.js";
import { evaluateAndStore } from "../pipeline.js";
import { AppError } from "../util/errors.js";
import { matchBlacklist, normalizeDomain, sameBlacklistEntry } from "./blacklist.js";

/**
 * Recording do-not-apply decisions in campaign.json.
 *
 * The file is edited atomically with a dated backup, the result is validated
 * before it is written, and the workspace is reloaded so the gate applies at
 * once. Stored postings that the new entries match are re-evaluated, so they
 * leave the queue now rather than at the next discovery run.
 */

export type BlacklistInput = { company?: string; domain?: string; reason: string };

export type BlacklistUpdate = {
  added: BlacklistEntry[];
  alreadyListed: BlacklistEntry[];
  backupPath: string | null;
  blacklist: BlacklistEntry[];
  /** Stored postings re-evaluated because a new entry matches them. */
  reevaluated: number;
  workspace: Workspace;
};

function requestedEntries(input: BlacklistInput, since: string): BlacklistEntry[] {
  const entries: BlacklistEntry[] = [];
  if (input.company?.trim()) {
    entries.push(BlacklistEntrySchema.parse({ scope: "company", value: input.company.trim(), reason: input.reason, since }));
  }
  if (input.domain?.trim()) {
    const domain = normalizeDomain(input.domain);
    if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(domain)) {
      throw new AppError("invalid_domain", `"${input.domain}" is not a domain such as example.com`);
    }
    entries.push(BlacklistEntrySchema.parse({ scope: "domain", value: domain, reason: input.reason, since }));
  }
  if (entries.length === 0) throw new AppError("blacklist_empty", "give a company name, a domain, or both");
  return entries;
}

function matchingJobs(workspace: Workspace, entries: readonly BlacklistEntry[]): Job[] {
  const rows = workspace.db.prepare("SELECT id, company_name, url, apply_url FROM jobs").all() as Array<Record<string, unknown>>;
  return rows
    .filter((row) =>
      matchBlacklist({ companyName: String(row.company_name), url: String(row.url), applyUrl: String(row.apply_url) }, entries) !== null,
    )
    .map((row) => getJob(workspace.db, String(row.id)))
    .filter((job): job is Job => job !== null);
}

export function addToBlacklist(workspace: Workspace, input: BlacklistInput, now = new Date()): BlacklistUpdate {
  const requested = requestedEntries(input, now.toISOString().slice(0, 10));
  const current = workspace.campaign.hygiene.blacklist;
  const alreadyListed = requested.filter((entry) => current.some((existing) => sameBlacklistEntry(existing, entry)));
  const added = requested.filter((entry) => !current.some((existing) => sameBlacklistEntry(existing, entry)));
  if (added.length === 0) {
    return { added, alreadyListed, backupPath: null, blacklist: current, reevaluated: 0, workspace };
  }

  const { backupPath } = updateJsonFile<Record<string, unknown>>(
    workspace.paths.campaign,
    (raw) => {
      const hygiene = raw.hygiene !== null && typeof raw.hygiene === "object" ? (raw.hygiene as Record<string, unknown>) : {};
      const existing = Array.isArray(hygiene.blacklist) ? hygiene.blacklist : [];
      const next = { ...raw, hygiene: { ...hygiene, blacklist: [...existing, ...added] } };
      const checked = CampaignSchema.safeParse(next);
      if (!checked.success) {
        throw new AppError("config_invalid", `campaign.json would not validate after the change: ${checked.error.issues[0]?.message ?? "unknown"}`);
      }
      return next;
    },
    { backup: true, now },
  );

  const reloaded = reloadWorkspace();
  const affected = matchingJobs(reloaded, added);
  if (affected.length > 0) evaluateAndStore(reloaded.db, affected, reloaded.campaign, reloaded.profile, now);
  return {
    added,
    alreadyListed,
    backupPath,
    blacklist: reloaded.campaign.hygiene.blacklist,
    reevaluated: affected.length,
    workspace: reloaded,
  };
}
