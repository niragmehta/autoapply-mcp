import { api } from "../api.js";
import { DeleteAction, EditorDrawer } from "../components/confirm.js";
import { FormError, SelectField, TextArea, TextField, useDraft, useSubmit, useUnsavedGuard } from "../components/form.js";
import { Button, CopyButton, ErrorNotice, ExternalLink, Plate, Skeleton } from "../components/ui.js";
import { ago, label } from "../lib/format.js";
import { html, useState } from "../lib/html.js";
import { useAction, useResource } from "../lib/hooks.js";
import { toast, useMeta } from "../lib/store.js";
import { DraftList } from "./outreach.js";

/** One contact: public professional details and where they were found, the drafts written to them, and their company's applications. */

export const KIND_TEXT = {
  recruiter: "Recruiter",
  hiring_manager: "Hiring manager",
  peer: "Peer",
  referral: "Referral (someone you know)",
  other: "Other",
};

const EMPTY = { company: "", name: "", role: "", kind: "recruiter", profileUrl: "", email: "", notes: "", source: "" };

export function ContactForm({ contact, company, onSaved, onCancel, onDirty }) {
  const kinds = useMeta().data?.career?.contactKinds ?? Object.keys(KIND_TEXT);
  const companies = useMeta().data?.companies ?? [];
  const { draft, set, dirty } = useDraft(contact ? Object.fromEntries(Object.keys(EMPTY).map((key) => [key, contact[key] ?? ""])) : { ...EMPTY, company: company ?? "" });
  const guard = useUnsavedGuard(dirty, onDirty);
  const { busy, error, errors, submit } = useSubmit();
  const save = async (event) => {
    event.preventDefault();
    const result = await submit(() => (contact ? api.patch(`/api/contacts/${encodeURIComponent(contact.id)}`, draft) : api.post("/api/contacts", draft)));
    if (!result) return;
    guard.release();
    toast(result.updated ? `${result.contact.name} was already a contact; their details were updated.` : contact ? "Contact saved." : "Contact added.");
    for (const warning of result.warnings ?? []) toast(warning, { tone: "bad" });
    onSaved(result.contact);
  };
  return html`<form class="stack" onSubmit=${save} noValidate>
    <${FormError} error=${error} />
    <div class="form-grid">
      <${TextField} id="contact-name" label="Name" required value=${draft.name} onInput=${set("name")} error=${errors.name ?? (error?.code === "contact_exists" ? error.message : undefined)} maxlength="160" />
      <div class="field">
        <label class="field__label" for="contact-company">Company <span aria-hidden="true">*</span></label>
        <input id="contact-company" class="input" list="contact-companies" required maxlength="200" value=${draft.company} aria-invalid=${errors.company ? "true" : undefined} onInput=${(event) => set("company")(event.currentTarget.value)} />
        <datalist id="contact-companies">${companies.map((name) => html`<option value=${name} />`)}</datalist>
        ${errors.company ? html`<span class="field__error">${errors.company}</span>` : null}
      </div>
      <${TextField} id="contact-role" label="Job title" value=${draft.role} onInput=${set("role")} maxlength="200" placeholder="Senior Technical Recruiter" />
      <${SelectField}
        id="contact-kind"
        label="Kind"
        value=${draft.kind}
        onChange=${set("kind")}
        options=${kinds.map((kind) => ({ value: kind, label: KIND_TEXT[kind] ?? label(kind) }))}
        hint="A referral is someone you already know; a stranger at the company is a peer."
      />
      <${TextField} id="contact-profile" label="Public profile" type="url" wide value=${draft.profileUrl} onInput=${set("profileUrl")} maxlength="500" placeholder="https://www.linkedin.com/in/..." error=${errors.profileUrl ?? (error?.message?.includes("profileUrl") ? error.message : undefined)} />
      <${TextField} id="contact-email" label="Email" type="email" value=${draft.email} onInput=${set("email")} hint="Only an address they published. Never a guessed pattern." error=${errors.email} />
      <${TextField} id="contact-source" label="Where you found them" required value=${draft.source} onInput=${set("source")} maxlength="500" hint="A link or a short note, e.g. 'Acme engineering blog'." error=${errors.source} />
      <${TextArea} id="contact-notes" label="Notes" rows=${3} value=${draft.notes} onInput=${set("notes")} maxlength="4000" hint="Public professional details only; no phone numbers." />
    </div>
    <div class="form-actions">
      <${Button} type="submit" kind="primary" busy=${busy}>${contact ? "Save contact" : "Add contact"}</${Button}>
      <${Button} kind="ghost" onClick=${() => {
        guard.release();
        onCancel();
      }}>Cancel</${Button}>
    </div>
  </form>`;
}

