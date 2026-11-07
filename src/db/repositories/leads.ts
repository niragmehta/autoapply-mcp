import type { Db } from "../database.js";
import { jsonOrDefault } from "../database.js";
import { nowIso, shortHash } from "../../util/hash.js";

/**
 * Leads: evidence that a company is hiring, from job alerts, funding news and
 * board harvesting. A lead never becomes an application by itself; it is
 * resolved to an ATS board first, and the pipeline reads the board.
 */

export const LEAD_STATUSES = ["new", "resolved", "ignored"] as const;
export type LeadStatus = (typeof LEAD_STATUSES)[number];

export type LeadInput = {
  source: string;
  sourceId: string;
  title?: string;
  company?: string;
  location?: string;
  url?: string;
  applyUrl?: string;
  publishedAt?: string | null;
  details?: Record<string, unknown>;
  notes?: string;
};

export type Lead = {
  id: string;
  source: string;
  sourceId: string;
  title: string;
  company: string;
  location: string;
  url: string;
  applyUrl: string;
  foundAt: string;
  status: LeadStatus;
  resolvedBoard: string;
  notes: string;
  publishedAt: string | null;
  details: Record<string, unknown>;
  checkedAt: string | null;
};

/** Deterministic, so the same alert imported twice names the same lead. */
export function leadId(source: string, sourceId: string): string {
  return `lead_${shortHash(`${source}:${sourceId}`, 16)}`;
}

function toLead(row: Record<string, unknown>): Lead {
  const status = String(row.status);
  return {
    id: String(row.id),
    source: String(row.source),
    sourceId: String(row.source_id),
    title: String(row.title ?? ""),
    company: String(row.company ?? ""),
    location: String(row.location ?? ""),
    url: String(row.url ?? ""),
    applyUrl: String(row.apply_url ?? ""),
    foundAt: String(row.found_at),
    status: (LEAD_STATUSES as readonly string[]).includes(status) ? (status as LeadStatus) : "new",
    resolvedBoard: String(row.resolved_board ?? ""),
    notes: String(row.notes ?? ""),
    publishedAt: row.published_at === null || row.published_at === undefined ? null : String(row.published_at),
    details: jsonOrDefault<Record<string, unknown>>(row.details_json, {}),
    checkedAt: row.checked_at === null || row.checked_at === undefined ? null : String(row.checked_at),
  };
}

/**
 * Runs `work` in one write transaction. IMMEDIATE takes the write lock up
 * front, so a concurrent process waits on busy_timeout instead of failing
 * mid-batch; inside an existing transaction the work simply joins it.
 */
