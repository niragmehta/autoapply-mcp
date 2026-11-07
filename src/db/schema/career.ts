import type { SchemaModule } from "../migrate.js";

/**
 * Story bank, interviews, company research, contacts, outreach drafts and offers.
 *
 * `application_id` columns are soft references validated by the career
 * services rather than foreign keys: a cascade from a pruned job or
 * application must never silently erase interview history or an offer.
 */
export const careerSchema: SchemaModule = {
  name: "career",
  sql: `
CREATE TABLE IF NOT EXISTS stories (
  id TEXT PRIMARY KEY,
  title TEXT NOT NULL,
  situation TEXT NOT NULL DEFAULT '',
  task TEXT NOT NULL DEFAULT '',
  action TEXT NOT NULL,
  result TEXT NOT NULL DEFAULT '',
  reflection TEXT NOT NULL DEFAULT '',
  skills_json TEXT NOT NULL DEFAULT '[]',
  fact_ids_json TEXT NOT NULL DEFAULT '[]',
  tags_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS interviews (
  id TEXT PRIMARY KEY,
  application_id TEXT NOT NULL,
  stage TEXT NOT NULL,
  scheduled_at TEXT,
  duration_minutes INTEGER,
  format TEXT NOT NULL DEFAULT '',
  location_or_link TEXT NOT NULL DEFAULT '',
  interviewers_json TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'scheduled',
  notes TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_interviews_application ON interviews(application_id, scheduled_at);
CREATE INDEX IF NOT EXISTS idx_interviews_status ON interviews(status, scheduled_at);

CREATE TABLE IF NOT EXISTS interview_sessions (
  id TEXT PRIMARY KEY,
  interview_id TEXT,
  application_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (interview_id) REFERENCES interviews(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_interview_sessions_application ON interview_sessions(application_id, created_at);

CREATE TABLE IF NOT EXISTS company_notes (
  id TEXT PRIMARY KEY,
  company TEXT NOT NULL,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  sources_json TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_company_notes_company ON company_notes(company COLLATE NOCASE, created_at);

CREATE TABLE IF NOT EXISTS contacts (
  id TEXT PRIMARY KEY,
  company TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL,
  profile_url TEXT NOT NULL DEFAULT '',
  email TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_contacts_company ON contacts(company COLLATE NOCASE, name COLLATE NOCASE);

CREATE TABLE IF NOT EXISTS outreach_drafts (
  id TEXT PRIMARY KEY,
  application_id TEXT,
  contact_id TEXT,
  company TEXT NOT NULL,
  channel TEXT NOT NULL,
  subject TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS idx_outreach_application ON outreach_drafts(application_id, created_at);
CREATE INDEX IF NOT EXISTS idx_outreach_company ON outreach_drafts(company COLLATE NOCASE, created_at);

CREATE TABLE IF NOT EXISTS offers (
  id TEXT PRIMARY KEY,
  application_id TEXT,
  company TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  level TEXT NOT NULL DEFAULT '',
  currency TEXT NOT NULL,
  base REAL NOT NULL,
  bonus_target_amount REAL,
  bonus_target_pct REAL,
  equity_value_annual REAL,
  equity_details TEXT NOT NULL DEFAULT '',
  sign_on REAL,
  relocation REAL,
  benefits_notes TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  remote_policy TEXT NOT NULL DEFAULT '',
  start_date TEXT,
  deadline TEXT,
  status TEXT NOT NULL DEFAULT 'received',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_offers_application ON offers(application_id);
CREATE INDEX IF NOT EXISTS idx_offers_status ON offers(status, created_at);
`,
};
