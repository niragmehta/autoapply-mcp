import { api } from "../api.js";
import { DeleteAction, EditorDrawer } from "../components/confirm.js";
import { FormError, SelectField, TextArea, TextField, useDraft, useSubmit, useUnsavedGuard, wordCount } from "../components/form.js";
import { Button, CopyButton, ErrorNotice, Plate, Skeleton } from "../components/ui.js";
import { ago, label, num } from "../lib/format.js";
import { html, useEffect, useState } from "../lib/html.js";
import { useAction, useDebounced, useResource } from "../lib/hooks.js";
import { setQuery } from "../lib/router.js";
import { toast } from "../lib/store.js";

/**
 * Outreach: a scaffold of who, why, which facts and which limits; an editor
 * that counts against the channel's limits; saving, which checks every
 * figure; then copying it out and recording what you did. Nothing is ever
 * sent from here: "I sent it" records that you sent it yourself.
 */

export const CHANNEL_TEXT = {
  linkedin_connect: "LinkedIn connection note",
  linkedin_message: "LinkedIn message",
  email: "Email",
  referral_request: "Referral request",
  follow_up: "Follow-up",
};

function DraftItem({ draft, contacts, onChanged }) {
  const [busy, run] = useAction(toast);
  const contact = contacts.find((entry) => entry.id === draft.contactId);
  const mark = (status, success) =>
    run(() => api.post(`/api/outreach/${encodeURIComponent(draft.id)}/mark`, { status }), { success }).then((result) => result && onChanged());
  const remove = () => run(() => api.del(`/api/outreach/${encodeURIComponent(draft.id)}`), { success: "Draft deleted." }).then((result) => result && onChanged());
  const text = draft.subject ? `${draft.subject}\n\n${draft.body}` : draft.body;
  return html`<li class="followup">
    <div class="followup__head">
      <span>
        <span class="cell-main">${draft.company}${contact ? ` · ${contact.name}` : ""}</span>
        <span class="cell-sub">${CHANNEL_TEXT[draft.channel] ?? label(draft.channel)}${draft.subject ? `: ${draft.subject}` : ""}</span>
      </span>
      <span class="row"><${Plate} value=${draft.status} text=${draft.status === "sent_by_user" ? "Sent by you" : undefined} /><span class="small muted">${ago(draft.updatedAt)}</span></span>
    </div>
    <pre class="draft__text" tabindex="0" aria-label=${`Draft to ${draft.company}`}>${draft.body}</pre>
    <div class="followup__actions">
      ${draft.status === "draft"
        ? html`<${CopyButton} text=${text} label="Copy text" small=${false} />
            <${Button} kind="primary" busy=${busy} onClick=${() => mark("sent_by_user", "Recorded as sent by you.")}>I sent it</${Button}>
            <a class="btn" href=${`/contacts?draft=${encodeURIComponent(draft.id)}`}>Edit</a>
            <${Button} kind="ghost" busy=${busy} onClick=${() => mark("discarded", "Discarded. Restore it any time.")}>Discard</${Button}>
            <${DeleteAction} what="this draft" consequence="The draft is removed for good; nothing was sent." busy=${busy} onDelete=${remove} />`
        : draft.status === "discarded"
          ? html`<${Button} busy=${busy} onClick=${() => mark("draft", "Restored to drafts.")}>Restore to drafts</${Button}>
              <${DeleteAction} what="this draft" consequence="The draft is removed for good; nothing was sent." busy=${busy} onDelete=${remove} />`
          : html`<${CopyButton} text=${text} label="Copy text" small=${false} /><span class="small muted">You sent this one; it stays as the record of what went out.</span>`}
    </div>
  </li>`;
}

export function DraftList({ drafts, contacts, onChanged }) {
  return html`<ul class="rows">${drafts.map((draft) => html`<${DraftItem} key=${draft.id} draft=${draft} contacts=${contacts} onChanged=${onChanged} />`)}</ul>`;
}

