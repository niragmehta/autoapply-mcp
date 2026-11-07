import type { Db } from "../database.js";
import { jsonOrDefault } from "../database.js";
import { newId, nowIso } from "../../util/hash.js";
import { inTransaction } from "./leads.js";

/**
 * Boards harvested from the Common Crawl URL index, and the runs that found
 * and scanned them. A harvested board is a candidate only: it reaches
 * companies.json through a proposal the candidate confirms.
 */

export const HARVEST_ATS = ["greenhouse", "ashby", "lever", "workday"] as const;
export type HarvestAts = (typeof HARVEST_ATS)[number];

/**
 * new       harvested, not scanned yet
 * matching  scanned; at least one posting passed this campaign's gates
 * no-match  scanned; postings exist but none fit
 * empty     scanned; the board publishes nothing
 * dead      the ATS no longer knows the board
 * error     the last scan failed for a reason worth retrying
 * tracked   the company is now in companies.json
 */
export const HARVEST_STATUSES = ["new", "matching", "no-match", "empty", "dead", "error", "tracked"] as const;
export type HarvestStatus = (typeof HARVEST_STATUSES)[number];

export type HarvestedBoardInput = {
  ats: HarvestAts;
  board: string;
  region: "global" | "eu";
  hits: number;
  sourceIndex: string;
};

export type HarvestedBoard = HarvestedBoardInput & {
  firstSeen: string;
  lastScanned: string | null;
  postings: number | null;
  matching: number | null;
  status: HarvestStatus;
  company: string;
  detail: string;
};

function toBoard(row: Record<string, unknown>): HarvestedBoard {
  const nullableNumber = (value: unknown): number | null => (value === null || value === undefined ? null : Number(value));
  return {
    ats: String(row.ats) as HarvestAts,
    board: String(row.board),
    region: row.region === "eu" ? "eu" : "global",
    hits: Number(row.hits ?? 0),
    sourceIndex: String(row.source_index ?? ""),
    firstSeen: String(row.first_seen),
    lastScanned: row.last_scanned === null || row.last_scanned === undefined ? null : String(row.last_scanned),
    postings: nullableNumber(row.postings),
    matching: nullableNumber(row.matching),
    status: String(row.status) as HarvestStatus,
    company: String(row.company ?? ""),
    detail: String(row.detail ?? ""),
  };
}

/** Inserts boards not seen before; returns how many were new. Existing rows only gain hits. */
export function insertHarvestedBoards(db: Db, boards: readonly HarvestedBoardInput[], now = nowIso()): number {
  if (boards.length === 0) return 0;
  const exists = db.prepare("SELECT 1 FROM harvested_boards WHERE ats = ? AND board = ?");
  const insert = db.prepare(
    "INSERT INTO harvested_boards (ats, board, region, first_seen, status, hits, source_index) VALUES (?,?,?,?,'new',?,?)",
  );
  const bump = db.prepare("UPDATE harvested_boards SET hits = hits + ? WHERE ats = ? AND board = ?");
  let inserted = 0;
  inTransaction(db, () => {
    for (const board of boards) {
      if (exists.get(board.ats, board.board)) {
        bump.run(board.hits, board.ats, board.board);
        continue;
      }
      insert.run(board.ats, board.board, board.region, now, board.hits, board.sourceIndex);
      inserted += 1;
    }
  });
  return inserted;
}

/** Every harvested board, for de-duplication against a new harvest. */
export function allHarvestedBoards(db: Db, ats?: readonly HarvestAts[]): HarvestedBoard[] {
  const rows = ats && ats.length > 0
    ? db.prepare(`SELECT * FROM harvested_boards WHERE ats IN (${ats.map(() => "?").join(",")})`).all(...ats)
    : db.prepare("SELECT * FROM harvested_boards").all();
  return (rows as Array<Record<string, unknown>>).map(toBoard);
}

export type HarvestedBoardFilter = {
  ats?: readonly HarvestAts[];
  statuses?: readonly HarvestStatus[];
  /** Also include boards in these statuses whose last scan is older than this ISO time. */
  rescan?: { statuses: readonly HarvestStatus[]; before: string };
  limit?: number;
};

