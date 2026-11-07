import type { SchemaModule } from "../migrate.js";

/**
 * Tailored resume and cover letter documents generated per application.
 *
 * One row per rendered file. The application's resume_path names the file in
 * use; older rows stay as the history of what was generated and why.
 */
export const documentsSchema: SchemaModule = {
  name: "documents",
  sql: `
CREATE TABLE IF NOT EXISTS tailored_documents (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('resume', 'cover-letter')),
  path TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  variant_id TEXT NOT NULL DEFAULT '',
  changes_json TEXT NOT NULL DEFAULT '[]',
  checks_json TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  FOREIGN KEY (application_id) REFERENCES applications(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_tailored_documents_app ON tailored_documents(application_id, kind, created_at);
`,
};
