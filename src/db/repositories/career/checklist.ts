import type { Db } from "../../database.js";
import { text, type Row } from "./rows.js";

/** Contract-checklist clauses the candidate has ticked off for an offer, with when. */

export function listChecklistTicks(db: Db, offerId: string): Map<string, string> {
  const rows = db.prepare("SELECT clause_id, checked_at FROM offer_checklist WHERE offer_id = ?").all(offerId) as Row[];
  return new Map(rows.map((row) => [text(row.clause_id), text(row.checked_at)]));
}

export function setChecklistTick(db: Db, offerId: string, clauseId: string, checkedAt: string): void {
  db.prepare(
    "INSERT INTO offer_checklist (offer_id, clause_id, checked_at) VALUES (?,?,?) ON CONFLICT(offer_id, clause_id) DO NOTHING",
  ).run(offerId, clauseId, checkedAt);
}

export function clearChecklistTick(db: Db, offerId: string, clauseId: string): void {
  db.prepare("DELETE FROM offer_checklist WHERE offer_id = ? AND clause_id = ?").run(offerId, clauseId);
}
