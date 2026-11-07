import { existsSync } from "node:fs";
import type { Db } from "../../db/database.js";

/**
 * Read model for the Documents page: every open or recent application with
 * the resume it will upload and the state of its cover letter, in one query.
 */

type Row = Record<string, unknown>;

export type DocumentRow = {
  applicationId: string;
  status: string;
  company: string;
  title: string;
  resumeId: string;
  resumeFile: string;
  resumeExists: boolean;
  tailored: boolean;
  tailoredAt: string | null;
  coverLetterWords: number;
  coverLetterPdfAt: string | null;
  documents: number;
};

const LATEST = (kind: string, column: string) =>
  `(SELECT d.${column} FROM tailored_documents d WHERE d.application_id = a.id AND d.kind = '${kind}' ORDER BY d.created_at DESC, d.id DESC LIMIT 1)`;

export function documentRows(db: Db, options: { statuses?: readonly string[]; limit?: number } = {}): DocumentRow[] {
  const limit = Math.min(Math.max(options.limit ?? 100, 1), 500);
  const statuses = options.statuses ?? [];
  const where = statuses.length > 0 ? `WHERE a.status IN (${statuses.map(() => "?").join(", ")})` : "";
  const rows = db
    .prepare(
      `SELECT a.id, a.status, a.resume_id, a.resume_path, a.cover_letter, j.company_name, j.title,
              ${LATEST("resume", "path")} AS tailored_path,
              ${LATEST("resume", "created_at")} AS tailored_at,
              ${LATEST("cover-letter", "created_at")} AS letter_pdf_at,
              (SELECT COUNT(*) FROM tailored_documents d WHERE d.application_id = a.id) AS documents
       FROM applications a JOIN jobs j ON j.id = a.job_id
       ${where}
       ORDER BY a.created_at DESC, a.id DESC
       LIMIT ?`,
    )
    .all(...statuses, limit) as Row[];
  return rows.map((row) => {
    const resumePath = String(row.resume_path ?? "");
    const letter = String(row.cover_letter ?? "").trim();
    return {
      applicationId: String(row.id),
      status: String(row.status),
      company: String(row.company_name),
      title: String(row.title),
      resumeId: String(row.resume_id ?? ""),
      resumeFile: resumePath.split(/[\\/]/).at(-1) ?? "",
      resumeExists: resumePath.length > 0 && existsSync(resumePath),
      tailored: row.tailored_path !== null && row.tailored_path !== undefined && String(row.tailored_path) === resumePath,
      tailoredAt: row.tailored_at ? String(row.tailored_at) : null,
      coverLetterWords: letter.length > 0 ? letter.split(/\s+/).length : 0,
      coverLetterPdfAt: row.letter_pdf_at ? String(row.letter_pdf_at) : null,
      documents: Number(row.documents ?? 0),
    };
  });
}

/** The stored path of one tailored document, for serving its PDF. */
export function tailoredDocumentFile(db: Db, id: string): { applicationId: string; kind: string; path: string } | null {
  const row = db.prepare("SELECT application_id, kind, path FROM tailored_documents WHERE id = ?").get(id) as Row | undefined;
  return row ? { applicationId: String(row.application_id), kind: String(row.kind), path: String(row.path) } : null;
}
