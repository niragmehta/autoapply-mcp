import type { Db } from "../../database.js";
import type { OutreachChannel, OutreachDraft, OutreachStatus } from "../../../career/types.js";
import { limitOf, text, textOrNull, type Row } from "./rows.js";

/** Storage for outreach drafts. A draft is only ever sent by the candidate, outside this server. */

function rowToDraft(row: Row): OutreachDraft {
  return {
    id: text(row.id),
    applicationId: textOrNull(row.application_id),
    contactId: textOrNull(row.contact_id),
    company: text(row.company),
    channel: text(row.channel) as OutreachChannel,
    subject: text(row.subject),
    body: text(row.body),
    status: text(row.status) as OutreachStatus,
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  };
}

export function insertOutreachDraftRecord(db: Db, draft: OutreachDraft): void {
  db.prepare(`
    INSERT INTO outreach_drafts (
      id, application_id, contact_id, company, channel, subject, body, status, created_at, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?)
  `).run(
    draft.id,
    draft.applicationId,
    draft.contactId,
    draft.company,
    draft.channel,
    draft.subject,
    draft.body,
    draft.status,
    draft.createdAt,
    draft.updatedAt,
  );
}

export function getOutreachDraft(db: Db, id: string): OutreachDraft | null {
  const row = db.prepare("SELECT * FROM outreach_drafts WHERE id = ?").get(id) as Row | undefined;
  return row ? rowToDraft(row) : null;
}

export function setOutreachStatusRecord(db: Db, id: string, status: OutreachStatus, updatedAt: string): void {
  db.prepare("UPDATE outreach_drafts SET status = ?, updated_at = ? WHERE id = ?").run(status, updatedAt, id);
}

export type OutreachFilter = {
  applicationId?: string;
  contactId?: string;
  company?: string;
  status?: OutreachStatus;
  channel?: OutreachChannel;
  limit?: number;
};

/** Drafts newest first. */
export function listOutreachDraftRecords(db: Db, filter: OutreachFilter = {}): OutreachDraft[] {
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (filter.applicationId) {
    clauses.push("application_id = ?");
    params.push(filter.applicationId);
  }
  if (filter.contactId) {
    clauses.push("contact_id = ?");
    params.push(filter.contactId);
  }
  if (filter.company) {
    clauses.push("company = ? COLLATE NOCASE");
    params.push(filter.company.trim());
  }
  if (filter.status) {
    clauses.push("status = ?");
    params.push(filter.status);
  }
  if (filter.channel) {
    clauses.push("channel = ?");
    params.push(filter.channel);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db
    .prepare(`SELECT * FROM outreach_drafts ${where} ORDER BY created_at DESC, id DESC LIMIT ?`)
    .all(...params, limitOf(filter.limit, 100)) as Row[];
  return rows.map(rowToDraft);
}
