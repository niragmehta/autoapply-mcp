import type { Db } from "../database.js";
import { jsonOrDefault, textOrNull } from "../database.js";
import { sha256 } from "../../util/hash.js";

/**
 * Batch storage.
 *
 * A batch groups applications prepared together so a person can review and
 * authorize them as one set. The manifest hash is what makes that safe: it
 * covers every packet in the batch, so approval cannot silently extend to
 * content that changed afterwards.
 */

export type BatchItemState = "ready" | "needs_human" | "submitted" | "failed" | "skipped";

export type BatchItem = {
  batchId: string;
  applicationId: string;
  jobId: string;
  packetHash: string;
  state: BatchItemState;
  detail: string;
};

export type Batch = {
  id: string;
  createdAt: string;
  filter: Record<string, unknown>;
  manifestHash: string;
  status: "prepared" | "approved" | "submitting" | "completed" | "cancelled";
  approvedAt: string | null;
  note: string;
};

type Row = Record<string, unknown>;

/**
 * Hashes the batch as a whole. Sorting by application id makes the result
 * independent of preparation order, and including every packet hash means any
 * edit to any application invalidates the batch approval.
 */
export function computeManifestHash(items: readonly Pick<BatchItem, "applicationId" | "packetHash">[]): string {
  const canonical = [...items]
    .map((item) => `${item.applicationId}:${item.packetHash}`)
    .sort()
    .join("|");
  return sha256(canonical);
}

export function createBatch(db: Db, batch: Batch, items: readonly BatchItem[]): void {
  db.prepare(
    "INSERT INTO batches (id, created_at, filter_json, manifest_hash, status, approved_at, note) VALUES (?,?,?,?,?,?,?)",
  ).run(
    batch.id,
    batch.createdAt,
    JSON.stringify(batch.filter),
    batch.manifestHash,
    batch.status,
    textOrNull(batch.approvedAt),
    batch.note,
  );

  const insert = db.prepare(
    "INSERT INTO batch_items (batch_id, application_id, job_id, packet_hash, state, detail) VALUES (?,?,?,?,?,?)",
  );
  for (const item of items) {
    insert.run(item.batchId, item.applicationId, item.jobId, item.packetHash, item.state, item.detail);
  }
}

function rowToBatch(row: Row): Batch {
  return {
    id: String(row.id),
    createdAt: String(row.created_at),
    filter: jsonOrDefault<Record<string, unknown>>(row.filter_json, {}),
    manifestHash: String(row.manifest_hash ?? ""),
    status: String(row.status) as Batch["status"],
    approvedAt: row.approved_at ? String(row.approved_at) : null,
    note: String(row.note ?? ""),
  };
}

function rowToItem(row: Row): BatchItem {
  return {
    batchId: String(row.batch_id),
    applicationId: String(row.application_id),
    jobId: String(row.job_id),
    packetHash: String(row.packet_hash ?? ""),
    state: String(row.state) as BatchItemState,
    detail: String(row.detail ?? ""),
  };
}

export function getBatch(db: Db, id: string): Batch | null {
  const row = db.prepare("SELECT * FROM batches WHERE id = ?").get(id) as Row | undefined;
  return row ? rowToBatch(row) : null;
}

export function latestBatch(db: Db): Batch | null {
  const row = db.prepare("SELECT * FROM batches ORDER BY created_at DESC LIMIT 1").get() as Row | undefined;
  return row ? rowToBatch(row) : null;
}

export function listBatches(db: Db, limit = 20): Batch[] {
  const rows = db.prepare("SELECT * FROM batches ORDER BY created_at DESC LIMIT ?").all(limit) as Row[];
  return rows.map(rowToBatch);
}

export function listBatchItems(db: Db, batchId: string, state?: BatchItemState): BatchItem[] {
  const rows = state
    ? (db.prepare("SELECT * FROM batch_items WHERE batch_id = ? AND state = ?").all(batchId, state) as Row[])
    : (db.prepare("SELECT * FROM batch_items WHERE batch_id = ?").all(batchId) as Row[]);
  return rows.map(rowToItem);
}

export function setBatchStatus(db: Db, id: string, status: Batch["status"], approvedAt?: string, note?: string): void {
  db.prepare("UPDATE batches SET status = ?, approved_at = COALESCE(?, approved_at), note = COALESCE(?, note) WHERE id = ?").run(
    status,
    textOrNull(approvedAt ?? null),
    textOrNull(note ?? null),
    id,
  );
}

export function setBatchItemState(db: Db, batchId: string, applicationId: string, state: BatchItemState, detail = ""): void {
  db.prepare("UPDATE batch_items SET state = ?, detail = ? WHERE batch_id = ? AND application_id = ?").run(
    state,
    detail,
    batchId,
    applicationId,
  );
}

export function batchSummary(db: Db, batchId: string): Record<string, number> {
  const rows = db
    .prepare("SELECT state, COUNT(*) AS n FROM batch_items WHERE batch_id = ? GROUP BY state")
    .all(batchId) as Row[];
  return rows.reduce<Record<string, number>>((acc, row) => {
    acc[String(row.state)] = Number(row.n ?? 0);
    return acc;
  }, {});
}
