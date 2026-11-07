import type { Db } from "../database.js";
import { jsonOrDefault } from "../database.js";
import { nowIso } from "../../util/hash.js";

/** Storage for employer replies read from the inbox or pasted in, and the scan checkpoint. */

type Row = Record<string, unknown>;

export const INBOX_STATUSES = ["new", "proposed", "recorded", "dismissed"] as const;
export type InboxStatus = (typeof INBOX_STATUSES)[number];

export type InboxMessageRecord = {
  id: string;
  messageId: string;
  mailbox: string;
  uid: number | null;
  receivedAt: string;
  fromAddress: string;
  fromName: string;
  subject: string;
  snippet: string;
  matchedApplicationId: string | null;
  matchConfidence: number;
  classification: string;
  classConfidence: number;
  evidence: Record<string, unknown>;
  status: InboxStatus;
  processedAt: string | null;
  createdAt: string;
};

function rowToMessage(row: Row): InboxMessageRecord {
  return {
    id: String(row.id),
    messageId: String(row.message_id),
    mailbox: String(row.mailbox ?? ""),
    uid: row.uid === null || row.uid === undefined ? null : Number(row.uid),
    receivedAt: String(row.received_at),
    fromAddress: String(row.from_address ?? ""),
    fromName: String(row.from_name ?? ""),
    subject: String(row.subject ?? ""),
    snippet: String(row.snippet ?? ""),
    matchedApplicationId: row.matched_application_id ? String(row.matched_application_id) : null,
    matchConfidence: Number(row.match_confidence ?? 0),
    classification: String(row.classification ?? "unknown"),
    classConfidence: Number(row.class_confidence ?? 0),
    evidence: jsonOrDefault<Record<string, unknown>>(row.evidence_json, {}),
    status: String(row.status ?? "new") as InboxStatus,
    processedAt: row.processed_at ? String(row.processed_at) : null,
    createdAt: String(row.created_at ?? ""),
  };
}

/**
 * Stores a message once. The Message-ID is the identity, so the same email
 * seen in two folders, or on a second scan, is never stored twice.
 */
export function insertInboxMessage(db: Db, message: InboxMessageRecord): boolean {
  const result = db
    .prepare(
      `INSERT INTO inbox_messages (
        id, message_id, mailbox, uid, received_at, from_address, from_name, subject, snippet,
        matched_application_id, match_confidence, classification, class_confidence, evidence_json,
        status, processed_at, created_at
      ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(message_id) DO NOTHING`,
    )
    .run(
      message.id,
      message.messageId,
      message.mailbox,
      message.uid,
      message.receivedAt,
      message.fromAddress,
      message.fromName,
      message.subject,
      message.snippet,
      message.matchedApplicationId,
      message.matchConfidence,
      message.classification,
      message.classConfidence,
      JSON.stringify(message.evidence),
      message.status,
      message.processedAt,
      message.createdAt || nowIso(),
    );
  return Number(result.changes) > 0;
}

export function getInboxMessage(db: Db, id: string): InboxMessageRecord | null {
  const row = db.prepare("SELECT * FROM inbox_messages WHERE id = ?").get(id) as Row | undefined;
  return row ? rowToMessage(row) : null;
}

export function getInboxMessageByMessageId(db: Db, messageId: string): InboxMessageRecord | null {
  const row = db.prepare("SELECT * FROM inbox_messages WHERE message_id = ?").get(messageId) as Row | undefined;
  return row ? rowToMessage(row) : null;
}

export function listInboxMessages(db: Db, filter: { status?: InboxStatus; limit?: number } = {}): InboxMessageRecord[] {
  const limit = filter.limit ?? 100;
  const rows = filter.status
    ? (db
        .prepare("SELECT * FROM inbox_messages WHERE status = ? ORDER BY received_at DESC LIMIT ?")
        .all(filter.status, limit) as Row[])
    : (db.prepare("SELECT * FROM inbox_messages ORDER BY received_at DESC LIMIT ?").all(limit) as Row[]);
  return rows.map(rowToMessage);
}

