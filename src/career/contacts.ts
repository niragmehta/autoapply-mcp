import { z } from "zod";
import type { Db } from "../db/database.js";
import { appendEvent } from "../db/repositories/events.js";
import {
  contactIdsForApplication,
  findContactByName,
  getContact,
  listContactRecords,
  saveContactRecord,
} from "../db/repositories/career/contacts.js";
import { AppError } from "../util/errors.js";
import { newId, nowIso } from "../util/hash.js";
import { parseInput, requireApplication, type CareerWorkspace } from "./context.js";
import { CONTACT_KINDS, type Contact, type ContactKind } from "./types.js";

/**
 * Contacts: recruiters, hiring managers, peers and referrers found in public
 * sources. Only publicly listed professional details are kept, each with the
 * place it was found. Email addresses are never guessed from a pattern.
 */

export const ContactInputSchema = z.object({
  company: z.string().trim().min(1).max(200),
  name: z.string().trim().min(1).max(160),
  role: z.string().trim().max(200).default(""),
  kind: z
    .enum(CONTACT_KINDS)
    .describe("referral = someone with a real prior relationship to the candidate; a same-company stranger is a peer."),
  profileUrl: z.string().trim().max(500).default("").describe("Public profile URL, e.g. a LinkedIn or GitHub page."),
  email: z.union([z.literal(""), z.email()]).default("").describe("Only an address published publicly; never a guessed pattern."),
  notes: z.string().max(4000).default(""),
  source: z.string().trim().min(1, "say where this contact was publicly found").max(500),
});
type ContactInput = z.input<typeof ContactInputSchema>;

/** Order in which a follow-up or outreach should consider contacts. */
const KIND_PRIORITY: Readonly<Record<ContactKind, number>> = {
  recruiter: 0,
  hiring_manager: 1,
  referral: 2,
  peer: 3,
  other: 4,
};

const PHONE_LIKE = /(?:\+\d{1,3}[\s.-]?)?\(?\d{3}\)?[\s.-]\d{3}[\s.-]\d{4}\b/;

function checkProfileUrl(url: string): void {
  if (!url) return;
  let protocol = "";
  try {
    protocol = new URL(url).protocol;
  } catch {
    throw new AppError("invalid_input", `profileUrl "${url}" is not a valid URL`);
  }
  if (protocol !== "https:" && protocol !== "http:") throw new AppError("invalid_input", "profileUrl must be an http(s) URL");
}

function preferNew(next: string, prior: string): string {
  return next.trim() ? next.trim() : prior;
}

/**
 * Saves a contact. A second save for the same name at the same company
 * updates that contact instead of duplicating it; blank fields keep their
 * earlier value.
 */
export function saveContact(workspace: Pick<CareerWorkspace, "db">, input: ContactInput) {
  const parsed = parseInput(ContactInputSchema, input, "contact");
  checkProfileUrl(parsed.profileUrl);
  const { db } = workspace;
  const existing = findContactByName(db, parsed.company, parsed.name);
  const now = nowIso();
  const contact: Contact = {
    id: existing?.id ?? newId("contact"),
    company: existing?.company ?? parsed.company,
    name: existing?.name ?? parsed.name,
    role: preferNew(parsed.role, existing?.role ?? ""),
    kind: parsed.kind,
    profileUrl: preferNew(parsed.profileUrl, existing?.profileUrl ?? ""),
    email: preferNew(parsed.email, existing?.email ?? ""),
    notes: preferNew(parsed.notes, existing?.notes ?? ""),
    source: parsed.source,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  saveContactRecord(db, contact);
  appendEvent(db, existing ? "contact.updated" : "contact.saved", contact.id, { company: contact.company, kind: contact.kind });
  const warnings = PHONE_LIKE.test(contact.notes)
    ? ["The notes look like they contain a phone number; keep contacts to public professional details."]
    : [];
  return { contact, updated: existing !== null, warnings };
}

type ContactListFilter = { company?: string; kind?: ContactKind; applicationId?: string; limit?: number };

export function listContacts(workspace: Pick<CareerWorkspace, "db">, filter: ContactListFilter = {}): Contact[] {
  if (filter.applicationId) {
    const contacts = contactsForApplication(workspace.db, filter.applicationId);
    return filter.kind ? contacts.filter((contact) => contact.kind === filter.kind) : contacts;
  }
  return listContactRecords(workspace.db, { company: filter.company, kind: filter.kind, limit: filter.limit });
}

export function requireContact(db: Db, id: string): Contact {
  const contact = getContact(db, id);
  if (!contact) throw new AppError("contact_not_found", `no contact ${id}`);
  return contact;
}

/**
 * Contacts relevant to an application: everyone saved at the posting's
 * company plus anyone an outreach draft for it was addressed to, recruiters
 * first. Used by interview prep and by follow-ups.
 */
export function contactsForApplication(db: Db, applicationId: string): Contact[] {
  const { job } = requireApplication(db, applicationId);
  const byId = new Map<string, Contact>();
  for (const contact of listContactRecords(db, { company: job.companyName })) byId.set(contact.id, contact);
  for (const id of contactIdsForApplication(db, applicationId)) {
    const contact = getContact(db, id);
    if (contact) byId.set(contact.id, contact);
  }
  return [...byId.values()].sort(
    (left, right) =>
      (KIND_PRIORITY[left.kind] ?? 9) - (KIND_PRIORITY[right.kind] ?? 9) || left.name.localeCompare(right.name),
  );
}
