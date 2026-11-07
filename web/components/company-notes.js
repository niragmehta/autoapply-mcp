import { api } from "../api.js";
import { dateTime, label } from "../lib/format.js";
import { html, useEffect, useRef, useState } from "../lib/html.js";
import { useAction, useResource } from "../lib/hooks.js";
import { toast, useMeta } from "../lib/store.js";
import { safeHref } from "../lib/urls.js";
import { DeleteAction } from "./confirm.js";
import { FormError, ListInput, SelectField, TextArea, TextField, useDraft, useSubmit, useUnsavedGuard } from "./form.js";
import { Button, Empty, ErrorNotice, ExternalLink, Plate, Skeleton } from "./ui.js";

/**
 * Company research notes, wherever a company comes up: its job, its
 * application, its interviews and the research page. Research, culture, pay
 * and news notes cite where they came from; red flags may not.
 */

const CITED = new Set(["research", "culture", "comp", "news"]);

export function NoteSources({ sources }) {
  if (!sources?.length) return null;
  return html`<p class="small">Sources: ${sources.map((source, index) => {
    const href = safeHref(source);
    return html`${index ? ", " : ""}${href ? html`<${ExternalLink} href=${href}>${new URL(href).hostname}</${ExternalLink}>` : source}`;
  })}</p>`;
}

/** Create (no `note`) or edit a note. `company` fixes the company when the note is written from a company's page; `defaultCompany` only prefills it. */
export function NoteForm({ note, company, defaultCompany, onSaved, onCancel, idPrefix = "note" }) {
  const kinds = useMeta().data?.career?.noteKinds ?? ["research", "culture", "comp", "news", "redflag"];
  const { draft, set, dirty } = useDraft({
    company: note?.company ?? company ?? defaultCompany ?? "",
    kind: note?.kind ?? "research",
    content: note?.content ?? "",
    sources: note?.sources ?? [],
  });
  const guard = useUnsavedGuard(dirty);
  const { busy, error, errors, submit } = useSubmit();
  const save = async (event) => {
    event.preventDefault();
    const result = await submit(() =>
      note ? api.patch(`/api/company-notes/${encodeURIComponent(note.id)}`, draft) : api.post("/api/company-notes", draft),
    );
    if (!result) return;
    guard.release();
    const warning = result.warnings?.[0];
    toast(warning ? `Saved, with a warning: ${warning}` : note ? "Note saved." : "Note added.", { tone: warning ? "bad" : "ok" });
    onSaved(result.note);
  };
  const cited = CITED.has(draft.kind);
  const sourcesError = errors.sources ?? (error?.code === "sources_required" || error?.code === "invalid_source" ? error.message : undefined);
  return html`<form class="note-form stack" onSubmit=${save} noValidate>
    <${FormError} error=${error} />
    <div class="form-grid">
      ${company
        ? null
        : html`<${TextField} id=${`${idPrefix}-company`} label="Company" required value=${draft.company} onInput=${set("company")} error=${errors.company} maxlength="200" />`}
      <${SelectField}
        id=${`${idPrefix}-kind`}
        label="Kind"
        value=${draft.kind}
        onChange=${set("kind")}
        options=${kinds.map((kind) => ({ value: kind, label: kind === "redflag" ? "Red flag" : kind === "comp" ? "Pay" : label(kind) }))}
        error=${errors.kind}
      />
      <${TextArea} id=${`${idPrefix}-content`} label="Note" required rows=${4} value=${draft.content} onInput=${set("content")} error=${errors.content} maxlength="20000" />
      <${ListInput}
        id=${`${idPrefix}-sources`}
        label=${cited ? "Sources (at least one)" : "Sources (optional)"}
        lines
        values=${draft.sources}
        onChange=${set("sources")}
        hint="One per line: a link, or a short citation such as 'Recruiter call, 2026-11-02'."
        error=${sourcesError}
      />
    </div>
    <div class="form-actions">
      <${Button} type="submit" kind="primary" busy=${busy}>${note ? "Save note" : "Add note"}</${Button}>
      <${Button} kind="ghost" onClick=${() => {
        guard.release();
        onCancel();
      }}>Cancel</${Button}>
    </div>
  </form>`;
}

