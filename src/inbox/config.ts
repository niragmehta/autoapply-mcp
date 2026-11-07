import { existsSync, readFileSync } from "node:fs";
import { parseSecrets } from "../config/secrets.js";
import { readVerificationInboxConfig } from "../submission/verificationInbox.js";

/**
 * Where employer replies are read from.
 *
 * By default this is the same mailbox the verification-code reader uses
 * (AUTOAPPLY_OTP_IMAP_*), which already receives forwarded hiring mail. A
 * separate mailbox can be named with AUTOAPPLY_INBOX_IMAP_*; its user and
 * password are taken as a pair and never mixed with the verification
 * mailbox's. HOST, PORT and MAILBOX override individually.
 */

export type ReplyInboxConfig = {
  host: string;
  port: number;
  user: string;
  password: string;
  mailboxes: string[];
  /** Which variables supplied the credentials, for status messages. Never the values. */
  credentialSource: "AUTOAPPLY_INBOX_IMAP" | "AUTOAPPLY_OTP_IMAP";
};

type Env = Record<string, string | undefined>;

const present = (value: string | undefined): string | undefined => {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
};

export function readReplyInboxConfig(env: Env = process.env): ReplyInboxConfig | null {
  const ownUser = present(env.AUTOAPPLY_INBOX_IMAP_USER);
  const ownPassword = present(env.AUTOAPPLY_INBOX_IMAP_PASSWORD);
  const separate = ownUser !== undefined || ownPassword !== undefined;
  if (separate && (!ownUser || !ownPassword)) return null;
  const base = readVerificationInboxConfig({
    AUTOAPPLY_OTP_IMAP_USER: separate ? ownUser : env.AUTOAPPLY_OTP_IMAP_USER,
    AUTOAPPLY_OTP_IMAP_PASSWORD: separate ? ownPassword : env.AUTOAPPLY_OTP_IMAP_PASSWORD,
    AUTOAPPLY_OTP_IMAP_HOST: present(env.AUTOAPPLY_INBOX_IMAP_HOST) ?? env.AUTOAPPLY_OTP_IMAP_HOST,
    AUTOAPPLY_OTP_IMAP_PORT: present(env.AUTOAPPLY_INBOX_IMAP_PORT) ?? env.AUTOAPPLY_OTP_IMAP_PORT,
    AUTOAPPLY_OTP_MAILBOX: present(env.AUTOAPPLY_INBOX_IMAP_MAILBOX) ?? env.AUTOAPPLY_OTP_MAILBOX,
  });
  if (!base) return null;
  return {
    host: base.host,
    port: base.port,
    user: base.user,
    password: base.password,
    mailboxes: base.mailboxes,
    credentialSource: separate ? "AUTOAPPLY_INBOX_IMAP" : "AUTOAPPLY_OTP_IMAP",
  };
}

/**
 * The environment with the workspace secrets file underneath it. Read rather
 * than loaded: a scan must not leave credentials in the server's process.env.
 */
export function inboxEnvironment(secretsPath: string, env: Env = process.env): Env {
  if (!existsSync(secretsPath)) return env;
  let fromFile: Record<string, string> = {};
  try {
    fromFile = parseSecrets(readFileSync(secretsPath, "utf8"));
  } catch {
    return env;
  }
  const merged: Env = { ...fromFile };
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined && value !== "") merged[key] = value;
  }
  return merged;
}
