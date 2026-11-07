import { contactsForApplication } from "../career/contacts.js";
import type { Contact, ContactKind } from "../career/types.js";
import type { Db } from "../db/database.js";
import { AppError } from "../util/errors.js";
import type { FollowUpChannel, FollowUpContactLookup } from "./cadence.js";

/** A status follow-up goes to someone involved in hiring, never to a peer met elsewhere. */
const FOLLOW_UP_KINDS: ReadonlySet<ContactKind> = new Set(["recruiter", "hiring_manager", "referral"]);

const firstName = (name: string): string => name.trim().split(/\s+/)[0] ?? name;

function channelFor(contact: Contact): FollowUpChannel | null {
  const who = contact.role ? `${contact.name}, ${contact.role}` : contact.name;
  if (contact.email) return { channel: "email", detail: `${who} <${contact.email}>`, name: firstName(contact.name) };
  if (contact.profileUrl) return { channel: "linkedin_message", detail: `${who}: ${contact.profileUrl}`, name: firstName(contact.name) };
  return null;
}

/**
 * Finds who a follow-up should go to from the contacts saved with the career
 * tools: contacts linked to the application first, then anyone at the company,
 * recruiters ahead of hiring managers. Null when nobody reachable is on file.
 */
export function careerContactLookup(db: Db): FollowUpContactLookup {
  return ({ applicationId }) => {
    let contacts: Contact[];
    try {
      contacts = contactsForApplication(db, applicationId);
    } catch (error) {
      // An application or posting that no longer exists has nobody to follow up with.
      if (error instanceof AppError && (error.code === "application_not_found" || error.code === "job_not_found")) return null;
      throw error;
    }
    for (const contact of contacts) {
      if (!FOLLOW_UP_KINDS.has(contact.kind)) continue;
      const channel = channelFor(contact);
      if (channel) return channel;
    }
    return null;
  };
}
