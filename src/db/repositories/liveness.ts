import type { Db } from "../database.js";
import type { Job } from "../../domain/job.js";
import type { PostingCheck, PostingStatus } from "../../sources/types.js";

/** Stored liveness verdicts and the listing-presence signal derived from discovery. */

export type LivenessRecord = PostingCheck & { jobId: string; checkedAt: string };

type Row = Record<string, unknown>;

const STATUSES: readonly PostingStatus[] = ["open", "closed", "unknown"];

function rowToRecord(row: Row): LivenessRecord {
  const status = String(row.status) as PostingStatus;
  return {
    jobId: String(row.job_id),
    status: STATUSES.includes(status) ? status : "unknown",
    via: String(row.via) === "page" ? "page" : "api",
    detail: String(row.detail ?? ""),
    checkedAt: String(row.checked_at),
  };
}

export function recordLiveness(db: Db, record: LivenessRecord): void {
  db.prepare("INSERT INTO liveness_checks (job_id, status, via, detail, checked_at) VALUES (?,?,?,?,?)").run(
    record.jobId,
    record.status,
    record.via,
    record.detail.slice(0, 500),
    record.checkedAt,
  );
}

/** The most recent verdict for a posting, or null when it was never checked. */
export function latestLiveness(db: Db, jobId: string): LivenessRecord | null {
  const row = db
    .prepare("SELECT * FROM liveness_checks WHERE job_id = ? ORDER BY checked_at DESC, id DESC LIMIT 1")
    .get(jobId) as Row | undefined;
  return row ? rowToRecord(row) : null;
}

/** Latest verdict per posting for a list view, in one query. */
export function latestLivenessFor(db: Db, jobIds: readonly string[]): Map<string, LivenessRecord> {
  const result = new Map<string, LivenessRecord>();
  const unique = [...new Set(jobIds)];
  // SQLite caps bound parameters; chunk well under the lowest default.
  for (let index = 0; index < unique.length; index += 200) {
    const chunk = unique.slice(index, index + 200);
    const placeholders = chunk.map(() => "?").join(",");
    const rows = db
      .prepare(`
        SELECT c.* FROM liveness_checks c
        WHERE c.job_id IN (${placeholders})
          AND c.id = (
            SELECT id FROM liveness_checks
            WHERE job_id = c.job_id
            ORDER BY checked_at DESC, id DESC LIMIT 1
          )
      `)
      .all(...chunk) as Row[];
    for (const row of rows) result.set(String(row.job_id), rowToRecord(row));
  }
  return result;
}

export function livenessHistory(db: Db, jobId: string, limit = 20): LivenessRecord[] {
  const rows = db
    .prepare("SELECT * FROM liveness_checks WHERE job_id = ? ORDER BY checked_at DESC, id DESC LIMIT ?")
    .all(jobId, limit) as Row[];
  return rows.map(rowToRecord);
}

/**
 * Whether a posting was still on its board's listing the last time that board
 * was fetched.
 *
 * Discovery stamps every posting of one board fetch with the same
 * `last_seen_at`, so the board's latest fetch is the newest timestamp shared by
 * at least two postings. A timestamp held by a single posting is ignored: it is
 * as likely to come from one pasted URL being stored as from a full fetch, and
 * treating it as a fetch would mark every other posting on the board absent.
 */
export type ListingPresence = {
  status: "listed" | "absent" | "unknown";
  lastSeenAt: string | null;
  boardFetchedAt: string | null;
  detail: string;
};

/** Slack for a long discovery run that fetched the board's postings in pieces. */
const LISTING_SLACK_MS = 12 * 60 * 60 * 1000;

export function listingPresence(db: Db, job: Pick<Job, "id" | "ats" | "board">): ListingPresence {
  if (job.ats === "external") {
    return { status: "unknown", lastSeenAt: null, boardFetchedAt: null, detail: "pasted posting; there is no board listing to compare" };
  }
  const own = db.prepare("SELECT last_seen_at FROM jobs WHERE id = ?").get(job.id) as Row | undefined;
  const lastSeenAt = own?.last_seen_at === undefined || own.last_seen_at === null ? null : String(own.last_seen_at);
  const fetched = db
    .prepare(`
      SELECT MAX(last_seen_at) AS fetched_at FROM (
        SELECT last_seen_at FROM jobs WHERE ats = ? AND board = ?
        GROUP BY last_seen_at HAVING COUNT(*) >= 2
      )
    `)
    .get(job.ats, job.board) as Row | undefined;
  const boardFetchedAt = fetched?.fetched_at === undefined || fetched.fetched_at === null ? null : String(fetched.fetched_at);

  if (!lastSeenAt || !boardFetchedAt) {
    return { status: "unknown", lastSeenAt, boardFetchedAt, detail: "no full fetch of this board on record" };
  }
  const seen = Date.parse(lastSeenAt);
  const fetchedAt = Date.parse(boardFetchedAt);
  if (!Number.isFinite(seen) || !Number.isFinite(fetchedAt)) {
    return { status: "unknown", lastSeenAt, boardFetchedAt, detail: "unreadable timestamps" };
  }
  if (seen >= fetchedAt - LISTING_SLACK_MS) {
    return { status: "listed", lastSeenAt, boardFetchedAt, detail: "present in the board's latest fetch" };
  }
  return {
    status: "absent",
    lastSeenAt,
    boardFetchedAt,
    detail: `missing from the board's latest fetch (${boardFetchedAt.slice(0, 10)}); last listed ${lastSeenAt.slice(0, 10)}`,
  };
}
