import type { Workspace } from "../config/load.js";
import { appendEvent } from "../db/repositories/events.js";
import { upsertLeads, type Lead, type LeadInput } from "../db/repositories/leads.js";
import { readVerificationInboxConfig, type VerificationInboxConfig } from "../submission/verificationInbox.js";
import { AppError } from "../util/errors.js";
import { logger } from "../util/logger.js";
import { messageBodies } from "./mime.js";
import { parseLinkedInAlert, type AlertJob } from "./linkedinParse.js";

/**
 * LinkedIn job alerts as a lead source.
 *
 * A candidate either pastes an alert email, or lets the server read the
 * alerts that arrive in the mailbox already configured for verification codes.
 * Each posting becomes a lead keyed by its LinkedIn id, so the same alert
 * imported twice adds nothing. The mailbox is opened read-only and messages
 * are fetched with BODY.PEEK, so nothing is marked as read.
 */

export const LINKEDIN_ALERT_SOURCE = "linkedin-alert";

export type LeadSummary = Pick<Lead, "id" | "title" | "company" | "location" | "url" | "status">;

export type AlertImportResult = {
  found: number;
  added: number;
  already: number;
  leads: LeadSummary[];
  message: string;
};

function summarize(lead: Lead): LeadSummary {
  return { id: lead.id, title: lead.title, company: lead.company, location: lead.location, url: lead.url, status: lead.status };
}

function toLead(job: AlertJob): LeadInput {
  return {
    source: LINKEDIN_ALERT_SOURCE,
    sourceId: job.jobId,
    title: job.title,
    company: job.company,
    location: job.location,
    url: job.url,
  };
}

function store(workspace: Pick<Workspace, "db">, jobs: readonly AlertJob[], origin: string): AlertImportResult {
  if (jobs.length === 0) {
    return {
      found: 0,
      added: 0,
      already: 0,
      leads: [],
      message: "No LinkedIn job links found. Paste the whole alert email, including its links (HTML or text).",
    };
  }
  const { added, existing } = upsertLeads(workspace.db, jobs.map(toLead));
  appendEvent(workspace.db, "leads.imported", LINKEDIN_ALERT_SOURCE, { origin, found: jobs.length, added: added.length });
  return {
    found: jobs.length,
    added: added.length,
    already: existing.length,
    leads: added.map(summarize),
    message:
      added.length === 0
        ? "Every job in this alert was already imported."
        : `${added.length} new LinkedIn lead(s). They are leads, not applications: resolve their companies with propose_companies.`,
  };
}

/** Parses a pasted alert (HTML or text) and stores its postings as leads. */
export function importJobAlert(workspace: Pick<Workspace, "db">, input: { text?: string; html?: string }): AlertImportResult {
  if (!input.text?.trim() && !input.html?.trim()) {
    throw new AppError("alert_empty", "supply the alert email as text or html");
  }
  return store(workspace, parseLinkedInAlert(input), "paste");
}

export type AlertMessage = { receivedAt: Date; sender: string; source: Buffer | string; messageId?: string };
export type AlertMailReader = (config: VerificationInboxConfig, since: Date) => Promise<AlertMessage[]>;

export type InboxScanOptions = {
  lookbackDays?: number;
  env?: Record<string, string | undefined>;
  reader?: AlertMailReader;
  now?: Date;
};

export type InboxScanResult = AlertImportResult & { messagesRead: number; lookbackDays: number };

/** LinkedIn sends alerts from job-specific addresses such as jobalerts-noreply@linkedin.com. */
export function isLinkedInAlertSender(address: string): boolean {
  const match = /^([^@\s]+)@((?:[a-z0-9-]+\.)*linkedin\.com)>?$/i.exec(address.trim());
  return Boolean(match && /job/i.test(match[1]!));
}

const MAX_LOOKBACK_DAYS = 90;

/** Reads recent LinkedIn alerts from the verification mailbox and stores their postings as leads. */
export async function scanAlertInbox(workspace: Pick<Workspace, "db">, options: InboxScanOptions = {}): Promise<InboxScanResult> {
  const config = readVerificationInboxConfig(options.env ?? process.env);
  if (!config) {
    throw new AppError(
      "inbox_not_configured",
      "No mailbox configured. Set AUTOAPPLY_OTP_IMAP_USER and AUTOAPPLY_OTP_IMAP_PASSWORD (and AUTOAPPLY_OTP_IMAP_HOST for non-Gmail) in the MCP client's env block, and forward LinkedIn job alerts to that mailbox.",
    );
  }
  const lookbackDays = Math.min(Math.max(Math.trunc(options.lookbackDays ?? 14), 1), MAX_LOOKBACK_DAYS);
  const since = new Date((options.now ?? new Date()).getTime() - lookbackDays * 86_400_000);
  const reader = options.reader ?? readLinkedInAlertMail;
  const messages = (await reader(config, since)).filter((message) => isLinkedInAlertSender(message.sender));

  const jobs = new Map<string, AlertJob>();
  for (const message of messages) {
    if (message.source.length > MAX_MESSAGE_BYTES) continue;
    for (const job of parseLinkedInAlert(messageBodies(message.source))) {
      if (!jobs.has(job.jobId)) jobs.set(job.jobId, job);
    }
  }
  const result = store(workspace, [...jobs.values()], "inbox");
  return {
    ...result,
    messagesRead: messages.length,
    lookbackDays,
    message: messages.length === 0 ? `No LinkedIn job alerts in the last ${lookbackDays} day(s) of the configured mailbox.` : result.message,
  };
}

