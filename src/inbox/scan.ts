import type { Workspace } from "../config/load.js";
import { appendEvent } from "../db/repositories/events.js";
import { getInboxState, saveInboxState } from "../db/repositories/inbox.js";
import { AppError } from "../util/errors.js";
import { logger } from "../util/logger.js";
import type { IncomingReply } from "./analysis.js";
import { loadApplicationIndex, type ApplicationIndex } from "./companies.js";
import { inboxEnvironment, readReplyInboxConfig, type ReplyInboxConfig } from "./config.js";
import { candidateReason, type EnvelopeView } from "./filter.js";
import { createImapClient, type ImapAddress, type ImapClientFactory, type ImapMessage, type ReplyImapClient } from "./imap.js";
import { extractMessageText, stripQuotedReply } from "./mime.js";
import { processReply, type ProcessedReply } from "./process.js";

/**
 * Reads the configured mailbox for replies to applications.
 *
 * Envelopes first: only a message whose sender or subject marks it as hiring
 * mail has its source downloaded, capped in size. Each folder resumes from the
 * last UID it was read to, unless the server renumbered it (UIDVALIDITY) or a
 * lookback was asked for, in which case it is searched by date. Message-IDs
 * make a re-read harmless.
 */

export type ScanOptions = {
  /** Read this many days back regardless of the checkpoint. */
  lookbackDays?: number;
  /** Classify and match, but store nothing and leave checkpoints alone. */
  dryRun?: boolean;
  now?: Date;
  /** The longest the whole read may take before the connection is dropped. */
  readTimeoutMs?: number;
  /** Sources downloaded per folder per scan; the rest wait for the next scan. */
  maxCandidatesPerMailbox?: number;
};

export type ScanDependencies = {
  config?: ReplyInboxConfig | null;
  createClient?: ImapClientFactory;
};

export type MailboxReport = {
  mailbox: string;
  mode: "checkpoint" | "lookback" | "skipped";
  since: string | null;
  envelopes: number;
  candidates: number;
  downloaded: number;
  /** Candidates left for the next scan because of the per-folder cap. */
  deferred: number;
  complete: boolean;
  error?: string;
};

export type ScanResult = {
  dryRun: boolean;
  host: string;
  credentialSource: string;
  timedOut: boolean;
  mailboxes: MailboxReport[];
  counts: { candidates: number; stored: number; duplicates: number; recorded: number; proposed: number; dismissed: number };
  replies: ProcessedReply[];
  errors: string[];
};

const DEFAULT_READ_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_CANDIDATES = 300;
/** Recruiting mail is small; a logo-heavy HTML message is cut here, after its text part. */
const SOURCE_MAX_BYTES = 256 * 1024;
const MAX_TEXT_CHARS = 20_000;
const SOURCE_BATCH = 50;
/** IMAP SINCE is a whole day in the server's time zone; see SEARCH_BACKDATE_MS in verificationInbox.ts. */
const RESUME_BACKDATE_MS = 36 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

type Checkpoint = { mailbox: string; lastUid: number; lastDate: string | null; uidValidity: string | null };

type ReadContext = {
  workspace: Workspace;
  options: ScanOptions;
  index: ApplicationIndex;
  now: Date;
  collected: IncomingReply[];
  reports: MailboxReport[];
  checkpoints: Map<string, Checkpoint>;
  stop: { requested: boolean };
};

function firstAddress(list: ImapAddress[] | undefined): ImapAddress {
  return list?.[0] ?? {};
}

function envelopeView(message: ImapMessage): EnvelopeView {
  const from = firstAddress(message.envelope?.from);
  return {
    fromAddress: from.address ?? "",
    fromName: from.name ?? "",
    replyTo: (message.envelope?.replyTo ?? []).map((entry) => entry.address ?? "").filter((address) => address.length > 0),
    subject: message.envelope?.subject ?? "",
  };
}

function receivedAt(message: ImapMessage): Date | null {
  const candidates = [message.envelope?.date, message.internalDate ? new Date(message.internalDate) : undefined];
  return candidates.find((date): date is Date => date instanceof Date && Number.isFinite(date.getTime())) ?? null;
}

