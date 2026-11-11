import type { Db } from "../db/database.js";
import { openDatabase } from "../db/database.js";
import { AppError } from "../util/errors.js";

/**
 * A copy of the application database small enough to move.
 *
 * Postings and their evaluations are most of the file and come back with the
 * next discovery (a posting's id is derived from its board and external id),
 * so only the postings the history refers to are kept. Every other table is
 * copied whole: applications, approvals, events, follow-ups, outcomes and the
 * career records. The copy is built with the current schema, so a database
 * written by an older version arrives with today's columns.
 */

/** Tables whose rows point at a posting; the postings they name are kept. */
const JOB_REFERENCES: ReadonlyArray<readonly [table: string, column: string]> = [
  ["applications", "job_id"],
  ["batch_items", "job_id"],
  ["liveness_checks", "job_id"],
  ["evaluation_reports", "job_id"],
  ["job_dismissals", "job_id"],
];

const FILTERED: Readonly<Record<string, string>> = {
  jobs: "id IN (SELECT id FROM temp.keep_jobs)",
  evaluations: "job_id IN (SELECT id FROM temp.keep_jobs)",
};

export type SlimDatabaseReport = { rows: Record<string, number>; jobsKept: number; jobsLeftOut: number };

const quote = (identifier: string) => `"${identifier.replace(/"/g, '""')}"`;

function tables(db: Db, schema: "main" | "src"): Set<string> {
  const rows = db.prepare(`SELECT name FROM ${schema}.sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`).all() as Array<{ name: string }>;
  return new Set(rows.map((row) => row.name));
}

function columns(db: Db, schema: "main" | "src", table: string): string[] {
  const rows = db.prepare(`SELECT name FROM pragma_table_info(?, ?)`).all(table, schema) as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

/** Builds the slim copy of `sourcePath` at `destPath`, which must not exist yet. */
export function buildSlimDatabase(sourcePath: string, destPath: string): SlimDatabaseReport {
  const db = openDatabase(destPath);
  try {
    db.exec("PRAGMA foreign_keys = OFF;");
    db.exec(`ATTACH DATABASE '${sourcePath.replace(/'/g, "''")}' AS src`);
    const sourceTables = tables(db, "src");
    db.exec("CREATE TEMP TABLE keep_jobs (id TEXT PRIMARY KEY)");
    for (const [table, column] of JOB_REFERENCES) {
      if (!sourceTables.has(table) || !columns(db, "src", table).includes(column)) continue;
      db.exec(`INSERT OR IGNORE INTO temp.keep_jobs SELECT ${quote(column)} FROM src.${quote(table)} WHERE ${quote(column)} IS NOT NULL`);
    }

    const rows: Record<string, number> = {};
    db.exec("BEGIN");
    try {
      for (const table of tables(db, "main")) {
        if (!sourceTables.has(table)) continue;
        const shared = columns(db, "src", table).filter((column) => columns(db, "main", table).includes(column));
        if (shared.length === 0) continue;
        const list = shared.map(quote).join(", ");
        const filter = FILTERED[table] ? `WHERE ${FILTERED[table]}` : "";
        const result = db.prepare(`INSERT INTO main.${quote(table)} (${list}) SELECT ${list} FROM src.${quote(table)} ${filter}`).run();
        rows[table] = Number(result.changes);
      }
      db.exec("COMMIT");
    } catch (error) {
      db.exec("ROLLBACK");
      throw error;
    }

    const sourceJobs = sourceTables.has("jobs") ? Number((db.prepare("SELECT count(*) AS n FROM src.jobs").get() as { n: number }).n) : 0;
    db.exec("DETACH DATABASE src");
    const broken = db.prepare("PRAGMA foreign_key_check").all() as Array<{ table: string; parent: string }>;
    if (broken.length > 0) {
      const first = broken[0];
      throw new AppError("bundle_integrity", `the slim database has ${broken.length} broken reference(s), first ${first?.table} -> ${first?.parent}`);
    }
    db.exec("PRAGMA foreign_keys = ON;");
    // One self-contained file: no write-ahead log beside it.
    db.exec("PRAGMA journal_mode = DELETE;");
    db.exec("VACUUM;");
    const jobsKept = rows.jobs ?? 0;
    return { rows, jobsKept, jobsLeftOut: Math.max(0, sourceJobs - jobsKept) };
  } finally {
    db.close();
  }
}

/** TEXT (or untyped) columns of the tables that have rowids, for rewriting stored paths. */
export function textColumns(db: Db): Array<{ table: string; column: string }> {
  const found: Array<{ table: string; column: string }> = [];
  const rows = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string; sql: string | null }>;
  for (const { name, sql } of rows) {
    if (/WITHOUT\s+ROWID/i.test(sql ?? "")) continue;
    const info = db.prepare("SELECT name, type FROM pragma_table_info(?)").all(name) as Array<{ name: string; type: string }>;
    for (const column of info) {
      if (column.type === "" || /TEXT|CHAR|CLOB/i.test(column.type)) found.push({ table: name, column: column.name });
    }
  }
  return found;
}

/**
 * Rewrites every stored text value that contains one of `needles` (matched
 * without case) through `transform`, and returns how many values changed.
 */
export function rewriteDatabaseText(db: Db, needles: readonly string[], transform: (value: string) => string): number {
  if (needles.length === 0) return 0;
  let changed = 0;
  db.exec("BEGIN");
  try {
    for (const { table, column } of textColumns(db)) {
      const where = needles.map(() => `instr(lower(${quote(column)}), ?) > 0`).join(" OR ");
      const found = db
        .prepare(`SELECT rowid AS rid, ${quote(column)} AS value FROM ${quote(table)} WHERE ${where}`)
        .all(...needles.map((needle) => needle.toLowerCase())) as Array<{ rid: number; value: unknown }>;
      if (found.length === 0) continue;
      const update = db.prepare(`UPDATE ${quote(table)} SET ${quote(column)} = ? WHERE rowid = ?`);
      for (const row of found) {
        if (typeof row.value !== "string") continue;
        const next = transform(row.value);
        if (next === row.value) continue;
        update.run(next, row.rid);
        changed += 1;
      }
    }
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
  return changed;
}
