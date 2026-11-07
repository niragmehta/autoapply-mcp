import type { Db } from "../../database.js";
import type { Offer, OfferStatus } from "../../../career/types.js";
import { limitOf, numberOrNull, text, textOrNull, type Row } from "./rows.js";

/** Storage for job offers. */

function rowToOffer(row: Row): Offer {
  return {
    id: text(row.id),
    applicationId: textOrNull(row.application_id),
    company: text(row.company),
    title: text(row.title),
    level: text(row.level),
    currency: text(row.currency),
    base: numberOrNull(row.base) ?? 0,
    bonusTargetAmount: numberOrNull(row.bonus_target_amount),
    bonusTargetPct: numberOrNull(row.bonus_target_pct),
    equityValueAnnual: numberOrNull(row.equity_value_annual),
    equityDetails: text(row.equity_details),
    signOn: numberOrNull(row.sign_on),
    relocation: numberOrNull(row.relocation),
    benefitsNotes: text(row.benefits_notes),
    location: text(row.location),
    remotePolicy: text(row.remote_policy),
    startDate: textOrNull(row.start_date),
    deadline: textOrNull(row.deadline),
    status: text(row.status) as OfferStatus,
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  };
}

/** Inserts an offer, or replaces every field but `created_at` of an existing one. */
export function saveOfferRecord(db: Db, offer: Offer): void {
  db.prepare(`
    INSERT INTO offers (
      id, application_id, company, title, level, currency, base, bonus_target_amount, bonus_target_pct,
      equity_value_annual, equity_details, sign_on, relocation, benefits_notes, location, remote_policy,
      start_date, deadline, status, created_at, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      application_id = excluded.application_id,
      company = excluded.company,
      title = excluded.title,
      level = excluded.level,
      currency = excluded.currency,
      base = excluded.base,
      bonus_target_amount = excluded.bonus_target_amount,
      bonus_target_pct = excluded.bonus_target_pct,
      equity_value_annual = excluded.equity_value_annual,
      equity_details = excluded.equity_details,
      sign_on = excluded.sign_on,
      relocation = excluded.relocation,
      benefits_notes = excluded.benefits_notes,
      location = excluded.location,
      remote_policy = excluded.remote_policy,
      start_date = excluded.start_date,
      deadline = excluded.deadline,
      status = excluded.status,
      updated_at = excluded.updated_at
  `).run(
    offer.id,
    offer.applicationId,
    offer.company,
    offer.title,
    offer.level,
    offer.currency,
    offer.base,
    offer.bonusTargetAmount,
    offer.bonusTargetPct,
    offer.equityValueAnnual,
    offer.equityDetails,
    offer.signOn,
    offer.relocation,
    offer.benefitsNotes,
    offer.location,
    offer.remotePolicy,
    offer.startDate,
    offer.deadline,
    offer.status,
    offer.createdAt,
    offer.updatedAt,
  );
}

export function getOffer(db: Db, id: string): Offer | null {
  const row = db.prepare("SELECT * FROM offers WHERE id = ?").get(id) as Row | undefined;
  return row ? rowToOffer(row) : null;
}

export type OfferFilter = { statuses?: readonly OfferStatus[]; applicationId?: string; limit?: number };

/** Offers newest first. */
export function listOfferRecords(db: Db, filter: OfferFilter = {}): Offer[] {
  const clauses: string[] = [];
  const params: Array<string | number> = [];
  if (filter.statuses && filter.statuses.length > 0) {
    clauses.push(`status IN (${filter.statuses.map(() => "?").join(",")})`);
    params.push(...filter.statuses);
  }
  if (filter.applicationId) {
    clauses.push("application_id = ?");
    params.push(filter.applicationId);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const rows = db
    .prepare(`SELECT * FROM offers ${where} ORDER BY created_at DESC, id DESC LIMIT ?`)
    .all(...params, limitOf(filter.limit, 100)) as Row[];
  return rows.map(rowToOffer);
}
