import { statSync } from "node:fs";
import { getWorkspace, loadCampaign, loadCompanies, loadProfile, type Workspace } from "../config/load.js";
import type { WorkspacePaths } from "../config/paths.js";

/**
 * Configuration that follows edits without reopening the database.
 *
 * `reloadWorkspace()` closes the shared database handle before reopening it.
 * A submission run holds that handle across a browser session that can last
 * minutes and records the result at the end; closing the handle underneath it
 * would lose the record of an application that really was sent. Long-lived
 * hosts (the run queue and the dashboard) therefore never call it: they keep
 * the open handle and re-read the three configuration files whenever one of
 * them changes on disk.
 */

type Snapshot = { base: Workspace; stamp: string; view: Workspace };

let snapshot: Snapshot | null = null;

function stampOf(paths: WorkspacePaths): string {
  return [paths.profile, paths.campaign, paths.companies]
    .map((path) => {
      try {
        const stat = statSync(path);
        return `${stat.mtimeMs}:${stat.size}`;
      } catch {
        return "missing";
      }
    })
    .join("|");
}

/**
 * The workspace with current configuration. Throws the loader's AppError when
 * a file on disk is invalid, rather than silently running on the old copy.
 */
export function freshWorkspace(): Workspace {
  const base = getWorkspace();
  const stamp = stampOf(base.paths);
  if (snapshot && snapshot.base === base && snapshot.stamp === stamp) return snapshot.view;
  const view: Workspace = {
    ...base,
    profile: loadProfile(base.paths.profile),
    campaign: loadCampaign(base.paths.campaign),
    companies: loadCompanies(base.paths.companies),
  };
  snapshot = { base, stamp, view };
  return view;
}

/** Forces the next freshWorkspace() to re-read configuration, after this process wrote a file itself. */
export function invalidateWorkspace(): void {
  snapshot = null;
}
