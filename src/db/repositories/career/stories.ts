import type { Db } from "../../database.js";
import type { Story } from "../../../career/types.js";
import { limitOf, stringArray, text, type Row } from "./rows.js";

/** Storage for STAR + Reflection master stories. */

function rowToStory(row: Row): Story {
  return {
    id: text(row.id),
    title: text(row.title),
    situation: text(row.situation),
    task: text(row.task),
    action: text(row.action),
    result: text(row.result),
    reflection: text(row.reflection),
    skills: stringArray(row.skills_json),
    factIds: stringArray(row.fact_ids_json),
    tags: stringArray(row.tags_json),
    createdAt: text(row.created_at),
    updatedAt: text(row.updated_at),
  };
}

/** Inserts a story, or replaces every field but `created_at` of an existing one. */
export function saveStoryRecord(db: Db, story: Story): void {
  db.prepare(`
    INSERT INTO stories (
      id, title, situation, task, action, result, reflection,
      skills_json, fact_ids_json, tags_json, created_at, updated_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(id) DO UPDATE SET
      title = excluded.title,
      situation = excluded.situation,
      task = excluded.task,
      action = excluded.action,
      result = excluded.result,
      reflection = excluded.reflection,
      skills_json = excluded.skills_json,
      fact_ids_json = excluded.fact_ids_json,
      tags_json = excluded.tags_json,
      updated_at = excluded.updated_at
  `).run(
    story.id,
    story.title,
    story.situation,
    story.task,
    story.action,
    story.result,
    story.reflection,
    JSON.stringify(story.skills),
    JSON.stringify(story.factIds),
    JSON.stringify(story.tags),
    story.createdAt,
    story.updatedAt,
  );
}

export function getStory(db: Db, id: string): Story | null {
  const row = db.prepare("SELECT * FROM stories WHERE id = ?").get(id) as Row | undefined;
  return row ? rowToStory(row) : null;
}

export function listStoryRecords(db: Db, limit?: number): Story[] {
  const rows = db
    .prepare("SELECT * FROM stories ORDER BY updated_at DESC, id LIMIT ?")
    .all(limitOf(limit, 200, 1000)) as Row[];
  return rows.map(rowToStory);
}

export function deleteStoryRecord(db: Db, id: string): boolean {
  const result = db.prepare("DELETE FROM stories WHERE id = ?").run(id);
  return Number(result.changes) > 0;
}
