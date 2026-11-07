import type { Db } from "../../database.js";
import type { Contact, ContactKind } from "../../../career/types.js";
import { limitOf, text, type Row } from "./rows.js";

/** Storage for publicly found contacts. */

function rowToContact(row: Row): Contact {
  return {
    id: text(row.id),
    company: text(row.company),
    name: text(row.name),
    role: text(row.role),
    kind: text(row.kind) as ContactKind,
    profileUrl: text(row.profile_url),
    email: text(row.email),
    notes: text(row.notes),
    source: text(row.source),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  };
}

/** Inserts a contact, or replaces every field but `created_at` of an existing one. */
export function saveContactRecord(db: Db, contact: Contact): void {
  db.prepare(`
    INSERT INTO contacts (
      id, company, name, role, kind, profile_url, email, notes, source, created_at, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      company = excluded.company,
      name = excluded.name,
      role = excluded.role,
      kind = excluded.kind,
      profile_url = excluded.profile_url,
      email = excluded.email,
      notes = excluded.notes,
      source = excluded.source,
      updated_at = excluded.updated_at
  `).run(
    contact.id,
    contact.company,
    contact.name,
    contact.role,
    contact.kind,
    contact.profileUrl,
    contact.email,
    contact.notes,
    contact.source,
    contact.createdAt,
    contact.updatedAt,
  );
}

export function getContact(db: Db, id: string): Contact | null {
  const row = db.prepare("SELECT * FROM contacts WHERE id = ?").get(id) as Row | undefined;
  return row ? rowToContact(row) : null;
}

/** The contact with this name at this company, ignoring case. */
export function findContactByName(db: Db, company: string, name: string): Contact | null {
  const row = db
    .prepare("SELECT * FROM contacts WHERE company = ? COLLATE NOCASE AND name = ? COLLATE NOCASE LIMIT 1")
    .get(company.trim(), name.trim()) as Row | undefined;
  return row ? rowToContact(row) : null;
}

export type ContactFilter = { company?: string; kind?: ContactKind; limit?: number };

export function listContactRecords(db: Db, filter: ContactFilter = {}): Contact[] {
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (filter.company) {
    clauses.push("company = ? COLLATE NOCASE");
    params.push(filter.company.trim());
  }
  if (filter.kind) {
    clauses.push("kind = ?");
    params.push(filter.kind);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db
    .prepare(`SELECT * FROM contacts ${where} ORDER BY company COLLATE NOCASE, name COLLATE NOCASE LIMIT ?`)
    .all(...params, limitOf(filter.limit, 200)) as Row[];
  return rows.map(rowToContact);
}

/** Contacts named on any outreach draft for an application. */
export function contactIdsForApplication(db: Db, applicationId: string): string[] {
  const rows = db
    .prepare("SELECT DISTINCT contact_id FROM outreach_drafts WHERE application_id = ? AND contact_id IS NOT NULL")
    .all(applicationId) as Row[];
  return rows.map((row) => text(row.contact_id)).filter((id) => id.length > 0);
}

/** Removes a contact. Outreach drafts addressed to it keep their company; the foreign key clears their contact link. */
export function deleteContactRecord(db: Db, id: string): boolean {
  return Number(db.prepare("DELETE FROM contacts WHERE id = ?").run(id).changes) > 0;
}
