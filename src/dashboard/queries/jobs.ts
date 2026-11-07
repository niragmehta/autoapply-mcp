import type { Db } from "../../db/database.js";
import { jsonOrDefault } from "../../db/database.js";
import { latestLivenessFor } from "../../db/repositories/liveness.js";
import type { CompensationRange } from "../../domain/job.js";

/**
 * Read models for the dashboard's job table: filtering, sorting and paging in
 * SQL, so a campaign with tens of thousands of postings stays responsive.
 *
 * "Has an application" and "dismissed" are judged by role fingerprint, the
 * way listQueue judges them, so the dashboard's "not prepared" count is the
 * queue the prepare tools would actually draw from.
 */

export const JOB_SORTS = {
  score: "e.score",
  posted: "j.posted_at",
  seen: "j.last_seen_at",
  company: "j.company_name COLLATE NOCASE",
  title: "j.title COLLATE NOCASE",
  tier: "e.tier",
} as const;
export type JobSort = keyof typeof JOB_SORTS;

/** hide: leave dismissed roles out (the default, as the queue does); include: show them too; only: just them. */
export type DismissedFilter = "hide" | "include" | "only";

export type JobListFilter = {
  q?: string;
  tiers?: string[];
  tracks?: string[];
  decisions?: string[];
  locationClasses?: string[];
  ats?: string[];
  company?: string;
  hasApplication?: boolean;
  minScore?: number;
  dismissed?: DismissedFilter;
  sort: JobSort;
  dir: "asc" | "desc";
  page: number;
  pageSize: number;
};

export type JobRow = {
  id: string;
  company: string;
  companyTier: string;
  title: string;
  ats: string;
  locationClass: string;
  locations: string[];
  country: string;
  workplaceType: string;
  compensation: string | null;
  postedAt: string | null;
  firstSeenAt: string;
  lastSeenAt: string;
  url: string;
  evaluation: {
    decision: string;
    score: number;
    tier: string;
    trackId: string | null;
    gateRule: string | null;
    gateReason: string;
    flags: string[];
  } | null;
  application: { id: string; status: string } | null;
  /** The same role already has an application, possibly on another board. */
  roleApplied: boolean;
  dismissal: { reason: string; dismissedAt: string } | null;
  liveness: { status: string; checkedAt: string; detail: string } | null;
};

type Row = Record<string, unknown>;

