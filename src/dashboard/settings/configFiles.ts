import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import type { ZodError } from "zod";
import { reloadWorkspace } from "../../config/load.js";
import { readJsonFile, updateJsonFile, type WriteOptions } from "../../config/write.js";
import { CampaignSchema } from "../../domain/campaign.js";
import { ApprovedAnswerSchema, ProfileSchema } from "../../domain/profile.js";
import { invalidateWorkspace } from "../../runner/workspace.js";
import { displayPath, scrubHome } from "../queries/files.js";
import { HttpError } from "../router.js";

/**
 * Edits to profile.json and campaign.json from the dashboard.
 *
 * Each write re-reads the file as it is on disk, changes only its own part,
 * validates the whole result against the schema the server loads with, keeps a
 * dated copy of the previous file and swaps the new one in atomically. Then the
 * dashboard re-reads its configuration, keeping the database handle open; an
 * MCP server running elsewhere keeps its copy until reload_config.
 */

export type ApprovedAnswer = ReturnType<typeof ApprovedAnswerSchema.parse>;
type JsonObject = Record<string, unknown>;

export type SaveReceipt = {
  file: string;
  backup: string | null;
  reloaded: boolean;
  reloadError: string | null;
  mcpReload: string;
};

const MCP_RELOAD = "The dashboard uses the new file now. A running MCP server keeps its copy until you run its reload_config tool or restart it.";

const isObject = (value: unknown): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);

/** A short fingerprint of an entry as stored, so an edit can tell the file changed underneath it. */
export function versionOf(raw: unknown): string {
  return createHash("sha256").update(JSON.stringify(raw)).digest("hex").slice(0, 16);
}

function invalid(error: ZodError, file: string): HttpError {
  const issues = error.issues.slice(0, 12).map((issue) => ({ path: issue.path.map(String).join("."), message: issue.message }));
  return new HttpError(400, "invalid_request", `the change would make ${file} invalid: ${issues.map((issue) => `${issue.path}: ${issue.message}`).join("; ")}`, { issues });
}

function reloadAfterWrite(): Pick<SaveReceipt, "reloaded" | "reloadError"> {
  invalidateWorkspace();
  try {
    reloadWorkspace();
    return { reloaded: true, reloadError: null };
  } catch (error) {
    return { reloaded: false, reloadError: scrubHome(error instanceof Error ? error.message : String(error)) };
  }
}

function receipt(path: string, backupPath: string | null): SaveReceipt {
  return { file: displayPath(path), backup: backupPath ? displayPath(backupPath) : null, ...reloadAfterWrite(), mcpReload: MCP_RELOAD };
}

/**
 * Backups are named to the second. A second save within the same second keeps
 * the backup already made, which holds the file as it was before either save,
 * rather than overwriting it with the first save's result.
 */
function backupPlan(path: string): { options: WriteOptions; existing: string | null } {
  const now = new Date();
  const existing = `${path}.bak-${now.toISOString().replace(/[-:]/g, "").replace(/\..*$/, "")}`;
  return existsSync(existing) ? { options: { backup: false }, existing } : { options: { backup: true, now }, existing: null };
}

function updateConfig(path: string, mutate: (current: JsonObject) => JsonObject): SaveReceipt {
  const plan = backupPlan(path);
  const { backupPath } = updateJsonFile<JsonObject>(path, mutate, plan.options);
  return receipt(path, backupPath ?? plan.existing);
}

export type AnswerEntry = { raw: JsonObject; answer: ApprovedAnswer; version: string };

export function entryOf(raw: unknown): AnswerEntry | null {
  const parsed = ApprovedAnswerSchema.safeParse(raw);
  return parsed.success && isObject(raw) ? { raw, answer: parsed.data, version: versionOf(raw) } : null;
}

/** The library as stored in profile.json, in file order. */
export function readAnswerEntries(profilePath: string): AnswerEntry[] {
  const profile = readJsonFile(profilePath);
  const list = isObject(profile) && Array.isArray(profile.answers) ? profile.answers : [];
  return list.map(entryOf).filter((entry): entry is AnswerEntry => entry !== null);
}

/** An answer as written back: the fields that carry a decision, without empty optional ones. */
export function storedAnswer(answer: ApprovedAnswer): JsonObject {
  return {
    key: answer.key,
    label: answer.label,
    patterns: answer.patterns,
    answer: answer.answer,
    ...(answer.alternatives.length ? { alternatives: answer.alternatives } : {}),
    allowAutoFill: answer.allowAutoFill,
    ...(answer.skip ? { skip: true } : {}),
    ...(answer.whenNoDecline?.trim() ? { whenNoDecline: answer.whenNoDecline } : {}),
    ...(answer.note?.trim() ? { note: answer.note } : {}),
  };
}

/** Rewrites profile.answers through `change`, which sees the stored entries and may throw to refuse. */
export function writeProfileAnswers(profilePath: string, change: (entries: AnswerEntry[], raw: unknown[]) => unknown[]): SaveReceipt {
  return updateConfig(profilePath, (current) => {
    const raw = Array.isArray(current.answers) ? current.answers : [];
    const entries = raw.map(entryOf).filter((entry): entry is AnswerEntry => entry !== null);
    const next = { ...current, answers: change(entries, raw) };
    const checked = ProfileSchema.safeParse(next);
    if (!checked.success) throw invalid(checked.error, "profile.json");
    return next;
  });
}

export const DOCUMENT_TOGGLES = ["tailorResume", "maxSwaps", "maxAddedSkills"] as const;
export type DocumentToggles = Partial<{ tailorResume: boolean; maxSwaps: number; maxAddedSkills: number }>;

/** Sets the documents toggles in campaign.json; nothing else in the file changes. */
export function writeDocumentToggles(campaignPath: string, toggles: DocumentToggles): SaveReceipt {
  return updateConfig(campaignPath, (current) => {
    const documents = isObject(current.documents) ? current.documents : {};
    const next = { ...current, documents: { ...documents, ...toggles } };
    const checked = CampaignSchema.safeParse(next);
    if (!checked.success) throw invalid(checked.error, "campaign.json");
    return next;
  });
}