function messageIdentity(message: ImapMessage, mailbox: string, uidValidity: string | null): string {
  const id = message.envelope?.messageId?.trim();
  return id && id.length > 0 ? id.slice(0, 500) : `uid:${mailbox}:${uidValidity ?? "0"}:${message.uid ?? 0}`;
}

function toReply(message: ImapMessage, mailbox: string, uidValidity: string | null, reason: string): IncomingReply {
  const view = envelopeView(message);
  return {
    messageId: messageIdentity(message, mailbox, uidValidity),
    mailbox,
    uid: message.uid ?? null,
    receivedAt: receivedAt(message) ?? new Date(0),
    fromAddress: view.fromAddress,
    fromName: view.fromName,
    replyTo: view.replyTo,
    subject: view.subject,
    text: stripQuotedReply(extractMessageText(message.source ?? Buffer.alloc(0))).slice(0, MAX_TEXT_CHARS),
    filterReason: reason,
  };
}

function scanStart(context: ReadContext, mailbox: string): { since: Date; resumeFrom: number | null; uidValidityKnown: string | null } {
  const state = getInboxState(context.workspace.db, mailbox);
  const lookback = context.options.lookbackDays ?? context.workspace.campaign.inbox.lookbackDays;
  const fromLookback = new Date(context.now.getTime() - lookback * DAY_MS);
  if (context.options.lookbackDays !== undefined || !state) return { since: fromLookback, resumeFrom: null, uidValidityKnown: null };
  const lastDate = state.lastDate ? Date.parse(state.lastDate) : Number.NaN;
  const since = Number.isFinite(lastDate) ? new Date(lastDate - RESUME_BACKDATE_MS) : fromLookback;
  return { since, resumeFrom: state.lastUid > 0 ? state.lastUid : null, uidValidityKnown: state.uidValidity };
}

async function readEnvelopes(
  client: ReplyImapClient,
  start: ReturnType<typeof scanStart>,
  uidValidity: string | null,
): Promise<{ messages: ImapMessage[]; mode: "checkpoint" | "lookback" }> {
  const query = { envelope: true, uid: true, internalDate: true };
  const resume = start.resumeFrom !== null && uidValidity !== null && start.uidValidityKnown === uidValidity;
  const messages: ImapMessage[] = [];
  if (resume) {
    // "n:*" always yields the newest message, even when its UID is below n.
    for await (const message of client.fetch(`${start.resumeFrom! + 1}:*`, query, { uid: true })) {
      if (typeof message.uid === "number" && message.uid > start.resumeFrom!) messages.push(message);
    }
    return { messages, mode: "checkpoint" };
  }
  for await (const message of client.fetch({ since: start.since }, query)) {
    if (typeof message.uid === "number") messages.push(message);
  }
  return { messages, mode: "lookback" };
}

