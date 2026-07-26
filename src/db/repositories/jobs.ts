import type { Db } from "../database.js";
import { jsonOrDefault, textOrNull } from "../database.js";
import type { CompensationRange, Evaluation, Job } from "../../domain/job.js";
import { nowIso } from "../../util/hash.js";

/** Row mapping and queries for discovered jobs and their evaluations. */

type JobRow = Record<string, unknown>;

function rowToJob(row: JobRow): Job {
  return {
    id: String(row.id),
    fingerprint: String(row.fingerprint),
    ats: String(row.ats) as Job["ats"],
    companyName: String(row.company_name),
    companyTier: String(row.company_tier) as Job["companyTier"],
    board: String(row.board),
    externalId: String(row.external_id),
    title: String(row.title),
    locationsRaw: jsonOrDefault<string[]>(row.locations_raw, []),
    locationClass: String(row.location_class) as Job["locationClass"],
    country: String(row.country),
    workplaceType: String(row.workplace_type) as Job["workplaceType"],
    employmentType: String(row.employment_type ?? "unknown"),
    url: String(row.url),
    applyUrl: String(row.apply_url),
    descriptionText: String(row.description_text ?? ""),
    descriptionHash: String(row.description_hash ?? ""),
    compensation: jsonOrDefault<CompensationRange | null>(row.compensation_json, null),
    postedAt: row.posted_at === null || row.posted_at === undefined ? null : String(row.posted_at),
    capturedAt: String(row.captured_at),
  };
}

export type UpsertResult = { inserted: number; updated: number };

/** Inserts new postings and refreshes `last_seen_at` for ones already stored. */
export function upsertJobs(db: Db, jobs: readonly Job[]): UpsertResult {
  const insert = db.prepare(`
    INSERT INTO jobs (
      id, fingerprint, ats, company_name, company_tier, board, external_id, title,
      locations_raw, location_class, country, workplace_type, employment_type, url, apply_url,
      description_text, description_hash, compensation_json, posted_at, captured_at,
      first_seen_at, last_seen_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      locations_raw = excluded.locations_raw,
      location_class = excluded.location_class,
      country = excluded.country,
      workplace_type = excluded.workplace_type,
      description_text = excluded.description_text,
      description_hash = excluded.description_hash,
      compensation_json = excluded.compensation_json,
      posted_at = excluded.posted_at,
      last_seen_at = excluded.last_seen_at
  `);

  const existing = db.prepare("SELECT id FROM jobs WHERE id = ?");
  let inserted = 0;
  let updated = 0;
  const seenAt = nowIso();

  for (const job of jobs) {
    const isNew = existing.get(job.id) === undefined;
    insert.run(
      job.id,
      job.fingerprint,
      job.ats,
      job.companyName,
      job.companyTier,
      job.board,
      job.externalId,
      job.title,
      JSON.stringify(job.locationsRaw),
      job.locationClass,
      job.country,
      job.workplaceType,
      job.employmentType,
      job.url,
      job.applyUrl,
      job.descriptionText,
      job.descriptionHash,
      job.compensation ? JSON.stringify(job.compensation) : null,
      textOrNull(job.postedAt),
      job.capturedAt,
      seenAt,
      seenAt,
    );
    if (isNew) inserted += 1;
    else updated += 1;
  }
  return { inserted, updated };
}

export function getJob(db: Db, id: string): Job | null {
  const row = db.prepare("SELECT * FROM jobs WHERE id = ?").get(id) as JobRow | undefined;
  return row ? rowToJob(row) : null;
}

export function listJobs(db: Db, limit = 500): Job[] {
  const rows = db.prepare("SELECT * FROM jobs ORDER BY last_seen_at DESC LIMIT ?").all(limit) as JobRow[];
  return rows.map(rowToJob);
}

/** Returns other stored jobs that share a role fingerprint. */
export function findDuplicates(db: Db, fingerprint: string, excludeJobId: string): Job[] {
  const rows = db
    .prepare("SELECT * FROM jobs WHERE fingerprint = ? AND id != ?")
    .all(fingerprint, excludeJobId) as JobRow[];
  return rows.map(rowToJob);
}

export function saveEvaluation(db: Db, evaluation: Evaluation): void {
  db.prepare(`
    INSERT INTO evaluations (
      job_id, decision, gate_rule, gate_reason, gate_evidence, track_id, score, tier,
      components_json, flags_json, evaluated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(job_id) DO UPDATE SET
      decision = excluded.decision,
      gate_rule = excluded.gate_rule,
      gate_reason = excluded.gate_reason,
      gate_evidence = excluded.gate_evidence,
      track_id = excluded.track_id,
      score = excluded.score,
      tier = excluded.tier,
      components_json = excluded.components_json,
      flags_json = excluded.flags_json,
      evaluated_at = excluded.evaluated_at
  `).run(
    evaluation.jobId,
    evaluation.decision,
    textOrNull(evaluation.gate.rule),
    evaluation.gate.reason,
    evaluation.gate.evidence,
    textOrNull(evaluation.trackId),
    evaluation.score,
    evaluation.tier,
    JSON.stringify(evaluation.components),
    JSON.stringify(evaluation.flags),
    evaluation.evaluatedAt,
  );
}

export type QueueItem = { job: Job; evaluation: Evaluation };