/** Boards due for a scan: never-scanned first, then the most-cited in the crawl. */
export function listHarvestedBoards(db: Db, filter: HarvestedBoardFilter = {}): HarvestedBoard[] {
  const params: Array<string | number> = [];
  const due: string[] = [];
  const statuses = filter.statuses ?? ["new"];
  if (statuses.length > 0) {
    due.push(`status IN (${statuses.map(() => "?").join(",")})`);
    params.push(...statuses);
  }
  if (filter.rescan && filter.rescan.statuses.length > 0) {
    due.push(`(status IN (${filter.rescan.statuses.map(() => "?").join(",")}) AND (last_scanned IS NULL OR last_scanned < ?))`);
    params.push(...filter.rescan.statuses, filter.rescan.before);
  }
  const clauses = due.length > 0 ? [`(${due.join(" OR ")})`] : [];
  if (filter.ats && filter.ats.length > 0) {
    clauses.push(`ats IN (${filter.ats.map(() => "?").join(",")})`);
    params.push(...filter.ats);
  }
  const where = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = Math.max(1, Math.min(filter.limit ?? 50, 100_000));
  const rows = db
    .prepare(`SELECT * FROM harvested_boards ${where} ORDER BY last_scanned IS NOT NULL, last_scanned, hits DESC, board LIMIT ?`)
    .all(...params, limit) as Array<Record<string, unknown>>;
  return rows.map(toBoard);
}

export type BoardScanRecord = {
  status: HarvestStatus;
  postings: number | null;
  matching: number | null;
  company?: string;
  detail?: string;
};

export function recordBoardScan(db: Db, ats: HarvestAts, board: string, scan: BoardScanRecord, now = nowIso()): void {
  db.prepare(
    `UPDATE harvested_boards SET status = ?, postings = ?, matching = ?, last_scanned = ?,
       company = CASE WHEN ? <> '' THEN ? ELSE company END, detail = ?
     WHERE ats = ? AND board = ?`,
  ).run(
    scan.status,
    scan.postings,
    scan.matching,
    now,
    scan.company ?? "",
    scan.company ?? "",
    (scan.detail ?? "").slice(0, 500),
    ats,
    board,
  );
}

export function markHarvestedTracked(db: Db, ats: string, board: string): void {
  db.prepare("UPDATE harvested_boards SET status = 'tracked' WHERE ats = ? AND board = ?").run(ats, board);
}

export type HarvestRun = {
  id: string;
  kind: "harvest" | "scan";
  startedAt: string;
  finishedAt: string | null;
  status: "running" | "done" | "aborted" | "failed";
  params: Record<string, unknown>;
  summary: Record<string, unknown>;
};

export function startHarvestRun(db: Db, kind: HarvestRun["kind"], params: Record<string, unknown>, now = nowIso()): string {
  const id = newId("harvest");
  db.prepare("INSERT INTO harvest_runs (id, kind, started_at, status, params_json) VALUES (?,?,?,'running',?)").run(
    id,
    kind,
    now,
    JSON.stringify(params),
  );
  return id;
}

export function finishHarvestRun(
  db: Db,
  id: string,
  status: Exclude<HarvestRun["status"], "running">,
  summary: Record<string, unknown>,
  now = nowIso(),
): void {
  db.prepare("UPDATE harvest_runs SET finished_at = ?, status = ?, summary_json = ? WHERE id = ?").run(
    now,
    status,
    JSON.stringify(summary),
    id,
  );
}

export function listHarvestRuns(db: Db, limit = 10): HarvestRun[] {
  const rows = db.prepare("SELECT * FROM harvest_runs ORDER BY started_at DESC LIMIT ?").all(limit) as Array<Record<string, unknown>>;
  return rows.map((row) => ({
    id: String(row.id),
    kind: String(row.kind) as HarvestRun["kind"],
    startedAt: String(row.started_at),
    finishedAt: row.finished_at === null || row.finished_at === undefined ? null : String(row.finished_at),
    status: String(row.status) as HarvestRun["status"],
    params: jsonOrDefault<Record<string, unknown>>(row.params_json, {}),
    summary: jsonOrDefault<Record<string, unknown>>(row.summary_json, {}),
  }));
}

export type HarvestCounts = Array<{ ats: string; status: string; count: number }>;

export function countHarvestedBoards(db: Db): HarvestCounts {
  const rows = db
    .prepare("SELECT ats, status, COUNT(*) AS n FROM harvested_boards GROUP BY ats, status ORDER BY ats, status")
    .all() as Array<Record<string, unknown>>;
  return rows.map((row) => ({ ats: String(row.ats), status: String(row.status), count: Number(row.n) }));
}

/** Boards whose last scan found fitting roles, best first. */
export function matchingHarvestedBoards(db: Db, limit = 25): HarvestedBoard[] {
  const rows = db
    .prepare("SELECT * FROM harvested_boards WHERE status = 'matching' ORDER BY matching DESC, last_scanned DESC LIMIT ?")
    .all(limit) as Array<Record<string, unknown>>;
  return rows.map(toBoard);
}
