import { z } from "zod";
import { ContactInputSchema, deleteContact, listContacts, requireContact, saveContact, updateContact, UpdateContactSchema } from "../../career/contacts.js";
import {
  deleteOutreachDraft,
  listOutreachDrafts,
  markOutreach,
  OutreachDraftInputSchema,
  outreachScaffold,
  saveOutreachDraft,
  updateOutreachDraft,
  UpdateOutreachDraftSchema,
} from "../../career/outreach.js";
import { CONTACT_KINDS, OUTREACH_CHANNELS, OUTREACH_STATUSES } from "../../career/types.js";
import { CHANNEL_LIMITS } from "../../career/outreachRules.js";
import { getOutreachDraft } from "../../db/repositories/career/outreach.js";
import { AppError } from "../../util/errors.js";
import { scrubHome } from "../queries/files.js";
import { JsonReply, parseBody, parseParams, parseQuery, type Router } from "../router.js";
import { IdParams, queryInt, queryText } from "./shared.js";

/**
 * Contacts found in public sources, and outreach drafts written to them:
 * scaffold, edit, save (limits and figures checked), copy, then record what
 * the person did. Nothing is ever sent from here.
 */

const blank = (value: unknown) => (value === "" ? undefined : value);

const ContactsQuery = z.object({
  company: queryText(),
  kind: z.preprocess(blank, z.enum(CONTACT_KINDS).optional()),
  applicationId: queryText(),
  limit: queryInt(1, 500, 200),
});

const OutreachQuery = z.object({
  applicationId: queryText(),
  contactId: queryText(),
  company: queryText(),
  status: z.preprocess(blank, z.enum(OUTREACH_STATUSES).optional()),
  channel: z.preprocess(blank, z.enum(OUTREACH_CHANNELS).optional()),
  limit: queryInt(1, 500, 100),
});

const ScaffoldQuery = z.object({
  channel: z.enum(OUTREACH_CHANNELS),
  applicationId: queryText(),
  contactId: queryText(),
  company: queryText(),
});

const ContactBody = ContactInputSchema.strict();
const ContactPatch = UpdateContactSchema.omit({ id: true }).strict();
const DraftBody = OutreachDraftInputSchema.strict();
const DraftPatch = UpdateOutreachDraftSchema.omit({ id: true }).strict();
const MarkBody = z.object({ status: z.enum(OUTREACH_STATUSES) }).strict();

export function registerRoutes(router: Router): void {
  router.get("/api/contacts", (request) => {
    const query = parseQuery(ContactsQuery, request);
    const contacts = listContacts(request.ctx.workspace(), {
      company: query.company,
      kind: query.kind,
      applicationId: query.applicationId,
      limit: query.limit,
    });
    return { count: contacts.length, contacts };
  });

  /** Saving the same name at the same company again updates that contact (saveContact's merge). */
  router.post("/api/contacts", (request) => {
    const body = parseBody(ContactBody, request);
    const result = saveContact(request.ctx.workspace(), body);
    return new JsonReply(result.updated ? 200 : 201, result);
  });

  router.patch("/api/contacts/:id", (request) => {
    const { id } = parseParams(IdParams, request);
    const body = parseBody(ContactPatch, request);
    return updateContact(request.ctx.workspace(), { ...body, id });
  });

  router.get("/api/contacts/:id", (request) => {
    const { id } = parseParams(IdParams, request);
    const workspace = request.ctx.workspace();
    const contact = requireContact(workspace.db, id);
    return { contact, drafts: listOutreachDrafts(workspace, { contactId: contact.id, limit: 100 }) };
  });

  router.delete("/api/contacts/:id", (request) => {
    const { id } = parseParams(IdParams, request);
    return deleteContact(request.ctx.workspace(), id);
  });

  router.get("/api/outreach", (request) => {
    const query = parseQuery(OutreachQuery, request);
    const drafts = listOutreachDrafts(request.ctx.workspace(), {
      applicationId: query.applicationId,
      contactId: query.contactId,
      company: query.company,
      status: query.status,
      channel: query.channel,
      limit: query.limit,
    });
    return { count: drafts.length, drafts };
  });

  /** Who, why, which facts and which limits for a new draft. Reads only. */
  router.get("/api/outreach/scaffold", (request) => {
    const query = parseQuery(ScaffoldQuery, request);
    const scaffold = outreachScaffold(request.ctx.workspace(), query);
    // The attachment checklist names the resume by its path; the browser gets the home folder as "~".
    return { ...scaffold, attachments: scaffold.attachments.map((item) => ({ ...item, detail: scrubHome(item.detail) })) };
  });

  router.post("/api/outreach", (request) => {
    const body = parseBody(DraftBody, request);
    return new JsonReply(201, saveOutreachDraft(request.ctx.workspace(), body));
  });

  router.get("/api/outreach/:id", (request) => {
    const { id } = parseParams(IdParams, request);
    const draft = getOutreachDraft(request.ctx.workspace().db, id);
    if (!draft) throw new AppError("outreach_not_found", `no outreach draft ${id}`);
    return { draft, limits: CHANNEL_LIMITS[draft.channel] };
  });

  router.patch("/api/outreach/:id", (request) => {
    const { id } = parseParams(IdParams, request);
    const body = parseBody(DraftPatch, request);
    return updateOutreachDraft(request.ctx.workspace(), { ...body, id });
  });

  router.delete("/api/outreach/:id", (request) => {
    const { id } = parseParams(IdParams, request);
    return deleteOutreachDraft(request.ctx.workspace(), id);
  });

  /** Records what the person did with a draft: sent it themselves, discarded it, or restored it. */
  router.post("/api/outreach/:id/mark", (request) => {
    const { id } = parseParams(IdParams, request);
    const body = parseBody(MarkBody, request);
    return markOutreach(request.ctx.workspace(), id, body.status);
  });
}