/** Escapes LIKE wildcards so a search for "100%" means the literal text. */
export function likePattern(text: string): string {
  return `%${text.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
}

export function inClause(column: string, values: readonly string[]): string {
  return `${column} IN (${values.map(() => "?").join(", ")})`;
}

const ROLE_APPLIED = `EXISTS (SELECT 1 FROM applications ra JOIN jobs rj ON rj.id = ra.job_id WHERE rj.fingerprint = j.fingerprint)`;

function whereFor(filter: Omit<JobListFilter, "sort" | "dir" | "page" | "pageSize">): { sql: string; values: Array<string | number> } {
  const clauses: string[] = [];
  const values: Array<string | number> = [];
  const list = (column: string, items: readonly string[] | undefined) => {
    if (!items || items.length === 0) return;
    clauses.push(inClause(column, items));
    values.push(...items);
  };
  if (filter.q && filter.q.trim().length > 0) {
    const pattern = likePattern(filter.q.trim());
    clauses.push("(j.title LIKE ? ESCAPE '\\' OR j.company_name LIKE ? ESCAPE '\\')");
    values.push(pattern, pattern);
  }
  list("e.tier", filter.tiers);
  list("e.track_id", filter.tracks);
  list("e.decision", filter.decisions);
  list("j.location_class", filter.locationClasses);
  list("j.ats", filter.ats);
  if (filter.company) {
    clauses.push("j.company_name = ? COLLATE NOCASE");
    values.push(filter.company);
  }
  if (filter.hasApplication !== undefined) clauses.push(filter.hasApplication ? ROLE_APPLIED : `NOT ${ROLE_APPLIED}`);
  if (filter.minScore !== undefined) {
    clauses.push("e.score >= ?");
    values.push(filter.minScore);
  }
  const dismissed = filter.dismissed ?? "hide";
  if (dismissed === "hide") clauses.push("d.fingerprint IS NULL");
  if (dismissed === "only") clauses.push("d.fingerprint IS NOT NULL");
  return { sql: clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "", values };
}

const FROM = `FROM jobs j
  LEFT JOIN evaluations e ON e.job_id = j.id
  LEFT JOIN applications a ON a.job_id = j.id
  LEFT JOIN job_dismissals d ON d.fingerprint = j.fingerprint`;

function rowToJob(row: Row): Omit<JobRow, "liveness"> {
  const compensation = jsonOrDefault<CompensationRange | null>(row.compensation_json, null);
  return {
    id: String(row.id),
    company: String(row.company_name),
    companyTier: String(row.company_tier ?? ""),
    title: String(row.title),
    ats: String(row.ats),
    locationClass: String(row.location_class),
    locations: jsonOrDefault<string[]>(row.locations_raw, []),
    country: String(row.country ?? ""),
    workplaceType: String(row.workplace_type ?? "unknown"),
    compensation: compensation?.raw ? compensation.raw : null,
    postedAt: row.posted_at ? String(row.posted_at) : null,
    firstSeenAt: String(row.first_seen_at),
    lastSeenAt: String(row.last_seen_at),
    url: String(row.url),
    evaluation:
      row.decision === null || row.decision === undefined
        ? null
        : {
            decision: String(row.decision),
            score: Number(row.score ?? 0),
            tier: String(row.tier ?? "none"),
            trackId: row.track_id ? String(row.track_id) : null,
            gateRule: row.gate_rule ? String(row.gate_rule) : null,
            gateReason: String(row.gate_reason ?? ""),
            flags: jsonOrDefault<string[]>(row.flags_json, []),
          },
    application: row.application_id ? { id: String(row.application_id), status: String(row.application_status) } : null,
    roleApplied: Number(row.role_applied ?? 0) === 1,
    dismissal: row.dismissed_at ? { reason: String(row.dismissed_reason ?? ""), dismissedAt: String(row.dismissed_at) } : null,
  };
}

export function listJobRows(db: Db, filter: JobListFilter): { total: number; rows: JobRow[] } {
  const where = whereFor(filter);
  const totalRow = db.prepare(`SELECT COUNT(*) AS total ${FROM} ${where.sql}`).get(...where.values) as Row | undefined;
  const order = `${JOB_SORTS[filter.sort]} ${filter.dir === "asc" ? "ASC" : "DESC"} NULLS LAST, j.id ASC`;
  const rows = (
    db
      .prepare(
        `SELECT j.id, j.company_name, j.company_tier, j.title, j.ats, j.location_class, j.locations_raw, j.country,
                j.workplace_type, j.compensation_json, j.posted_at, j.first_seen_at, j.last_seen_at, j.url,
                e.decision, e.score, e.tier, e.track_id, e.gate_rule, e.gate_reason, e.flags_json,
                a.id AS application_id, a.status AS application_status,
                ${ROLE_APPLIED} AS role_applied,
                d.reason AS dismissed_reason, d.dismissed_at AS dismissed_at
         ${FROM} ${where.sql}
         ORDER BY ${order}
         LIMIT ? OFFSET ?`,
      )
      .all(...where.values, filter.pageSize, (filter.page - 1) * filter.pageSize) as Row[]
  ).map(rowToJob);
  const verdicts = latestLivenessFor(db, rows.map((row) => row.id));
  return {
    total: Number(totalRow?.total ?? 0),
    rows: rows.map((row) => {
      const verdict = verdicts.get(row.id);
      return { ...row, liveness: verdict ? { status: verdict.status, checkedAt: verdict.checkedAt, detail: verdict.detail } : null };
    }),
  };
}

export type Facet = { value: string; count: number };

function facet(db: Db, sql: string): Facet[] {
  return (db.prepare(sql).all() as Row[]).map((row) => ({ value: String(row.value ?? "none"), count: Number(row.total ?? 0) }));
}

/** Value counts across all stored jobs, for filter controls. */
export function jobFacets(db: Db): Record<"decisions" | "tiers" | "tracks" | "ats" | "locationClasses", Facet[]> & { dismissed: number } {
  const dismissed = db.prepare("SELECT COUNT(*) AS total FROM job_dismissals").get() as Row | undefined;
  return {
    decisions: facet(db, "SELECT decision AS value, COUNT(*) AS total FROM evaluations GROUP BY decision ORDER BY total DESC"),
    tiers: facet(db, "SELECT tier AS value, COUNT(*) AS total FROM evaluations WHERE decision = 'accept' GROUP BY tier ORDER BY tier"),
    tracks: facet(db, "SELECT track_id AS value, COUNT(*) AS total FROM evaluations WHERE track_id IS NOT NULL GROUP BY track_id ORDER BY total DESC"),
    ats: facet(db, "SELECT ats AS value, COUNT(*) AS total FROM jobs GROUP BY ats ORDER BY total DESC"),
    locationClasses: facet(db, "SELECT location_class AS value, COUNT(*) AS total FROM jobs GROUP BY location_class ORDER BY total DESC"),
    dismissed: Number(dismissed?.total ?? 0),
  };
}

/**
 * Accepted roles with no application and not dismissed, by fingerprint: the
 * same set listQueue draws from before its score and tier filters.
 */
export function unpreparedAcceptedCount(db: Db): number {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS total FROM evaluations e JOIN jobs j ON j.id = e.job_id
       WHERE e.decision = 'accept'
         AND NOT EXISTS (SELECT 1 FROM applications a JOIN jobs aj ON aj.id = a.job_id WHERE aj.fingerprint = j.fingerprint)
         AND NOT EXISTS (SELECT 1 FROM job_dismissals d WHERE d.fingerprint = j.fingerprint)`,
    )
    .get() as Row | undefined;
  return Number(row?.total ?? 0);
}
