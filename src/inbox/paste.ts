import type { Db } from "../db/database.js";
import { getApplication } from "../db/repositories/applications.js";
import type { OutcomeKind } from "../domain/policies/followup.js";
import { AppError } from "../util/errors.js";
import { shortHash } from "../util/hash.js";
import type { IncomingReply } from "./analysis.js";
import { loadApplicationIndex } from "./companies.js";
import { stripQuotedReply } from "./mime.js";
import { getReplyView, processReply, type ReplyView } from "./process.js";

/**
 * The no-mailbox path: a person pastes a reply and gets the same
 * classification, match and proposal a scanned one would. Nothing is
 * recorded until they confirm it with confirm_reply.
 */

export type PastedReplyInput = {
  text: string;
  subject?: string;
  from?: string;
  applicationId?: string;
};

export type ParsedPaste = { subject: string; fromAddress: string; fromName: string; receivedAt: Date | null; body: string };

const HEADER_LINE = /^(subject|from|date|sent|to|cc|reply-to):\s*(.*)$/i;

/** Splits `Name <a@b.com>`, `a@b.com` or a bare name. */
export function parseSender(raw: string): { address: string; name: string } {
  const trimmed = raw.trim();
  const angle = /^(.*?)<([^>]+)>\s*$/.exec(trimmed);
  if (angle) return { name: (angle[1] ?? "").trim().replace(/^"|"$/g, ""), address: (angle[2] ?? "").trim() };
  return /^\S+@\S+$/.test(trimmed) ? { name: "", address: trimmed } : { name: trimmed, address: "" };
}

/** Reads optional Subject/From/Date lines at the top of pasted text; the rest is the body. */
export function parsePastedReply(input: PastedReplyInput): ParsedPaste {
  const lines = input.text.replace(/\r\n?/g, "\n").split("\n");
  const headers = new Map<string, string>();
  let index = 0;
  while (index < lines.length) {
    const match = HEADER_LINE.exec(lines[index] ?? "");
    if (!match) break;
    headers.set(match[1]!.toLowerCase(), (match[2] ?? "").trim());
    index += 1;
  }
  const sender = parseSender(input.from ?? headers.get("from") ?? "");
  const dated = Date.parse(headers.get("date") ?? headers.get("sent") ?? "");
  return {
    subject: (input.subject ?? headers.get("subject") ?? "").trim(),
    fromAddress: sender.address,
    fromName: sender.name,
    receivedAt: Number.isFinite(dated) ? new Date(dated) : null,
    body: lines.slice(index).join("\n").trim(),
  };
}

export type PastedReplyResult = {
  replyId: string | null;
  duplicate: boolean;
  reply: ReplyView | null;
  proposal: {
    action: string;
    kind: string;
    applicationId: string | null;
    reasons: string[];
    nextStep: string;
  };
};

export function classifyReplyText(
  db: Db,
  input: PastedReplyInput,
  options: { autoRecord: readonly OutcomeKind[]; now?: Date },
): PastedReplyResult {
  const parsed = parsePastedReply(input);
  if (parsed.body.length === 0 && parsed.subject.length === 0) {
    throw new AppError("reply_text_required", "paste the reply's text (and its subject, if you have it)");
  }
  if (input.applicationId && !getApplication(db, input.applicationId)) {
    throw new AppError("application_not_found", `no application ${input.applicationId}`);
  }
  const reply: IncomingReply = {
    messageId: `pasted:${shortHash(`${parsed.subject}\n${parsed.fromAddress}\n${parsed.body}`, 32)}`,
    mailbox: "pasted",
    uid: null,
    receivedAt: parsed.receivedAt ?? options.now ?? new Date(),
    fromAddress: parsed.fromAddress,
    fromName: parsed.fromName,
    replyTo: [],
    subject: parsed.subject,
    text: stripQuotedReply(parsed.body),
    filterReason: "pasted",
  };
  const processed = processReply(db, reply, loadApplicationIndex(db), {
    autoRecord: options.autoRecord,
    allowAutoRecord: false,
    namedApplicationId: input.applicationId,
  });
  const nextStep =
    processed.action === "dismiss"
      ? "Reads as noise and was set aside. If it is a real reply, confirm_reply with kind (and applicationId) records it."
      : processed.applicationId
        ? `Confirm with confirm_reply {replyId: "${processed.replyId}"} once the candidate agrees, or pass kind to correct it.`
        : `Pick the application, then confirm_reply {replyId: "${processed.replyId}", applicationId, kind}.`;
  return {
    replyId: processed.replyId,
    duplicate: processed.duplicate,
    reply: processed.replyId ? getReplyView(db, processed.replyId) : null,
    proposal: {
      action: processed.action,
      kind: processed.kind,
      applicationId: processed.applicationId,
      reasons: processed.reasons,
      nextStep,
    },
  };
}