export type InboxMessagePatch = {
  status: InboxStatus;
  matchedApplicationId?: string | null;
  matchConfidence?: number;
  classification?: string;
  evidence?: Record<string, unknown>;
};

/** Applies a review decision. Returns the updated record. */
export function updateInboxMessage(db: Db, id: string, patch: InboxMessagePatch): InboxMessageRecord | null {
  const current = getInboxMessage(db, id);
  if (!current) return null;
  const next: InboxMessageRecord = {
    ...current,
    status: patch.status,
    matchedApplicationId:
      patch.matchedApplicationId === undefined ? current.matchedApplicationId : patch.matchedApplicationId,
    matchConfidence: patch.matchConfidence ?? current.matchConfidence,
    classification: patch.classification ?? current.classification,
    evidence: patch.evidence ?? current.evidence,
    processedAt: nowIso(),
  };
  db.prepare(
    `UPDATE inbox_messages SET status = ?, matched_application_id = ?, match_confidence = ?, classification = ?,
       evidence_json = ?, processed_at = ? WHERE id = ?`,
  ).run(
    next.status,
    next.matchedApplicationId,
    next.matchConfidence,
    next.classification,
    JSON.stringify(next.evidence),
    next.processedAt,
    id,
  );
  return next;
}

export type ApplicationReply = {
  applicationId: string;
  classification: string;
  status: InboxStatus;
  receivedAt: string;
};

/** Replies matched to an application and not dismissed, oldest first. */
export function listMatchedReplies(db: Db): ApplicationReply[] {
  const rows = db
    .prepare(
      `SELECT matched_application_id, classification, status, received_at FROM inbox_messages
       WHERE matched_application_id IS NOT NULL AND status != 'dismissed'
       ORDER BY received_at ASC`,
    )
    .all() as Row[];
  return rows.map((row) => ({
    applicationId: String(row.matched_application_id),
    classification: String(row.classification),
    status: String(row.status) as InboxStatus,
    receivedAt: String(row.received_at),
  }));
}

export function countInboxByStatus(db: Db): Record<InboxStatus, number> {
  const rows = db.prepare("SELECT status, COUNT(*) AS total FROM inbox_messages GROUP BY status").all() as Row[];
  const counts: Record<InboxStatus, number> = { new: 0, proposed: 0, recorded: 0, dismissed: 0 };
  for (const row of rows) {
    const status = String(row.status) as InboxStatus;
    if (status in counts) counts[status] = Number(row.total ?? 0);
  }
  return counts;
}

export type InboxCheckpoint = {
  mailbox: string;
  lastUid: number;
  lastDate: string | null;
  uidValidity: string | null;
  updatedAt: string;
};

export function getInboxState(db: Db, mailbox: string): InboxCheckpoint | null {
  const row = db.prepare("SELECT * FROM inbox_state WHERE mailbox = ?").get(mailbox) as Row | undefined;
  if (!row) return null;
  return {
    mailbox: String(row.mailbox),
    lastUid: Number(row.last_uid ?? 0),
    lastDate: row.last_date ? String(row.last_date) : null,
    uidValidity: row.uid_validity ? String(row.uid_validity) : null,
    updatedAt: String(row.updated_at),
  };
}

export function listInboxStates(db: Db): InboxCheckpoint[] {
  const rows = db.prepare("SELECT mailbox FROM inbox_state ORDER BY mailbox").all() as Row[];
  return rows.map((row) => getInboxState(db, String(row.mailbox))).filter((state): state is InboxCheckpoint => state !== null);
}

export function saveInboxState(db: Db, state: Omit<InboxCheckpoint, "updatedAt">): void {
  db.prepare(
    `INSERT INTO inbox_state (mailbox, last_uid, last_date, uid_validity, updated_at) VALUES (?,?,?,?,?)
     ON CONFLICT(mailbox) DO UPDATE SET last_uid = excluded.last_uid, last_date = excluded.last_date,
       uid_validity = excluded.uid_validity, updated_at = excluded.updated_at`,
  ).run(state.mailbox, state.lastUid, state.lastDate, state.uidValidity, nowIso());
}
