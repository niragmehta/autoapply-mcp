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

export function getCompanyNoteRecord(db: Db, id: string): CompanyNote | null {
  const row = db.prepare("SELECT * FROM company_notes WHERE id = ?").get(id) as Row | undefined;
  return row ? rowToNote(row) : null;
}

/** Rewrites a note's company, kind, text and sources; it keeps its id and creation time. */
export function updateCompanyNoteRecord(db: Db, note: CompanyNote): void {
  db.prepare("UPDATE company_notes SET company = ?, kind = ?, content = ?, sources_json = ? WHERE id = ?").run(
    note.company,
    note.kind,
    note.content,
    JSON.stringify(note.sources),
    note.id,
  );
}

export function deleteCompanyNoteRecord(db: Db, id: string): boolean {
  return Number(db.prepare("DELETE FROM company_notes WHERE id = ?").run(id).changes) > 0;
}
