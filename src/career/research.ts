import { z } from "zod";
import { appendEvent } from "../db/repositories/events.js";
import { insertCompanyNoteRecord, listCompanyNoteRecords } from "../db/repositories/career/companyNotes.js";
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
  const sources = [...new Set(parsed.sources)];
  sources.forEach(checkSource);
  if (CITED_KINDS.includes(parsed.kind) && sources.length === 0) {
    throw new AppError("sources_required", `a ${parsed.kind} note must cite at least one source (a URL or a short citation)`);
  }
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
  const flags = detectInjection(note.content).map((flag) => flag.pattern);
  return {
    note,
    warnings:
      flags.length > 0
        ? [`The note contains text that reads like instructions to an AI agent (${flags.join(", ")}); keep research notes to facts.`]
        : [],
  };
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