function CompanyApplications({ company }) {
  const applications = useResource(() => api.get("/api/applications", { company, pageSize: 10 }), [company]);
  const rows = applications.data?.rows ?? [];
  if (!rows.length) return null;
  return html`<section class="drawer__section">
    <h3>Applications at ${company}</h3>
    <ul class="plain-list">${rows.map((row) => html`<li key=${row.id}><a href=${`/applications?app=${encodeURIComponent(row.id)}`}>${row.title}</a> <${Plate} value=${row.status} /></li>`)}</ul>
  </section>`;
}

/** `contactId` is a contact's id, or "new" (`company` prefills one). */
export function ContactDrawer({ contactId, company, onClose, onChanged }) {
  const isNew = contactId === "new";
  const loaded = useResource(() => (isNew ? Promise.resolve(null) : api.get(`/api/contacts/${encodeURIComponent(contactId)}`)), [contactId]);
  const [editing, setEditing] = useState(isNew);
  const [dirty, setDirty] = useState(false);
  const [busy, run] = useAction(toast);
  const contact = loaded.data?.contact;
  const remove = async () => {
    const result = await run(() => api.del(`/api/contacts/${encodeURIComponent(contact.id)}`), {
      success: (done) => (done.draftsKept ? `Deleted. ${done.draftsKept} draft${done.draftsKept === 1 ? "" : "s"} to them stay, without the contact.` : "Contact deleted."),
    });
    if (!result) return;
    onChanged();
    onClose();
  };
  return html`<${EditorDrawer}
    wide
    dirty=${dirty}
    title=${isNew ? "Add a contact" : contact ? contact.name : "Contact"}
    sub=${contact ? [contact.role, contact.company].filter(Boolean).join(" at ") : "Someone found in public sources"}
    onClose=${onClose}
  >
    ${loaded.error ? html`<div class="drawer__section"><${ErrorNotice} error=${loaded.error} onRetry=${loaded.reload} /></div>` : null}
    ${!isNew && loaded.loading && !loaded.data ? html`<div class="drawer__section"><${Skeleton} lines=${6} /></div>` : null}
    ${editing
      ? html`<section class="drawer__section">
          <${ContactForm}
            contact=${isNew ? null : contact}
            company=${company}
            onDirty=${setDirty}
            onSaved=${(saved) => {
              setEditing(false);
              onChanged(saved);
              if (!isNew) loaded.reload({ quiet: true });
            }}
            onCancel=${() => (isNew ? onClose() : setEditing(false))}
          />
        </section>`
      : null}
    ${contact && !editing
      ? html`
          <section class="drawer__section stack">
            <dl class="facts">
              <dt>Kind</dt><dd>${KIND_TEXT[contact.kind] ?? label(contact.kind)}</dd>
              <dt>Company</dt><dd>${contact.company}</dd>
              ${contact.profileUrl ? html`<dt>Profile</dt><dd><${ExternalLink} href=${contact.profileUrl}>${contact.profileUrl}</${ExternalLink}></dd>` : null}
              ${contact.email ? html`<dt>Email</dt><dd class="row"><span class="mono small">${contact.email}</span><${CopyButton} text=${contact.email} label="Copy" /></dd>` : null}
              <dt>Found at</dt><dd class="small">${contact.source}</dd>
              <dt>Updated</dt><dd class="small">${ago(contact.updatedAt)}</dd>
            </dl>
            ${contact.notes ? html`<p class="small prose">${contact.notes}</p>` : null}
            <div class="row">
              <a class="btn btn--primary" href=${`/contacts?compose=1&to=${encodeURIComponent(contact.id)}`}>Write to ${contact.name.split(" ")[0]}</a>
              <${Button} onClick=${() => setEditing(true)}>Edit</${Button}>
              <${DeleteAction} what=${contact.name} consequence="Their details are removed. Drafts written to them stay, under their company, without the contact." busy=${busy} onDelete=${remove} />
            </div>
          </section>
          <section class="drawer__section">
            <h3>Drafts to ${contact.name}</h3>
            ${loaded.data.drafts.length
              ? html`<${DraftList} drafts=${loaded.data.drafts} contacts=${[contact]} onChanged=${() => loaded.reload({ quiet: true })} />`
              : html`<p class="small muted">Nothing written to them yet.</p>`}
          </section>
          <${CompanyApplications} company=${contact.company} />
        `
      : null}
  </${EditorDrawer}>`;
}
