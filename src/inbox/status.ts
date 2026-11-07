import type { Workspace } from "../config/load.js";
import { listEvents } from "../db/repositories/events.js";
import { countInboxByStatus, listInboxStates, type InboxCheckpoint, type InboxStatus } from "../db/repositories/inbox.js";
import { inboxEnvironment, readReplyInboxConfig } from "./config.js";

/**
 * Where reply reading stands, for a status view: whether it is switched on
 * and configured (never the credentials themselves), how many replies sit in
 * each state, and how far each folder has been read.
 */

export type InboxStatusReport = {
  enabled: boolean;
  configured: boolean;
  credentialSource: string | null;
  host: string | null;
  mailboxes: string[];
  replies: Record<InboxStatus, number>;
  checkpoints: InboxCheckpoint[];
  lastScanAt: string | null;
};

export function inboxStatus(workspace: Workspace, env: Record<string, string | undefined> = process.env): InboxStatusReport {
  const config = readReplyInboxConfig(inboxEnvironment(workspace.paths.secrets, env));
  return {
    enabled: workspace.campaign.inbox.enabled,
    configured: config !== null,
    credentialSource: config?.credentialSource ?? null,
    host: config?.host ?? null,
    mailboxes: config?.mailboxes ?? [],
    replies: countInboxByStatus(workspace.db),
    checkpoints: listInboxStates(workspace.db),
    lastScanAt: listEvents(workspace.db, "inbox.scanned", 1)[0]?.ts ?? null,
  };
}