function Guidance({ scaffold }) {
  if (!scaffold) return null;
  const limits = scaffold.limits;
  return html`<aside class="guidance" aria-label="What to write">
    <h3>What to write</h3>
    <p class="small">
      Up to <strong>${num(limits.maxChars)}</strong> characters (aim under ${num(limits.recommendedMaxChars)})${limits.maxWords ? `, ${limits.maxWords} words` : ""}.
      ${limits.subject === "required" ? " Needs a subject." : limits.subject === "none" ? " No subject line." : " Subject optional."} ${limits.note}
    </p>
    <ol class="plain-list small">${scaffold.structure.map((beat) => html`<li>${beat}</li>`)}</ol>
    ${scaffold.factsToCite.length
      ? html`<h4>Facts you can cite</h4>
          <ul class="plain-list small">${scaffold.factsToCite.map((fact) => html`<li key=${fact.id}>${fact.statement}</li>`)}</ul>`
      : null}
    ${scaffold.stories.length
      ? html`<h4>Stories with results</h4>
          <ul class="plain-list small">${scaffold.stories.map((story) => html`<li key=${story.storyId}><strong>${story.title}:</strong> ${story.result}</li>`)}</ul>`
      : null}
    ${scaffold.attachments.length
      ? html`<h4>Attachments</h4>
          <ul class="plain-list small">${scaffold.attachments.map((item) => html`<li key=${item.item}>${item.item}: ${item.ready ? "ready" : "not ready"}. <span class="muted">${item.detail}</span></li>`)}</ul>`
      : null}
    ${scaffold.companyNotes.length
      ? html`<h4>From your research</h4>
          <ul class="plain-list small">${scaffold.companyNotes.map((note, index) => html`<li key=${index}>${note.text}</li>`)}</ul>`
      : null}
    ${scaffold.warnings.length ? html`<ul class="plain-list small text-warn">${scaffold.warnings.map((warning) => html`<li>${warning}</li>`)}</ul>` : null}
    <details class="small"><summary>House rules</summary><ul class="plain-list" style=${{ marginTop: "0.5rem" }}>${scaffold.guidelines.map((rule) => html`<li>${rule}</li>`)}</ul></details>
  </aside>`;
}

function bodyError(error, errors) {
  if (errors.body) return errors.body;
  if (!error) return undefined;
  if (error.code === "too_long") return error.message;
  if (error.code === "unverified_figures") return `Not in your profile or this role's records: ${(error.details?.offending ?? []).join(", ")}. Use figures from the facts you can cite, or drop them.`;
  return undefined;
}

/** The editor: a new draft (`target` with channel, applicationId, contactId, company) or an existing one (`draft`). */
function DraftEditor({ draft, target, limits, onSaved, onDirty }) {
  const { draft: text, set, dirty, reset } = useDraft({ subject: draft?.subject ?? "", body: draft?.body ?? "" });
  const guard = useUnsavedGuard(dirty, onDirty);
  const { busy, error, errors, submit } = useSubmit();
  const [warnings, setWarnings] = useState([]);
  const channel = draft?.channel ?? target.channel;
  const characters = [...text.body].length;
  const words = wordCount(text.body);
  const over = limits ? characters > limits.maxChars : false;
  const soft = limits ? characters > limits.recommendedMaxChars : false;
  const save = async (event) => {
    event.preventDefault();
    const subject = limits?.subject === "none" ? "" : text.subject.trim();
    const result = await submit(() =>
      draft
        ? api.patch(`/api/outreach/${encodeURIComponent(draft.id)}`, { subject, body: text.body })
        : api.post("/api/outreach", { channel, subject, body: text.body, ...pick(target) }),
    );
    if (!result) return;
    guard.release();
    reset({ subject: result.draft.subject, body: result.draft.body });
    setWarnings(result.warnings ?? []);
    toast(draft ? "Draft saved." : "Draft saved. Copy it, send it yourself, then record that you did.");
    onSaved(result.draft);
  };
  return html`<form class="stack" onSubmit=${save} noValidate>
    <${FormError} error=${error} />
    <div class="form-grid">
      ${limits?.subject === "none"
        ? null
        : html`<${TextField} id="draft-subject" label=${limits?.subject === "required" ? "Subject" : "Subject (optional)"} required=${limits?.subject === "required"} wide value=${text.subject} onInput=${set("subject")} maxlength="200" error=${errors.subject ?? (error?.code === "subject_required" ? error.message : undefined)} />`}
      <${TextArea}
        id="draft-body"
        label="Message"
        required
        rows=${channel === "linkedin_connect" ? 4 : 10}
        value=${text.body}
        onInput=${set("body")}
        counter=${limits ? `${num(characters)} / ${num(limits.maxChars)} characters · ${words} words` : `${num(characters)} characters`}
        error=${over ? `Over the ${num(limits.maxChars)}-character limit for this channel.` : bodyError(error, errors)}
        warning=${!over && soft ? `Over the ${num(limits.recommendedMaxChars)} characters that read well here.` : warnings.length ? warnings.join(" ") : undefined}
      />
    </div>
    <div class="form-actions">
      <${Button} type="submit" kind="primary" busy=${busy} disabled=${!text.body.trim() || over}>Save draft</${Button}>
      ${draft && !dirty ? html`<${CopyButton} text=${text.subject ? `${text.subject}\n\n${text.body}` : text.body} label="Copy text" small=${false} />` : null}
      <span class="small muted">Saving checks every figure against your profile. Nothing is sent from here.</span>
    </div>
  </form>`;
}

function pick(target) {
  return Object.fromEntries(["applicationId", "contactId", "company"].filter((key) => target[key]).map((key) => [key, target[key]]));
}

