import { z } from "zod";
import { CompanyNoteInputSchema, companyNotes, deleteCompanyNote, saveCompanyNote, updateCompanyNote, UpdateCompanyNoteSchema } from "../../career/research.js";
import { NOTE_KINDS } from "../../career/types.js";
import { listRecentCompanyNotes } from "../queries/career.js";
import { JsonReply, parseBody, parseParams, parseQuery, type Router } from "../router.js";
import { IdParams, queryInt, queryText } from "./shared.js";

/**
 * Company research notes: strategy, culture, pay signals, news and red flags,
 * each with the sources it was written from. Outside material must cite one.
 */

const blank = (value: unknown) => (value === "" ? undefined : value);

const NotesQuery = z.object({
  company: queryText(),
  kind: z.preprocess(blank, z.enum(NOTE_KINDS).optional()),
  limit: queryInt(1, 500, 100),
});

const NoteBody = CompanyNoteInputSchema.strict();
const NotePatch = UpdateCompanyNoteSchema.omit({ id: true }).strict();

export function registerRoutes(router: Router): void {
  router.get("/api/company-notes", (request) => {
    const query = parseQuery(NotesQuery, request);
    const workspace = request.ctx.workspace();
    const notes = query.company
      ? companyNotes(workspace, query.company, { kind: query.kind, limit: query.limit })
      : listRecentCompanyNotes(workspace.db, { kind: query.kind, limit: query.limit });
    return { company: query.company ?? null, count: notes.length, notes };
  });

  router.post("/api/company-notes", (request) => {
    const body = parseBody(NoteBody, request);
    return new JsonReply(201, saveCompanyNote(request.ctx.workspace(), body));
  });

  router.patch("/api/company-notes/:id", (request) => {
    const { id } = parseParams(IdParams, request);
    const body = parseBody(NotePatch, request);
    return updateCompanyNote(request.ctx.workspace(), { ...body, id });
  });

  router.delete("/api/company-notes/:id", (request) => {
    const { id } = parseParams(IdParams, request);
    return deleteCompanyNote(request.ctx.workspace(), id);
  });
}