type ImapClient = {
  on: (event: "error", listener: (error: Error) => void) => unknown;
  connect: () => Promise<void>;
  logout: () => Promise<void>;
  close?: () => void;
  getMailboxLock: (mailbox: string, options?: { readOnly?: boolean }) => Promise<{ release: () => void }>;
  fetch: (
    range: unknown,
    query: unknown,
    options?: unknown,
  ) => AsyncIterable<{ uid?: number; size?: number; envelope?: { date?: Date; messageId?: string; from?: Array<{ address?: string }> }; source?: Buffer }>;
};

/** Upper bound on messages read per scan; alerts arrive at most a few a day. */
const MAX_MESSAGES = 200;
/** An alert is tens of kilobytes; anything far larger is not one and is not downloaded. */
const MAX_MESSAGE_BYTES = 2 * 1024 * 1024;
const READ_TIMEOUT_MS = 60_000;

/**
 * Reads alert messages over IMAP. Each folder is opened read-only (EXAMINE)
 * and bodies are fetched with BODY.PEEK, so the mailbox is left exactly as it
 * was. Bodies are never logged.
 */
export async function readLinkedInAlertMail(config: VerificationInboxConfig, since: Date): Promise<AlertMessage[]> {
  let ImapFlow: new (options: unknown) => ImapClient;
  try {
    const mod = (await import("imapflow")) as unknown as { ImapFlow?: new (options: unknown) => ImapClient };
    if (!mod.ImapFlow) throw new Error("ImapFlow export missing");
    ImapFlow = mod.ImapFlow;
  } catch (error) {
    throw new AppError("imap_unavailable", `the imapflow package is not installed: ${String(error)}. Run npm install imapflow.`);
  }
  const client = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: true,
    auth: { user: config.user, pass: config.password },
    logger: false,
  });
  client.on("error", (error) => logger.warn("alert inbox connection error", { detail: String(error.message ?? "").slice(0, 120) }));

  const read = async (): Promise<AlertMessage[]> => {
    const messages: AlertMessage[] = [];
    const seen = new Set<string>();
    await client.connect();
    try {
      for (const mailbox of config.mailboxes) {
        let lock: { release: () => void };
        try {
          lock = await client.getMailboxLock(mailbox, { readOnly: true });
        } catch {
          continue;
        }
        try {
          const wanted: number[] = [];
          for await (const message of client.fetch({ since, from: "linkedin.com" }, { envelope: true, uid: true, size: true })) {
            const sender = message.envelope?.from?.[0]?.address ?? "";
            const id = message.envelope?.messageId ?? "";
            if (!isLinkedInAlertSender(sender) || typeof message.uid !== "number") continue;
            if ((message.size ?? 0) > MAX_MESSAGE_BYTES) continue;
            if (id && seen.has(id)) continue;
            if (id) seen.add(id);
            wanted.push(message.uid);
          }
          const room = MAX_MESSAGES - messages.length;
          const batch = room > 0 ? wanted.slice(-room) : [];
          if (batch.length === 0) continue;
          for await (const message of client.fetch(batch.join(","), { envelope: true, source: true }, { uid: true })) {
            messages.push({
              receivedAt: message.envelope?.date ?? new Date(0),
              sender: message.envelope?.from?.[0]?.address ?? "",
              source: message.source ?? "",
              messageId: message.envelope?.messageId,
            });
          }
        } finally {
          lock.release();
        }
      }
    } finally {
      await client.logout().catch(() => undefined);
    }
    logger.info("alert inbox read", { messages: messages.length });
    return messages;
  };

  const reading = read();
  reading.catch(() => undefined);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stalled = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      client.close?.();
      reject(new AppError("inbox_timeout", `mailbox read stalled for ${READ_TIMEOUT_MS / 1000}s`));
    }, READ_TIMEOUT_MS);
  });
  try {
    return await Promise.race([reading, stalled]);
  } finally {
    clearTimeout(timer);
  }
}