export function inTransaction<T>(db: Db, work: () => T): T {
  if ((db as { isTransaction?: boolean }).isTransaction === true) return work();
  db.exec("BEGIN IMMEDIATE");
  try {
    const result = work();
    db.exec("COMMIT");
    return result;
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export type UpsertLeadsResult = { added: Lead[]; existing: Lead[] };

/**
 * Inserts new leads and fills blanks on existing ones. A lead's status, notes
 * and resolution are the candidate's decisions and are never overwritten; a
 * newer announcement for the same company replaces the details it carried.
 */
export function upsertLeads(db: Db, inputs: readonly LeadInput[], now = nowIso()): UpsertLeadsResult {
  const added: Lead[] = [];
  const existing: Lead[] = [];
  const select = db.prepare("SELECT * FROM leads WHERE source = ? AND source_id = ?");
  const insert = db.prepare(
    `INSERT INTO leads (id, source, source_id, title, company, location, url, apply_url, found_at, status, notes, published_at, details_json)
     VALUES (?,?,?,?,?,?,?,?,?,'new',?,?,?)`,
  );
  const fill = db.prepare(
    `UPDATE leads SET
       title = CASE WHEN title = '' THEN ? ELSE title END,
       company = CASE WHEN company = '' THEN ? ELSE company END,
       location = CASE WHEN location = '' THEN ? ELSE location END,
       url = CASE WHEN url = '' THEN ? ELSE url END,
       apply_url = CASE WHEN apply_url = '' THEN ? ELSE apply_url END,
       details_json = CASE WHEN ? IS NOT NULL AND (published_at IS NULL OR ? > published_at) THEN ? ELSE details_json END,
       published_at = CASE WHEN ? IS NOT NULL AND (published_at IS NULL OR ? > published_at) THEN ? ELSE published_at END
     WHERE source = ? AND source_id = ?`,
  );

  inTransaction(db, () => {
    for (const input of inputs) {
      const published = input.publishedAt ?? null;
      const details = JSON.stringify(input.details ?? {});
      const current = select.get(input.source, input.sourceId) as Record<string, unknown> | undefined;
      if (current) {
        fill.run(
          input.title ?? "",
          input.company ?? "",
          input.location ?? "",
          input.url ?? "",
          input.applyUrl ?? "",
          published,
          published,
          details,
          published,
          published,
          published,
          input.source,
          input.sourceId,
        );
        existing.push(toLead(select.get(input.source, input.sourceId) as Record<string, unknown>));
        continue;
      }
      insert.run(
        leadId(input.source, input.sourceId),
        input.source,
        input.sourceId,
        input.title ?? "",
        input.company ?? "",
        input.location ?? "",
        input.url ?? "",
        input.applyUrl ?? "",
        now,
        input.notes ?? "",
        published,
        details,
      );
      added.push(toLead(select.get(input.source, input.sourceId) as Record<string, unknown>));
    }
  });
  return { added, existing };
}

export type LeadFilter = {
  status?: LeadStatus;
  source?: string;
  ids?: readonly string[];
  limit?: number;
};

export function listLeads(db: Db, filter: LeadFilter = {}): Lead[] {
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (filter.status) {
    clauses.push("status = ?");
    params.push(filter.status);
  }
  if (filter.source) {
    clauses.push("source = ?");
    params.push(filter.source);
  }
  if (filter.ids && filter.ids.length > 0) {
    clauses.push(`id IN (${filter.ids.map(() => "?").join(",")})`);
    params.push(...filter.ids);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = Math.max(1, Math.min(filter.limit ?? 100, 5000));
  const rows = db
    .prepare(`SELECT * FROM leads ${where} ORDER BY COALESCE(published_at, found_at) DESC, id LIMIT ?`)
    .all(...params, limit) as Array<Record<string, unknown>>;
  return rows.map(toLead);
}

export type LeadCount = { source: string; status: LeadStatus; count: number };

export function countLeads(db: Db): LeadCount[] {
  const rows = db
    .prepare("SELECT source, status, COUNT(*) AS n FROM leads GROUP BY source, status ORDER BY source, status")
    .all() as Array<Record<string, unknown>>;
  return rows.map((row) => ({ source: String(row.source), status: String(row.status) as LeadStatus, count: Number(row.n) }));
}

/** Marks leads as resolved to a board, recorded as `ats:board`. */
export function markLeadsResolved(db: Db, ids: readonly string[], board: string): number {
  if (ids.length === 0) return 0;
  const result = db
    .prepare(`UPDATE leads SET status = 'resolved', resolved_board = ? WHERE id IN (${ids.map(() => "?").join(",")})`)
    .run(board, ...ids);
  return Number(result.changes);
}

/**
 * Records that board resolution was attempted, so a company with no public
 * board is not probed again on every proposal run.
 */
export function markLeadsChecked(db: Db, ids: readonly string[], note: string, now = nowIso()): number {
  if (ids.length === 0) return 0;
  const result = db
    .prepare(`UPDATE leads SET checked_at = ?, notes = ? WHERE id IN (${ids.map(() => "?").join(",")})`)
    .run(now, note, ...ids);
  return Number(result.changes);
}

export function setLeadStatus(db: Db, ids: readonly string[], status: LeadStatus): number {
  if (ids.length === 0) return 0;
  const result = db
    .prepare(`UPDATE leads SET status = ? WHERE id IN (${ids.map(() => "?").join(",")})`)
    .run(status, ...ids);
  return Number(result.changes);
}
