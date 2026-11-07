import { z } from "zod";
import { appendEvent } from "../db/repositories/events.js";
import {
  deleteCompanyNoteRecord,
  getCompanyNoteRecord,
  insertCompanyNoteRecord,
  listCompanyNoteRecords,
  updateCompanyNoteRecord,
} from "../db/repositories/career/companyNotes.js";
import { detectInjection } from "../text/untrusted.js";
import { AppError } from "../util/errors.js";
import { newId, nowIso } from "../util/hash.js";
import { parseInput, type CareerWorkspace } from "./context.js";
import { NOTE_KINDS, type CompanyNote, type NoteKind } from "./types.js";

/**
 * Company research notes: strategy, culture, compensation signals, news and
 * red flags, each saved with the sources it was written from. The agent does
 * the research with its own web tools; the server only keeps the result.
 */

/** Kinds that summarize outside material, and so must say where it came from. */
const CITED_KINDS: readonly NoteKind[] = ["research", "culture", "comp", "news"];

export const CompanyNoteInputSchema = z.object({
  company: z.string().trim().min(1).max(200),
  kind: z.enum(NOTE_KINDS),
  content: z.string().trim().min(1).max(20_000),
  sources: z
    .array(z.string().trim().min(1).max(500))
    .max(30)
    .default([])
    .describe("URLs or short citations, e.g. 'Interview debrief 2026-11-02'."),
});
type CompanyNoteInput = z.input<typeof CompanyNoteInputSchema>;

function checkSource(source: string): void {
  if (!source.includes("://")) return;
  let protocol = "";
  try {
    protocol = new URL(source).protocol;
  } catch {
    throw new AppError("invalid_source", `source "${source}" is not a valid URL`);
  }
  if (protocol !== "https:" && protocol !== "http:") {
    throw new AppError("invalid_source", `source "${source}" must be an http(s) URL`);
  }
}

export function saveCompanyNote(workspace: Pick<CareerWorkspace, "db">, input: CompanyNoteInput) {
  const parsed = parseInput(CompanyNoteInputSchema, input, "company note");
  const sources = checkedSources(parsed.kind, parsed.sources);
  const note: CompanyNote = {
    id: newId("note"),
    company: parsed.company,
    kind: parsed.kind,
    content: parsed.content,
    sources,
    createdAt: nowIso(),
  };
  insertCompanyNoteRecord(workspace.db, note);
  appendEvent(workspace.db, "company_note.saved", note.id, { company: note.company, kind: note.kind });
  return { note, warnings: noteWarnings(note) };
}

/** Deduplicated sources, each a valid http(s) URL when it looks like one; outside material must cite at least one. */
function checkedSources(kind: NoteKind, raw: readonly string[]): string[] {
  const sources = [...new Set(raw)];
  sources.forEach(checkSource);
  if (CITED_KINDS.includes(kind) && sources.length === 0) {
    throw new AppError("sources_required", `a ${kind} note must cite at least one source (a URL or a short citation)`);
  }
  return sources;
}

function noteWarnings(note: CompanyNote): string[] {
  const flags = detectInjection(note.content).map((flag) => flag.pattern);
  return flags.length > 0
    ? [`The note contains text that reads like instructions to an AI agent (${flags.join(", ")}); keep research notes to facts.`]
    : [];
}

export function getCompanyNote(workspace: Pick<CareerWorkspace, "db">, id: string): CompanyNote {
  const note = getCompanyNoteRecord(workspace.db, id);
  if (!note) throw new AppError("note_not_found", `no company note ${id}`);
  return note;
}

export const UpdateCompanyNoteSchema = z.object({
  id: z.string().trim().min(1),
  company: z.string().trim().min(1).max(200).optional(),
  kind: z.enum(NOTE_KINDS).optional(),
  content: z.string().trim().min(1).max(20_000).optional(),
  sources: z.array(z.string().trim().min(1).max(500)).max(30).optional(),
});
type UpdateCompanyNoteInput = z.input<typeof UpdateCompanyNoteSchema>;

/** Edits a note under the same source rules as saving one. */
export function updateCompanyNote(workspace: Pick<CareerWorkspace, "db">, input: UpdateCompanyNoteInput) {
  const parsed = parseInput(UpdateCompanyNoteSchema, input, "company note update");
  const existing = getCompanyNote(workspace, parsed.id);
  const kind = parsed.kind ?? existing.kind;
  const note: CompanyNote = {
    ...existing,
    company: parsed.company ?? existing.company,
    kind,
    content: parsed.content ?? existing.content,
    sources: checkedSources(kind, parsed.sources ?? existing.sources),
  };
  const changed = (["company", "kind", "content", "sources"] as const).filter(
    (key) => JSON.stringify(note[key]) !== JSON.stringify(existing[key]),
  );
  updateCompanyNoteRecord(workspace.db, note);
  appendEvent(workspace.db, "company_note.updated", note.id, { company: note.company, kind: note.kind, changed });
  return { note, changed, warnings: noteWarnings(note) };
}

export function deleteCompanyNote(workspace: Pick<CareerWorkspace, "db">, id: string): { deleted: string } {
  const note = getCompanyNote(workspace, id);
  deleteCompanyNoteRecord(workspace.db, note.id);
  appendEvent(workspace.db, "company_note.deleted", note.id, { company: note.company, kind: note.kind });
  return { deleted: note.id };
}

/** Notes for one company, newest first; company names match case-insensitively. */
export function companyNotes(
  workspace: Pick<CareerWorkspace, "db">,
  company: string,
  options: { kind?: NoteKind; limit?: number } = {},
): CompanyNote[] {
  if (!company.trim()) throw new AppError("invalid_input", "company is required");
  return listCompanyNoteRecords(workspace.db, company, options.kind, options.limit);
}
