import type { Workspace } from "../config/load.js";
import { reloadWorkspace } from "../config/load.js";
import { resolvePaths, type WorkspacePaths } from "../config/paths.js";
import { appendEvent } from "../db/repositories/events.js";
import { toErrorMessage } from "../util/errors.js";
import { applyCampaignPatch, applyProfilePatch, type PatchOptions, type PatchResult } from "./profilePatch.js";

/**
 * Patch, reload, audit: the sequence every caller of a guided edit needs. The
 * MCP tools, the dashboard and any CLI share it so an edit always takes effect
 * at once and always leaves an audit record naming what changed (never the
 * value).
 */

export type EditOutcome = PatchResult & { reloaded: boolean; reloadError?: string };

export type EditDeps = {
  paths?: WorkspacePaths;
  reload?: () => Workspace;
  options?: PatchOptions;
};

function finish(result: PatchResult, kind: "profile" | "campaign", reload: () => Workspace): EditOutcome {
  if (result.unchanged) return { ...result, reloaded: false };
  try {
    const workspace = reload();
    appendEvent(workspace.db, `${kind}.updated`, kind, { paths: result.changed.map((change) => `${change.op} ${change.path}`) });
    return { ...result, reloaded: true };
  } catch (error) {
    // The write itself succeeded; the other file may be what fails to load.
    return { ...result, reloaded: false, reloadError: toErrorMessage(error) };
  }
}

export function updateProfile(ops: unknown, deps: EditDeps = {}): EditOutcome {
  const result = applyProfilePatch(deps.paths ?? resolvePaths(), ops, deps.options);
  return finish(result, "profile", deps.reload ?? reloadWorkspace);
}

export function updateCampaign(ops: unknown, deps: EditDeps = {}): EditOutcome {
  const result = applyCampaignPatch(deps.paths ?? resolvePaths(), ops, deps.options);
  return finish(result, "campaign", deps.reload ?? reloadWorkspace);
}