async function readMailbox(client: ReplyImapClient, mailbox: string, context: ReadContext): Promise<void> {
  const report: MailboxReport = { mailbox, mode: "lookback", since: null, envelopes: 0, candidates: 0, downloaded: 0, deferred: 0, complete: false };
  context.reports.push(report);
  const uidValidity = client.mailbox && client.mailbox.uidValidity !== undefined ? String(client.mailbox.uidValidity) : null;
  const start = scanStart(context, mailbox);
  const { messages, mode } = await readEnvelopes(client, start, uidValidity);
  report.mode = mode;
  report.since = mode === "lookback" ? start.since.toISOString() : null;
  report.envelopes = messages.length;

  const candidates = messages
    .map((message) => ({ message, reason: candidateReason(envelopeView(message), context.index) }))
    .filter((entry): entry is { message: ImapMessage; reason: NonNullable<typeof entry.reason> } => entry.reason !== null)
    .sort((a, b) => (a.message.uid ?? 0) - (b.message.uid ?? 0));
  const cap = context.options.maxCandidatesPerMailbox ?? DEFAULT_MAX_CANDIDATES;
  const taken = candidates.slice(0, cap);
  const deferred = candidates.slice(cap);
  report.candidates = candidates.length;
  report.deferred = deferred.length;

  const reasons = new Map(taken.map((entry) => [entry.message.uid!, entry.reason]));
  const uids = [...reasons.keys()];
  for (let offset = 0; offset < uids.length && !context.stop.requested; offset += SOURCE_BATCH) {
    const batch = uids.slice(offset, offset + SOURCE_BATCH);
    const query = { envelope: true, uid: true, internalDate: true, source: { maxLength: SOURCE_MAX_BYTES } };
    for await (const message of client.fetch(batch.join(","), query, { uid: true })) {
      const reason = typeof message.uid === "number" ? reasons.get(message.uid) : undefined;
      if (!reason || context.stop.requested) continue;
      context.collected.push(toReply(message, mailbox, uidValidity, reason));
      report.downloaded += 1;
    }
  }
  if (context.stop.requested) return;

  // A deferred candidate holds the checkpoint back so the next scan reaches it.
  // UIDs from before a renumbering mean nothing, so a date-based read starts from zero.
  const firstDeferred = deferred[0]?.message.uid;
  const highest = messages.reduce((max, message) => Math.max(max, message.uid ?? 0), 0);
  const floor = mode === "checkpoint" ? (start.resumeFrom ?? 0) : 0;
  const lastUid = firstDeferred !== undefined ? firstDeferred - 1 : Math.max(highest, floor);
  const newest = messages.reduce((max, message) => Math.max(max, receivedAt(message)?.getTime() ?? 0), 0);
  const previous = getInboxState(context.workspace.db, mailbox)?.lastDate ?? null;
  const lastDate = newest > 0 && firstDeferred === undefined ? new Date(newest).toISOString() : previous;
  context.checkpoints.set(mailbox, { mailbox, lastUid, lastDate, uidValidity });
  report.complete = true;
}

function describeError(error: unknown): string {
  const code = typeof (error as { code?: unknown })?.code === "string" ? `${(error as { code: string }).code}: ` : "";
  return `${code}${String((error as Error)?.message ?? error)}`.slice(0, 200);
}

async function readAll(client: ReplyImapClient, config: ReplyInboxConfig, context: ReadContext): Promise<void> {
  await client.connect();
  try {
    for (const mailbox of config.mailboxes) {
      if (context.stop.requested) return;
      let lock: { release(): void };
      try {
        lock = await client.getMailboxLock(mailbox, { readOnly: true });
      } catch (error) {
        // Folder names differ by provider and Gmail localises its own; a missing one is normal.
        const missing = (error as { mailboxMissing?: boolean })?.mailboxMissing === true;
        context.reports.push({
          mailbox,
          mode: "skipped",
          since: null,
          envelopes: 0,
          candidates: 0,
          downloaded: 0,
          deferred: 0,
          complete: false,
          error: missing ? "folder not found" : describeError(error),
        });
        continue;
      }
      try {
        await readMailbox(client, mailbox, context);
      } catch (error) {
        const report = context.reports.find((entry) => entry.mailbox === mailbox);
        if (report) report.error = describeError(error);
      } finally {
        lock.release();
      }
    }
  } finally {
    await client.logout().catch(() => undefined);
  }
}

function resolveConfig(workspace: Workspace, deps: ScanDependencies): ReplyInboxConfig {
  const config = deps.config !== undefined ? deps.config : readReplyInboxConfig(inboxEnvironment(workspace.paths.secrets));
  if (!config) {
    throw new AppError(
      "inbox_not_configured",
      "no mailbox configured: set AUTOAPPLY_INBOX_IMAP_USER and AUTOAPPLY_INBOX_IMAP_PASSWORD (or the verification mailbox's AUTOAPPLY_OTP_IMAP_USER and AUTOAPPLY_OTP_IMAP_PASSWORD). See docs/AFTER_APPLY.md.",
    );
  }
  return config;
}