function TargetPicker({ target, setTarget, contacts, applications }) {
  return html`<div class="form-grid">
    <${SelectField}
      id="compose-channel"
      label="Channel"
      value=${target.channel}
      onChange=${(value) => setTarget({ ...target, channel: value })}
      options=${Object.entries(CHANNEL_TEXT).map(([value, text]) => ({ value, label: text }))}
    />
    <${SelectField}
      id="compose-application"
      label="About an application"
      value=${target.applicationId}
      onChange=${(value) => setTarget({ ...target, applicationId: value })}
      any="None"
      options=${applications.map((row) => ({ value: row.id, label: `${row.company}: ${row.title}` }))}
    />
    <${SelectField}
      id="compose-contact"
      label="To"
      value=${target.contactId}
      onChange=${(value) => setTarget({ ...target, contactId: value })}
      any="No one in particular"
      options=${contacts.map((contact) => ({ value: contact.id, label: `${contact.name}, ${contact.company}` }))}
    />
    ${target.applicationId || target.contactId
      ? null
      : html`<${TextField} id="compose-company" label="Company" value=${target.company} onInput=${(value) => setTarget({ ...target, company: value })} maxlength="200" hint="When the draft is about neither an application nor a contact." />`}
  </div>`;
}

/** New drafts start from a target; `draftId` opens one already saved. */
export function OutreachComposer({ draftId, initial, onClose, onChanged }) {
  const [target, setTarget] = useState({ channel: initial.channel ?? "linkedin_connect", applicationId: initial.applicationId ?? "", contactId: initial.contactId ?? "", company: "" });
  const [savedId, setSavedId] = useState(draftId ?? null);
  const [dirty, setDirty] = useState(false);
  const existing = useResource(() => (savedId ? api.get(`/api/outreach/${encodeURIComponent(savedId)}`) : Promise.resolve(null)), [savedId]);
  const contacts = useResource(() => api.get("/api/contacts", { limit: 500 }), []);
  const applications = useResource(() => api.get("/api/applications", { pageSize: 200 }), []);
  const company = useDebounced(target.company.trim(), 400);
  const ready = Boolean(target.applicationId || target.contactId || company);
  const scaffold = useResource(
    () => (!savedId && ready ? api.get("/api/outreach/scaffold", { channel: target.channel, applicationId: target.applicationId, contactId: target.contactId, company }) : Promise.resolve(null)),
    [savedId, target.channel, target.applicationId, target.contactId, company],
  );
  const draft = existing.data?.draft ?? null;
  useEffect(() => {
    if (draftId && draftId !== savedId) setSavedId(draftId);
  }, [draftId]);
  const contactList = contacts.data?.contacts ?? [];
  const contact = draft ? contactList.find((entry) => entry.id === draft.contactId) : null;
  return html`<${EditorDrawer}
    wide
    dirty=${dirty}
    title=${draft ? `${CHANNEL_TEXT[draft.channel] ?? label(draft.channel)} to ${contact ? contact.name : draft.company}` : "Write a draft"}
    sub=${draft ? `${draft.company} · ${draft.status === "sent_by_user" ? "sent by you" : label(draft.status).toLowerCase()}` : "You send it yourself; nothing is sent from here"}
    onClose=${onClose}
  >
    ${existing.error ? html`<div class="drawer__section"><${ErrorNotice} error=${existing.error} onRetry=${existing.reload} /></div>` : null}
    ${savedId && !draft && !existing.error ? html`<div class="drawer__section"><${Skeleton} lines=${6} /></div>` : null}
    ${!savedId
      ? html`<section class="drawer__section stack">
          <${TargetPicker} target=${target} setTarget=${setTarget} contacts=${contactList} applications=${applications.data?.rows ?? []} />
          ${scaffold.error ? html`<${ErrorNotice} error=${scaffold.error} onRetry=${scaffold.reload} />` : null}
        </section>`
      : null}
    ${draft && draft.status !== "draft"
      ? html`<section class="drawer__section">
          <p class="notice">${draft.status === "sent_by_user" ? "You sent this draft; it stays as the record of what went out." : "This draft is discarded. Restore it to drafts to edit it."}</p>
          <pre class="draft__text" tabindex="0">${draft.body}</pre>
        </section>`
      : null}
    ${(draft && draft.status === "draft") || (!savedId && ready)
      ? html`<section class="drawer__section composer">
          <div class="composer__editor">
            <${DraftEditor}
              key=${draft?.id ?? "new"}
              draft=${draft}
              target=${target}
              limits=${draft ? existing.data.limits : scaffold.data?.limits}
              onDirty=${setDirty}
              onSaved=${(saved) => {
                onChanged();
                if (!savedId) {
                  setSavedId(saved.id);
                  setQuery({ compose: undefined, draft: saved.id, to: undefined, app: undefined, channel: undefined });
                } else existing.reload({ quiet: true });
              }}
            />
          </div>
          ${draft ? null : scaffold.loading && !scaffold.data ? html`<${Skeleton} lines=${6} />` : html`<${Guidance} scaffold=${scaffold.data} />`}
        </section>`
      : !savedId
        ? html`<section class="drawer__section"><p class="small muted">Choose an application, a contact or a company to see what to write and the limits that apply.</p></section>`
        : null}
  </${EditorDrawer}>`;
}
