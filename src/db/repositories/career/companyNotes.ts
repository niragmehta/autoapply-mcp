import type { Db } from "../../database.js";
import type { CompanyNote, NoteKind } from "../../../career/types.js";
import { limitOf, stringArray, text, type Row } from "./rows.js";

/** Storage for company research notes, matched on company name case-insensitively. */

function rowToNote(row: Row): CompanyNote {
  return {
    id: text(row.id),
    company: text(row.company),
    kind: text(row.kind) as NoteKind,
    content: text(row.content),
    sources: stringArray(row.sources_json),
    createdAt: text(row.created_at),
  };
}

export function insertCompanyNoteRecord(db: Db, note: CompanyNote): void {
  db.prepare("INSERT INTO company_notes (id, company, kind, content, sources_json, created_at) VALUES (?,?,?,?,?,?)").run(
    note.id,
    note.company,
    note.kind,
    note.content,
    JSON.stringify(note.sources),
    note.createdAt,
  );
}

/** Notes for one company, newest first. */
export function listCompanyNoteRecords(db: Db, company: string, kind?: NoteKind, limit?: number): CompanyNote[] {
  const rows = kind
    ? (db
        .prepare(
          "SELECT * FROM company_notes WHERE company = ? COLLATE NOCASE AND kind = ? ORDER BY created_at DESC, id DESC LIMIT ?",
        )
        .all(company.trim(), kind, limitOf(limit, 50)) as Row[])
    : (db
        .prepare("SELECT * FROM company_notes WHERE company = ? COLLATE NOCASE ORDER BY created_at DESC, id DESC LIMIT ?")
        .all(company.trim(), limitOf(limit, 50)) as Row[]);
  return rows.map(rowToNote);
}