/** Reads, waits at most `timeoutMs`, and drops the connection if the server stalls. */
async function readWithDeadline(client: ReplyImapClient, config: ReplyInboxConfig, context: ReadContext, timeoutMs: number) {
  // ImapFlow reports a dropped socket by emitting 'error'; without a listener
  // that emit would throw on the socket's stack and take the server down.
  client.on("error", (error) => {
    logger.warn("reply inbox connection error", {
      code: typeof error.code === "string" ? error.code : undefined,
      detail: String(error.message ?? "").slice(0, 120),
    });
  });
  const reading = readAll(client, config, context);
  reading.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stalled = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), timeoutMs);
  });
  try {
    const outcome = await Promise.race([reading.then(() => "done" as const), stalled]);
    if (outcome === "timeout") {
      context.stop.requested = true;
      client.close?.();
    }
    return { timedOut: outcome === "timeout", error: null as string | null };
  } catch (error) {
    return { timedOut: false, error: describeError(error) };
  } finally {
    clearTimeout(timer);
  }
}

export async function scanInbox(workspace: Workspace, options: ScanOptions = {}, deps: ScanDependencies = {}): Promise<ScanResult> {
  if (!workspace.campaign.inbox.enabled) {
    throw new AppError(
      "inbox_disabled",
      'reading replies is off: set "inbox": { "enabled": true } in campaign.json, configure the mailbox (docs/AFTER_APPLY.md), then reload_config.',
    );
  }
  const config = resolveConfig(workspace, deps);
  const context: ReadContext = {
    workspace,
    options,
    index: loadApplicationIndex(workspace.db),
    now: options.now ?? new Date(),
    collected: [],
    reports: [],
    checkpoints: new Map(),
    stop: { requested: false },
  };
  const client = await (deps.createClient ?? createImapClient)(config);
  const read = await readWithDeadline(client, config, context, options.readTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS);
  if (context.reports.length === 0 && (read.error || read.timedOut)) {
    throw new AppError(
      "inbox_unreachable",
      `could not read the mailbox at ${config.host}: ${read.error ?? `no answer within ${options.readTimeoutMs ?? DEFAULT_READ_TIMEOUT_MS}ms`}`,
    );
  }
  return finishScan(workspace, config, context, read);
}

function finishScan(
  workspace: Workspace,
  config: ReplyInboxConfig,
  context: ReadContext,
  read: { timedOut: boolean; error: string | null },
): ScanResult {
  const dryRun = context.options.dryRun === true;
  const errors = read.error ? [read.error] : [];
  const failedMailboxes = new Set<string>();
  const seen = new Set<string>();
  const replies: ProcessedReply[] = [];
  const ordered = [...context.collected].sort((a, b) => a.receivedAt.getTime() - b.receivedAt.getTime());
  for (const reply of ordered) {
    if (seen.has(reply.messageId)) continue;
    seen.add(reply.messageId);
    try {
      replies.push(
        processReply(workspace.db, reply, context.index, {
          autoRecord: workspace.campaign.inbox.autoRecord,
          allowAutoRecord: true,
          dryRun,
        }),
      );
    } catch (error) {
      failedMailboxes.add(reply.mailbox);
      errors.push(`could not process a message in ${reply.mailbox}: ${describeError(error)}`);
    }
  }
  if (!dryRun) {
    for (const checkpoint of context.checkpoints.values()) {
      if (!failedMailboxes.has(checkpoint.mailbox)) saveInboxState(workspace.db, checkpoint);
    }
  }
  const fresh = replies.filter((reply) => !reply.duplicate);
  const counts = {
    candidates: context.collected.length,
    stored: dryRun ? 0 : fresh.length,
    duplicates: replies.length - fresh.length,
    recorded: fresh.filter((reply) => reply.action === "record").length,
    proposed: fresh.filter((reply) => reply.action === "propose").length,
    dismissed: fresh.filter((reply) => reply.action === "dismiss").length,
  };
  if (!dryRun) {
    appendEvent(workspace.db, "inbox.scanned", "", { ...counts, mailboxes: context.reports.length, timedOut: read.timedOut });
  }
  logger.info("reply inbox scanned", { ...counts, dryRun, timedOut: read.timedOut });
  return {
    dryRun,
    host: config.host,
    credentialSource: config.credentialSource,
    timedOut: read.timedOut,
    mailboxes: context.reports,
    counts,
    replies: fresh,
    errors,
  };
}
