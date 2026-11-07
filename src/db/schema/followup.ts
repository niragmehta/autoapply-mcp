import { ensureColumn, type SchemaModule } from "../migrate.js";

/**
 * Inbox replies, follow-up reminders and outcome proposals.
 *
 * inbox_messages keeps what is needed to review a reply and nothing more: the
 * envelope, a short snippet and the classifier's evidence. Full bodies are
 * read in memory during a scan and never written down.
 */
export const followupSchema: SchemaModule = {
  name: "followup",
  sql: `
CREATE TABLE IF NOT EXISTS inbox_messages (
  id TEXT PRIMARY KEY,
  message_id TEXT NOT NULL UNIQUE,
  mailbox TEXT NOT NULL DEFAULT '',
  uid INTEGER,
  received_at TEXT NOT NULL,
  from_address TEXT NOT NULL DEFAULT '',
  from_name TEXT NOT NULL DEFAULT '',
  subject TEXT NOT NULL DEFAULT '',
  snippet TEXT NOT NULL DEFAULT '',
  matched_application_id TEXT,
  match_confidence REAL NOT NULL DEFAULT 0,
  classification TEXT NOT NULL DEFAULT 'unknown',
  class_confidence REAL NOT NULL DEFAULT 0,
  evidence_json TEXT NOT NULL DEFAULT '{}',
  status TEXT NOT NULL DEFAULT 'new',
  processed_at TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_inbox_status ON inbox_messages(status, received_at);
CREATE INDEX IF NOT EXISTS idx_inbox_application ON inbox_messages(matched_application_id);

CREATE TABLE IF NOT EXISTS inbox_state (
  mailbox TEXT PRIMARY KEY,
  last_uid INTEGER NOT NULL DEFAULT 0,
  last_date TEXT,
  uid_validity TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS followups (
  application_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  due_at TEXT NOT NULL,
  done_at TEXT,
  snoozed_until TEXT,
  note TEXT NOT NULL DEFAULT '',
  skipped INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (application_id, kind)
);
`,
  // A reminder resolved without sending anything; databases created before it get the column added.
  migrate: (db) => {
    ensureColumn(db, "followups", "skipped", "INTEGER NOT NULL DEFAULT 0");
  },
};
