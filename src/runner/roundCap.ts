import type { Db } from "../db/database.js";
import type { RoundCap } from "../domain/policies/runner.js";
import { AppError } from "../util/errors.js";

/**
 * The per-company round cap (`campaign.runner.roundCap`).
 *
 * A round is a stretch of the campaign during which no employer should see
 * more than `max` applications. Submissions are matched to an employer by a
 * normalised name, because the same company appears as "Acme", "Acme, Inc."
 * and "ACME Technologies" across boards.
 */

const LEGAL_SUFFIXES = /\b(inc|llc|ltd|corp|corporation|technologies|technology|labs|hq)\b/g;

export function normalizeCompanyName(name: string): string {
  return name.toLowerCase().replace(LEGAL_SUFFIXES, "").replace(/[^a-z0-9]/g, "");
}

/** The round start as UTC ISO. A bare "2026-10-22T23:00" is read as local time, as a person writing it means. */
export function roundStartIso(cap: RoundCap): string {
  const parsed = new Date(cap.since);
  if (Number.isNaN(parsed.getTime())) {
    throw new AppError("invalid_round_cap", `campaign.runner.roundCap.since "${cap.since}" is not a date`);
  }
  return parsed.toISOString();
}

type Row = Record<string, unknown>;

export type RoundSubmission = { applicationId: string; company: string; submittedAt: string };

export function roundSubmissions(db: Db, sinceIso: string): RoundSubmission[] {
  const rows = db
    .prepare(
      `SELECT a.id AS id, j.company_name AS company, a.submitted_at AS submitted_at
       FROM applications a JOIN jobs j ON j.id = a.job_id
       WHERE a.status = 'submitted' AND a.submitted_at >= ?`,
    )
    .all(sinceIso) as Row[];
  return rows.map((row) => ({
    applicationId: String(row.id),
    company: String(row.company),
    submittedAt: String(row.submitted_at),
  }));
}

/** Submissions to `company` since the round started, not counting `exceptApplicationId`. */
export function countRoundSubmissions(db: Db, company: string, sinceIso: string, exceptApplicationId?: string): number {
  const key = normalizeCompanyName(company);
  return roundSubmissions(db, sinceIso).filter(
    (entry) => entry.applicationId !== exceptApplicationId && normalizeCompanyName(entry.company) === key,
  ).length;
}

export type RoundStanding = { company: string; submitted: number; atCap: boolean };

export type RoundSummary = {
  since: string;
  sinceIso: string;
  max: number;
  submitted: number;
  companies: RoundStanding[];
};

/** Submissions per employer this round, most first. */
export function summarizeRound(db: Db, cap: RoundCap): RoundSummary {
  const sinceIso = roundStartIso(cap);
  const submissions = roundSubmissions(db, sinceIso);
  const byKey = new Map<string, { company: string; submitted: number }>();
  for (const entry of submissions) {
    const key = normalizeCompanyName(entry.company);
    const current = byKey.get(key);
    byKey.set(key, { company: current?.company ?? entry.company, submitted: (current?.submitted ?? 0) + 1 });
  }
  const companies = [...byKey.values()]
    .map((entry) => ({ ...entry, atCap: entry.submitted >= cap.max }))
    .sort((a, b) => b.submitted - a.submitted || a.company.localeCompare(b.company));
  return { since: cap.since, sinceIso, max: cap.max, submitted: submissions.length, companies };
}
