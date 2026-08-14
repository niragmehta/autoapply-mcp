/**
 * Reads the one-time code a board emails before it will accept a submission.
 *
 * Greenhouse gates submission behind a code sent to the candidate's address.
 * The code is bound to the submit that requested it, so a person has to read an
 * inbox mid-run while the browser holds the gate open. Pointing the server at a
 * mailbox that receives *only* forwarded verification mail closes that loop
 * without handing it the candidate's real inbox.
 *
 * Configuration is environment-only and absent by default: with nothing set,
 * this module reports "not configured" and the manual file hand-off is
 * unchanged.
 */
import { logger } from "../util/logger.js";

export type VerificationInboxConfig = {
  host: string;
  port: number;
  user: string;
  password: string;
  /** Only messages from a sender containing this text are considered. */
  from?: string;
  mailbox: string;
};

/**
 * Builds the inbox config from the environment, or returns null when the
 * feature has not been switched on. Credentials are never read from
 * `campaign.json` or `profile.json`: those files are edited by hand, shared in
 * previews and backed up, and a password does not belong in any of them.
 */
export function readVerificationInboxConfig(
  env: Record<string, string | undefined> = process.env,
): VerificationInboxConfig | null {
  const user = env.AUTOAPPLY_OTP_IMAP_USER?.trim();
  const password = env.AUTOAPPLY_OTP_IMAP_PASSWORD?.trim();
  if (!user || !password) return null;
  const port = Number(env.AUTOAPPLY_OTP_IMAP_PORT ?? 993);
  return {
    host: env.AUTOAPPLY_OTP_IMAP_HOST?.trim() || "imap.gmail.com",
    port: Number.isFinite(port) && port > 0 ? port : 993,
    user,
    password,
    from: env.AUTOAPPLY_OTP_FROM?.trim() || undefined,
    mailbox: env.AUTOAPPLY_OTP_MAILBOX?.trim() || "INBOX",
  };
}

/**
 * Observed Greenhouse codes: eight alphanumerics carrying both cases, such as
 * `dkgqL1KS`, `pvlqH9IO` and `ZUvwsFBq`. A digit is not guaranteed, so case
 * mixing is the only reliable signature - and it is what separates a code from
 * an ordinary word like `resubmit`, which sits one sentence away from the real
 * code in Greenhouse's own email.
 */
function looksLikeCode(token: string): boolean {
  if (NOT_A_CODE.test(token)) return false;
  if (/^\d{4,12}$/.test(token)) return true;
  if (!/^[A-Za-z0-9]{6,12}$/.test(token)) return false;
  if (!/[a-z]/.test(token)) return false;
  return (token.match(/[A-Z]/g) ?? []).length >= 2;
}

/** Words that share the code's shape but are never the code. */
const NOT_A_CODE = /^(LinkedIn|Greenhouse|Facebook|Snapchat|WhatsApp|Telegram)$/i;

/**
 * Pulls the code out of an email body.
 *
 * Returns null rather than guessing when the body yields more than one distinct
 * candidate. Entering a wrong code is not a free retry: the board rejects it and
 * emails a fresh one, which invalidates the code this run is waiting for. Doing
 * nothing leaves the manual hand-off available and costs only the wait.
 */
export function extractVerificationCode(body: string): string | null {
  if (!body) return null;
  const labelled = labelledCandidates(body);
  const candidates = labelled.length > 0 ? labelled : shapedCandidates(body);
  const distinct = [...new Set(candidates)];
  return distinct.length === 1 ? (distinct[0] ?? null) : null;
}

/**
 * Greenhouse presents the code after a colon: "Copy and paste this code into
 * the security code field on your application: dkgqL1KS".
 *
 * The colon is what makes this reliable. Taking whatever follows the word
 * "code" instead picks up "After you enter the code, resubmit your
 * application" and offers `resubmit` as the code.
 */
const LABELLED_CODE = /\bcode\b[^:\r\n]{0,80}:\s*([A-Za-z0-9]{4,12})\b/gi;

function labelledCandidates(body: string): string[] {
  return [...body.matchAll(LABELLED_CODE)].map((match) => match[1] ?? "").filter(looksLikeCode);
}

function shapedCandidates(body: string): string[] {
  return [...body.matchAll(/\b[A-Za-z0-9]{6,12}\b/g)].map((match) => match[0]).filter(looksLikeCode);
}

type ImapMessage = { receivedAt: Date; body: string };

