import type { Db } from "../database.js";
import { jsonOrDefault } from "../database.js";
import { newId, nowIso } from "../../util/hash.js";

/** Rendered resume and cover letter files, one row per file. */

export type TailoredDocumentKind = "resume" | "cover-letter";

export type TailoredDocument = {
  id: string;
  applicationId: string;
  kind: TailoredDocumentKind;
  path: string;
  sha256: string;
  variantId: string;
  changes: unknown[];
  checks: Record<string, unknown>;
  createdAt: string;
};

export type NewTailoredDocument = Omit<TailoredDocument, "id" | "createdAt"> & { id?: string; createdAt?: string };

type Row = Record<string, unknown>;

function rowToDocument(row: Row): TailoredDocument {
  return {
    id: String(row.id),
    applicationId: String(row.application_id),
    kind: String(row.kind) as TailoredDocumentKind,
    path: String(row.path),
    sha256: String(row.sha256),
    variantId: String(row.variant_id ?? ""),
    changes: jsonOrDefault<unknown[]>(row.changes_json, []),
    checks: jsonOrDefault<Record<string, unknown>>(row.checks_json, {}),
    createdAt: String(row.created_at),
  };
}

export function insertTailoredDocument(db: Db, input: NewTailoredDocument): TailoredDocument {
  const document: TailoredDocument = { ...input, id: input.id ?? newId("doc"), createdAt: input.createdAt ?? nowIso() };
  db.prepare(
    `INSERT INTO tailored_documents (id, application_id, kind, path, sha256, variant_id, changes_json, checks_json, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(
    document.id,
    document.applicationId,
    document.kind,
    document.path,
    document.sha256,
    document.variantId,
    JSON.stringify(document.changes),
    JSON.stringify(document.checks),
    document.createdAt,
  );
  return document;
}

/** Documents for an application, newest first, optionally of one kind. */
export function listTailoredDocuments(db: Db, applicationId: string, kind?: TailoredDocumentKind): TailoredDocument[] {
  // rowid breaks ties between rows written within the same millisecond.
  const rows = kind
    ? db
        .prepare("SELECT * FROM tailored_documents WHERE application_id = ? AND kind = ? ORDER BY created_at DESC, rowid DESC")
        .all(applicationId, kind)
    : db.prepare("SELECT * FROM tailored_documents WHERE application_id = ? ORDER BY created_at DESC, rowid DESC").all(applicationId);
  return (rows as Row[]).map(rowToDocument);
}

export function latestTailoredDocument(db: Db, applicationId: string, kind: TailoredDocumentKind): TailoredDocument | null {
  return listTailoredDocuments(db, applicationId, kind)[0] ?? null;
}
