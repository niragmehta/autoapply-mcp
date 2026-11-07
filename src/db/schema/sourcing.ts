import type { SchemaModule } from "../migrate.js";

/**
 * Job leads from alerts, aggregators and company-discovery feeds, plus the
 * boards harvested from the Common Crawl index.
 *
 * A lead is evidence that a company is hiring, not a posting: it is never
 * gated, scored or submitted. It exists so a company can be resolved to a
 * board the pipeline can read. `UNIQUE(source, source_id)` makes re-importing
 * the same alert or feed a no-op.
 *
 * Harvested boards are compared case-insensitively because Common Crawl sees
 * the same slug in several casings, and Ashby slugs are case-sensitive in the
 * URL but identify one board.
 */
export const sourcingSchema: SchemaModule = {
  name: "sourcing",
  sql: `
CREATE TABLE IF NOT EXISTS leads (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  source_id TEXT NOT NULL,
  title TEXT NOT NULL DEFAULT '',
  company TEXT NOT NULL DEFAULT '',
  location TEXT NOT NULL DEFAULT '',
  url TEXT NOT NULL DEFAULT '',
  apply_url TEXT NOT NULL DEFAULT '',
  found_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'new',
  resolved_board TEXT NOT NULL DEFAULT '',
  notes TEXT NOT NULL DEFAULT '',
  published_at TEXT,
  details_json TEXT NOT NULL DEFAULT '{}',
  checked_at TEXT,
  UNIQUE (source, source_id)
);
CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status, source);
CREATE INDEX IF NOT EXISTS idx_leads_company ON leads(company);

CREATE TABLE IF NOT EXISTS harvested_boards (
  ats TEXT NOT NULL,
  board TEXT NOT NULL COLLATE NOCASE,
  region TEXT NOT NULL DEFAULT 'global',
  first_seen TEXT NOT NULL,
  last_scanned TEXT,
  postings INTEGER,
  matching INTEGER,
  status TEXT NOT NULL DEFAULT 'new',
  hits INTEGER NOT NULL DEFAULT 0,
  company TEXT NOT NULL DEFAULT '',
  detail TEXT NOT NULL DEFAULT '',
  source_index TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (ats, board)
);
CREATE INDEX IF NOT EXISTS idx_harvested_status ON harvested_boards(status, ats);

CREATE TABLE IF NOT EXISTS harvest_runs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  status TEXT NOT NULL DEFAULT 'running',
  params_json TEXT NOT NULL DEFAULT '{}',
  summary_json TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS idx_harvest_runs_started ON harvest_runs(started_at);
`,
};