/**
 * How far before the submit click an email may be dated and still be believed.
 *
 * IMAP reports arrival to the second, so a message that actually arrived at
 * 07:23:11.800 is dated 07:23:11.000 - up to a second earlier than the click it
 * answers. A few seconds also absorbs clock skew between this machine and the
 * mail server. It stays far short of the minutes an attempt takes, so a code
 * from a previous attempt still cannot be mistaken for this one's.
 */
const CLOCK_TOLERANCE_MS = 5_000;

/**
 * Fetches the newest verification code emailed after `since`.
 *
 * `since` is the moment this run clicked submit. A code that arrived before it
 * belongs to an earlier attempt and is already dead, so using it would burn this
 * attempt as surely as a typo would.
 */
export async function fetchVerificationCode(
  config: VerificationInboxConfig,
  since: Date,
  fetchMessages: (config: VerificationInboxConfig, since: Date) => Promise<ImapMessage[]> = readMailbox,
): Promise<string | null> {
  const messages = await fetchMessages(config, since);
  const floor = since.getTime() - CLOCK_TOLERANCE_MS;
  const fresh = messages
    .filter((message) => message.receivedAt.getTime() >= floor)
    .sort((a, b) => b.receivedAt.getTime() - a.receivedAt.getTime());
  for (const message of fresh) {
    const code = extractVerificationCode(message.body);
    if (code) return code;
  }
  return null;
}

/**
 * Loaded on demand so the package installs and runs without an IMAP client for
 * everyone who never turns this on.
 */
async function loadImapFlow(): Promise<new (options: unknown) => ImapFlowLike> {
  try {
    const mod = (await import("imapflow")) as { ImapFlow?: new (options: unknown) => ImapFlowLike };
    if (!mod.ImapFlow) throw new Error("ImapFlow export missing");
    return mod.ImapFlow;
  } catch (error) {
    throw new Error(
      `verification inbox configured but the imapflow package is not installed: ${String(error)}. Run npm install imapflow.`,
    );
  }
}

type ImapFlowLike = {
  connect: () => Promise<void>;
  logout: () => Promise<void>;
  getMailboxLock: (mailbox: string) => Promise<{ release: () => void }>;
  fetch: (
    range: unknown,
    query: unknown,
  ) => AsyncIterable<{ envelope?: { date?: Date; from?: Array<{ address?: string }> }; source?: Buffer }>;
};

async function readMailbox(config: VerificationInboxConfig, since: Date): Promise<ImapMessage[]> {
  const ImapFlow = await loadImapFlow();
  const client = new ImapFlow({
    host: config.host,
    port: config.port,
    secure: true,
    auth: { user: config.user, pass: config.password },
    logger: false,
  });
  const messages: ImapMessage[] = [];
  await client.connect();
  try {
    const lock = await client.getMailboxLock(config.mailbox);
    try {
      for await (const message of client.fetch({ since }, { envelope: true, source: true })) {
        const sender = message.envelope?.from?.[0]?.address ?? "";
        if (config.from && !sender.toLowerCase().includes(config.from.toLowerCase())) continue;
        messages.push({
          receivedAt: message.envelope?.date ?? new Date(0),
          body: decodeMessageText(message.source),
        });
      }
    } finally {
      lock.release();
    }
  } finally {
    await client.logout().catch(() => undefined);
  }
  // The body is never logged: it is an email belonging to the candidate, and the
  // code itself is a credential for this submission.
  logger.info("verification inbox read", { messages: messages.length });
  return messages;
}

/**
 * Turns a raw message into searchable text. Quoted-printable is undone first
 * because it inserts soft line breaks that can fall in the middle of a code.
 *
 * Headers, stylesheets and link targets are then removed. A Greenhouse code
 * email carries some fifty mixed-case tracking hashes inside its URLs, every
 * one of them shaped exactly like a code, so leaving them in would make the
 * real code impossible to pick out.
 */
export function decodeMessageText(source: Buffer | undefined): string {
  if (!source) return "";
  const raw = source.toString("utf8");
  const unfolded = raw.replace(/=\r?\n/g, "");
  const decoded = unfolded.replace(/=([0-9A-F]{2})/g, (_match, hex: string) =>
    String.fromCharCode(Number.parseInt(hex, 16)),
  );
  return decoded
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<head[\s\S]*?<\/head>/gi, " ")
    // RFC822 and MIME headers. A body sentence never starts with a single
    // unspaced word followed by a colon, so this cannot eat the code line.
    .replace(/^[A-Za-z][A-Za-z0-9-]*:[ \t].*$/gm, " ")
    .replace(/https?:\/\/\S+/gi, " ")
    .replace(/<[^>]+>/g, " ");
}