function NoteItem({ note, showCompany, onChanged, focused }) {
  const [editing, setEditing] = useState(false);
  const [busy, run] = useAction(toast);
  const item = useRef(null);
  useEffect(() => {
    // A link straight to this note (from search) brings it into view once.
    if (focused) item.current?.scrollIntoView({ block: "center" });
  }, [focused]);
  if (editing) {
    return html`<li class="note">
      <${NoteForm} note=${note} idPrefix=${`note-${note.id}`} onSaved=${() => {
        setEditing(false);
        onChanged();
      }} onCancel=${() => setEditing(false)} />
    </li>`;
  }
  const remove = async () => {
    const result = await run(() => api.del(`/api/company-notes/${encodeURIComponent(note.id)}`), { success: "Note deleted." });
    if (result) onChanged();
  };
  return html`<li class=${`note${focused ? " note--focus" : ""}`} id=${`note-${note.id}`} ref=${item} aria-current=${focused ? "true" : undefined}>
    <div class="row">
      ${showCompany ? html`<span class="cell-main">${note.company}</span>` : null}
      <${Plate} text=${note.kind === "redflag" ? "Red flag" : note.kind === "comp" ? "Pay" : label(note.kind)} tone=${note.kind === "redflag" ? "warn" : "muted"} />
      <span class="small muted">${dateTime(note.createdAt)}</span>
    </div>
    <p class="note__text">${note.content}</p>
    <${NoteSources} sources=${note.sources} />
    <div class="row note__actions">
      <${Button} small kind="ghost" onClick=${() => setEditing(true)}>Edit</${Button}>
      <${DeleteAction} what="this note" consequence="The note and its sources are removed." busy=${busy} onDelete=${remove} />
    </div>
  </li>`;
}

export function NoteList({ notes, showCompany, onChanged, focusId }) {
  return html`<ul class="rows notes">${notes.map((note) => html`<${NoteItem} key=${note.id} note=${note} showCompany=${showCompany} onChanged=${onChanged} focused=${note.id === focusId} />`)}</ul>`;
}

/** Notes for one company, with an inline form to add one. */
export function CompanyNotes({ company, heading = "Company research", headingLevel = 3 }) {
  const notes = useResource(() => api.get("/api/company-notes", { company, limit: 50 }), [company]);
  const [adding, setAdding] = useState(false);
  const Heading = headingLevel === 2 ? "h2" : "h3";
  return html`<section class="drawer__section company-notes">
    <div class="section__head">
      <${Heading}>${heading}</${Heading}>
      ${adding ? null : html`<${Button} small onClick=${() => setAdding(true)}>Add note</${Button}>`}
    </div>
    ${adding
      ? html`<div class="panel panel--pad"><${NoteForm} company=${company} idPrefix=${`add-note-${company.replace(/\W+/g, "-")}`} onSaved=${() => {
          setAdding(false);
          notes.reload({ quiet: true });
        }} onCancel=${() => setAdding(false)} /></div>`
      : null}
    ${notes.error ? html`<${ErrorNotice} error=${notes.error} onRetry=${notes.reload} />` : null}
    ${notes.loading && !notes.data ? html`<${Skeleton} lines=${2} />` : null}
    ${notes.data && notes.data.count === 0 && !adding
      ? html`<${Empty} title=${`No notes on ${company} yet`}>Research, culture, pay signals, news and red flags you note here show up on its jobs, applications and interviews.</${Empty}>`
      : null}
    ${notes.data?.count ? html`<${NoteList} notes=${notes.data.notes} onChanged=${() => notes.reload({ quiet: true })} />` : null}
  </section>`;
}