function rowToEvaluation(row: JobRow): Evaluation {
  return {
    jobId: String(row.job_id),
    decision: String(row.decision) as Evaluation["decision"],
    gate: {
      passed: row.gate_rule === null || row.gate_rule === undefined,
      rule: row.gate_rule === null || row.gate_rule === undefined ? null : String(row.gate_rule),
      reason: String(row.gate_reason ?? ""),
      evidence: String(row.gate_evidence ?? ""),
    },
    trackId: row.track_id === null || row.track_id === undefined ? null : String(row.track_id),
    score: Number(row.score ?? 0),
    tier: String(row.tier ?? "none") as Evaluation["tier"],
    components: jsonOrDefault(row.components_json, []),
    flags: jsonOrDefault<string[]>(row.flags_json, []),
    evaluatedAt: String(row.evaluated_at),
  };
}

export function getEvaluation(db: Db, jobId: string): Evaluation | null {
  const row = db.prepare("SELECT * FROM evaluations WHERE job_id = ?").get(jobId) as JobRow | undefined;
  return row ? rowToEvaluation(row) : null;
}

export type QueueFilter = {
  minScore?: number;
  tiers?: string[];
  trackId?: string | null;
  trackIds?: string[];
  locationClasses?: string[];
  companies?: string[];
  limit?: number;
  excludeApplied?: boolean;
  /** Minimum annualized top-of-range compensation, in campaign currency. */
  minCompensation?: number;
  /** Keep postings that publish no compensation. */
  allowUnknownCompensation?: boolean;
  /** FX rates for converting posted currencies to the campaign currency. */
  fx?: Record<string, number>;
};

function annualizedMaxIn(job: Job, fx: Record<string, number>): number | null {
  const range = job.compensation;
  if (!range || range.max === null) return null;
  const annual = range.period === "hour" ? range.max * 2080 : range.period === "month" ? range.max * 12 : range.max;
  const rate = fx[range.currency.toUpperCase()];
  return rate ? annual * rate : null;
}

/** Ranked queue of gated-in jobs with no application for the same role yet. */
export function listQueue(db: Db, filter: QueueFilter = {}): QueueItem[] {
  const minScore = filter.minScore ?? 0;
  const limit = filter.limit ?? 50;
  const excludeApplied = filter.excludeApplied !== false;

  // Exclude any role already applied to, matched by fingerprint so the same
  // job on a second board is not applied to twice.
  const dedupeClause = excludeApplied
    ? `AND NOT EXISTS (
         SELECT 1 FROM applications a
         JOIN jobs aj ON aj.id = a.job_id
         WHERE aj.fingerprint = j.fingerprint
       )`
    : "";

  const rows = db
    .prepare(`
      SELECT e.*, j.* FROM evaluations e
      JOIN jobs j ON j.id = e.job_id
      WHERE e.decision = 'accept' AND e.score >= ?
      ${dedupeClause}
      ORDER BY e.score DESC, j.posted_at DESC
      LIMIT ?
    `)
    .all(minScore, limit) as JobRow[];

  return rows
    .map((row) => ({ job: rowToJob(row), evaluation: rowToEvaluation(row) }))
    .filter((item) => (filter.tiers ? filter.tiers.includes(item.evaluation.tier) : true))
    .filter((item) => (filter.trackId ? item.evaluation.trackId === filter.trackId : true))
    .filter((item) =>
      filter.trackIds && filter.trackIds.length > 0
        ? filter.trackIds.includes(item.evaluation.trackId ?? "")
        : true,
    )
    .filter((item) =>
      filter.locationClasses && filter.locationClasses.length > 0
        ? filter.locationClasses.includes(item.job.locationClass)
        : true,
    )
    .filter((item) =>
      filter.companies && filter.companies.length > 0
        ? filter.companies.some((name) => name.toLowerCase() === item.job.companyName.toLowerCase())
        : true,
    )
    .filter((item) => {
      if (filter.minCompensation === undefined) return true;
      const value = annualizedMaxIn(item.job, filter.fx ?? { USD: 1 });
      if (value === null) return filter.allowUnknownCompensation === true;
      return value >= filter.minCompensation;
    });
}

export type RejectionSummary = { rule: string; count: number };

/** Aggregated gate rejection reasons, used to spot a miscalibrated campaign. */
export function rejectionBreakdown(db: Db): RejectionSummary[] {
  const rows = db
    .prepare(
      "SELECT gate_rule AS rule, COUNT(*) AS total FROM evaluations WHERE decision = 'reject' GROUP BY gate_rule ORDER BY total DESC",
    )
    .all() as JobRow[];
  return rows.map((row) => ({ rule: String(row.rule ?? "unknown"), count: Number(row.total ?? 0) }));
}

export type TierSummary = { tier: string; count: number };

export function tierBreakdown(db: Db): TierSummary[] {
  const rows = db
    .prepare("SELECT tier, COUNT(*) AS total FROM evaluations WHERE decision = 'accept' GROUP BY tier ORDER BY tier")
    .all() as JobRow[];
  return rows.map((row) => ({ tier: String(row.tier), count: Number(row.total ?? 0) }));
}

export function countJobs(db: Db): number {
  const row = db.prepare("SELECT COUNT(*) AS total FROM jobs").get() as JobRow | undefined;
  return Number(row?.total ?? 0);
}
