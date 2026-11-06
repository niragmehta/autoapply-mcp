import type { DatabaseSync } from "node:sqlite";

/**
 * Schema extension points.
 *
 * The core tables live in database.ts. Each feature area owns one module under
 * db/schema/ with its own tables, so features can grow independently without
 * every change touching one shared schema string. Tables are created with
 * IF NOT EXISTS and columns are added with ensureColumn, so opening an older
 * database upgrades it in place and opening a current one changes nothing.
 */
export type SchemaModule = {
  /** Feature name, for diagnostics. */
  readonly name: string;
  /** CREATE TABLE / CREATE INDEX statements, each guarded with IF NOT EXISTS. */
  readonly sql: string;
  /** Additive changes to tables that already exist in older databases. */
  readonly migrate?: (db: DatabaseSync) => void;
};

/** Whether `table` already has `column`. */
export function hasColumn(db: DatabaseSync, table: string, column: string): boolean {
  const rows = db.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as Array<{ name?: unknown }>;
  return rows.some((row) => row.name === column);
}

/**
 * Adds a column when it is missing. SQLite has no ADD COLUMN IF NOT EXISTS, and
 * re-running ADD COLUMN on an upgraded database fails, so the check comes first.
 * `definition` is everything after the column name, e.g. "TEXT NOT NULL DEFAULT ''".
 */
export function ensureColumn(db: DatabaseSync, table: string, column: string, definition: string): boolean {
  if (hasColumn(db, table, column)) return false;
  db.exec(`ALTER TABLE ${quoteIdentifier(table)} ADD COLUMN ${quoteIdentifier(column)} ${definition}`);
  return true;
}

function quoteIdentifier(name: string): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`invalid SQL identifier: ${name}`);
  return `"${name}"`;
}

/** Applies every module's tables, then its column migrations, in order. */
export function applySchemaModules(db: DatabaseSync, modules: readonly SchemaModule[]): void {
  for (const module of modules) {
    if (module.sql.trim().length > 0) db.exec(module.sql);
    module.migrate?.(db);
  }
}
