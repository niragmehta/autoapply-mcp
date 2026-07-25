import type { Db } from "../database.js";
import { redact } from "../../text/redact.js";
import { nowIso } from "../../util/hash.js";

/**
 * Append-only audit log. Every gate decision, approval and submission attempt
 * is recorded so a campaign can be reconstructed after the fact.
 */

export function appendEvent(db: Db, type: string, subject: string, payload: Record<string, unknown> = {}): void {
  db.prepare("INSERT INTO events (ts, type, subject, payload) VALUES (?,?,?,?)").run(
    nowIso(),
    type,
    subject,
    redact(JSON.stringify(payload)),
  );
}

export type EventRecord = { id: number; ts: string; type: string; subject: string; payload: string };

export function listEvents(db: Db, type?: string, limit = 100): EventRecord[] {
  const rows = type
    ? db.prepare("SELECT * FROM events WHERE type = ? ORDER BY id DESC LIMIT ?").all(type, limit)
    : db.prepare("SELECT * FROM events ORDER BY id DESC LIMIT ?").all(limit);
  return (rows as Array<Record<string, unknown>>).map((row) => ({
    id: Number(row.id),
    ts: String(row.ts),
    type: String(row.type),
    subject: String(row.subject),
    payload: String(row.payload),
  }));
}
