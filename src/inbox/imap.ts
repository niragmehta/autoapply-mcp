import { AppError } from "../util/errors.js";
import type { ReplyInboxConfig } from "./config.js";

/**
 * The slice of an IMAP client the reply scanner uses. Read-only by
 * construction: there is no method here to set a flag, move, copy or delete,
 * folders are opened with EXAMINE (readOnly), and imapflow fetches bodies
 * with BODY.PEEK, so reading never marks a message seen.
 *
 * Tests pass their own implementation; the real one is imapflow, loaded on
 * demand because it is an optional dependency.
 */

export type ImapAddress = { name?: string; address?: string };

export type ImapEnvelope = {
  date?: Date;
  subject?: string;
  messageId?: string;
  from?: ImapAddress[];
  sender?: ImapAddress[];
  replyTo?: ImapAddress[];
};

export type ImapMessage = {
  uid?: number;
  envelope?: ImapEnvelope;
  internalDate?: Date | string;
  source?: Buffer;
};

export type ReplyImapClient = {
  on(event: "error", listener: (error: Error & { code?: unknown }) => void): unknown;
  connect(): Promise<void>;
  logout(): Promise<void>;
  /** Drops the connection without a LOGOUT round trip a stalled server would never answer. */
  close?(): void;
  /** The selected folder, once a lock is held. */
  mailbox?: { uidValidity?: bigint | number | string } | false | null;
  getMailboxLock(path: string, options: { readOnly: true }): Promise<{ release(): void }>;
  fetch(range: unknown, query: Record<string, unknown>, options?: { uid?: boolean }): AsyncIterable<ImapMessage>;
};

export type ImapClientFactory = (config: ReplyInboxConfig) => Promise<ReplyImapClient>;

type ImapFlowConstructor = new (options: unknown) => ReplyImapClient;

async function loadImapFlow(): Promise<ImapFlowConstructor> {
  try {
    const mod = (await import("imapflow")) as unknown as { ImapFlow?: ImapFlowConstructor };
    if (!mod.ImapFlow) throw new Error("ImapFlow export missing");
    return mod.ImapFlow;
  } catch (error) {
    throw new AppError(
      "imapflow_missing",
      `reading replies needs the optional imapflow package: npm install imapflow (${String(error).slice(0, 120)})`,
    );
  }
}

export const createImapClient: ImapClientFactory = async (config) => {
  const ImapFlow = await loadImapFlow();
  return new ImapFlow({
    host: config.host,
    port: config.port,
    secure: true,
    auth: { user: config.user, pass: config.password },
    logger: false,
    disableAutoIdle: true,
  });
};
