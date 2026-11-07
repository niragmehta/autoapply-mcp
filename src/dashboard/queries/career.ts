import type { Db } from "../../db/database.js";
import { jsonOrDefault } from "../../db/database.js";
import type { CompanyNote, NoteKind } from "../../career/types.js";

/**
 * Read-only views over the career tables that the career services do not
 * offer: research notes across every company, newest first.
 */

type Row = Record<string, unknown>;

export function listRecentCompanyNotes(db: Db, options: { kind?: NoteKind; limit?: number } = {}): CompanyNote[] {
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
  const rows = (
    options.kind
      ? db.prepare("SELECT * FROM company_notes WHERE kind = ? ORDER BY created_at DESC, id DESC LIMIT ?").all(options.kind, limit)
      : db.prepare("SELECT * FROM company_notes ORDER BY created_at DESC, id DESC LIMIT ?").all(limit)
  ) as Row[];
  return rows.map((row) => ({
    id: String(row.id),
    company: String(row.company),
    kind: String(row.kind) as NoteKind,
    content: String(row.content ?? ""),
    sources: jsonOrDefault<string[]>(row.sources_json, []),
    createdAt: String(row.created_at),
  }));
}
