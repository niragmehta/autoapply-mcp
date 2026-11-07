import { api } from "../api.js";
import { DataTable } from "../components/table.js";
import { Button, CopyButton, Empty, ErrorNotice, ExternalLink, Plate, Segmented, Skeleton } from "../components/ui.js";
import { ago, dateTime, label, num } from "../lib/format.js";
import { html, useEffect, useState } from "../lib/html.js";
import { useAction, useDebounced, useResource } from "../lib/hooks.js";
import { setQuery } from "../lib/router.js";
import { toast } from "../lib/store.js";

/** Story bank, contacts with outreach drafts, and company research: the Interviews page's supporting tabs. */

const STAR = [
  ["situation", "Situation"],
  ["task", "Task"],
  ["action", "Action"],
  ["result", "Result"],
  ["reflection", "Reflection"],
];

export function StoriesTab() {
  const stories = useResource(() => api.get("/api/stories"), []);
  const scaffold = useResource(() => api.get("/api/stories/scaffold"), []);
  const target = scaffold.data?.targetStoryCount;
  const competencies = scaffold.data?.competencies ?? [];
  const covered = competencies.filter((competency) => competency.coveredBy.length > 0).length;
  return html`<div class="split">
    <section aria-labelledby="stories-title">
      <div class="section__head">
        <h2 id="stories-title">Stories</h2>
        <p class="section__note">${stories.data ? `${num(stories.data.count)}${target ? ` of ${target.min} to ${target.max}` : ""} master stories` : ""}</p>
      </div>
      ${stories.error ? html`<${ErrorNotice} error=${stories.error} onRetry=${stories.reload} />` : null}
      ${stories.loading && !stories.data ? html`<div class="panel panel--pad"><${Skeleton} lines=${4} /></div>` : null}
      ${stories.data && stories.data.count === 0
        ? html`<div class="panel"><${Empty} title="No stories yet">Build STAR stories from your verified facts with your agent (story_bank_scaffold, then save_story). They are reused across interviews.</${Empty}></div>`
        : null}
      ${stories.data?.count
        ? html`<ul class="rows">
            ${stories.data.stories.map(
              (story) => html`<li key=${story.id} class="story">
                <details>
                  <summary>${story.title}</summary>
                  <dl class="facts" style=${{ marginTop: "0.75rem" }}>
                    ${STAR.filter(([key]) => story[key]).map(([key, text]) => html`<dt>${text}</dt><dd>${story[key]}</dd>`)}
                  </dl>
                </details>
                <div class="row" style=${{ marginTop: "0.5rem" }}>
                  ${story.skills.map((skill) => html`<${Plate} text=${skill} tone="info" />`)}
                  ${story.tags.map((tag) => html`<${Plate} text=${label(tag)} tone="muted" />`)}
                  ${story.factIds.length ? html`<span class="small muted">cites ${story.factIds.join(", ")}</span>` : null}
                </div>
              </li>`,
            )}
          </ul>`
        : null}
    </section>
    <section aria-labelledby="coverage-title">
      <div class="section__head">
        <h2 id="coverage-title">Coverage</h2>
        <p class="section__note">${competencies.length ? `${covered} of ${competencies.length} competencies` : ""}</p>
      </div>
      ${scaffold.error ? html`<${ErrorNotice} error=${scaffold.error} onRetry=${scaffold.reload} />` : null}
      ${competencies.length
        ? html`<ul class="rows">
            ${competencies.map(
              (competency) => html`<li key=${competency.id} class="coverage-row">
                <span>${competency.label}</span>
                ${competency.coveredBy.length
                  ? html`<${Plate} text=${`${competency.coveredBy.length} ${competency.coveredBy.length === 1 ? "story" : "stories"}`} tone="ok" />`
                  : html`<${Plate} text="No story yet" tone="muted" />`}
              </li>`,
            )}
          </ul>`
        : scaffold.loading
          ? html`<div class="panel panel--pad"><${Skeleton} lines=${4} /></div>`
          : null}
    </section>
  </div>`;
}

function OutreachDraft({ draft, contacts, onChanged }) {
  const [busy, run] = useAction(toast);
  const contact = contacts.find((entry) => entry.id === draft.contactId);
  const mark = (status, success) =>
    run(() => api.post(`/api/outreach/${encodeURIComponent(draft.id)}/mark`, { status }), { success }).then((result) => result && onChanged());
  return html`<li class="followup">
    <div class="followup__head">
      <span>
        <span class="cell-main">${draft.company}${contact ? ` · ${contact.name}` : ""}</span>
        <span class="cell-sub">${label(draft.channel)}${draft.subject ? `: ${draft.subject}` : ""}</span>
      </span>
      <span class="row"><${Plate} value=${draft.status} /><span class="small muted">${ago(draft.updatedAt)}</span></span>
    </div>
    <pre class="draft__text" tabindex="0" aria-label=${`Draft to ${draft.company}`}>${draft.body}</pre>
    <div class="followup__actions">
      ${draft.status === "draft"
        ? html`<${CopyButton} text=${draft.body} label="Copy text" small=${false} />
            <${Button} kind="primary" busy=${busy} onClick=${() => mark("sent_by_user", "Marked as sent by you.")}>I sent it</${Button}>
            <${Button} kind="ghost" busy=${busy} onClick=${() => mark("discarded", "Discarded.")}>Discard</${Button}>`
        : draft.status === "discarded"
          ? html`<${Button} busy=${busy} onClick=${() => mark("draft", "Restored to drafts.")}>Restore to drafts</${Button}>`
          : html`<${CopyButton} text=${draft.body} label="Copy text" small=${false} /><span class="small muted">You sent this one.</span>`}
    </div>
  </li>`;
}

export function ContactsTab({ query }) {
  const status = ["draft", "sent_by_user", "discarded"].includes(query.get("outreach")) ? query.get("outreach") : "draft";
  const contacts = useResource(() => api.get("/api/contacts", { limit: 500 }), []);
  const drafts = useResource(() => api.get("/api/outreach", { status, limit: 200 }), [status]);
  const contactRows = contacts.data?.contacts ?? [];
  const columns = [
    { key: "name", label: "Name", render: (row) => html`<span class="cell-main">${row.name}</span><span class="cell-sub">${row.role || "-"}</span>` },
    { key: "company", label: "Company", render: (row) => row.company },
    { key: "kind", label: "Kind", render: (row) => html`<${Plate} text=${label(row.kind)} tone="muted" />` },
    {
      key: "reach",
      label: "Where",
      render: (row) => html`<span class="stack" style=${{ gap: "0.25rem" }}>
        ${row.profileUrl ? html`<${ExternalLink} href=${row.profileUrl}>Profile</${ExternalLink}>` : null}
        ${row.email ? html`<span class="row" style=${{ flexWrap: "nowrap" }}><span class="mono small">${row.email}</span><${CopyButton} text=${row.email} label="Copy" /></span>` : null}
        ${!row.profileUrl && !row.email ? html`<span class="muted">-</span>` : null}
      </span>`,
    },
    { key: "source", label: "Found at", render: (row) => html`<span class="small muted">${row.source || "-"}</span>` },
  ];
  return html`<div class="stack">
    <section aria-labelledby="contacts-title">
      <div class="section__head"><h2 id="contacts-title">Contacts</h2><p class="section__note">People found in public sources, for follow-ups and outreach</p></div>
      ${contacts.error ? html`<${ErrorNotice} error=${contacts.error} onRetry=${contacts.reload} />` : null}
      <${DataTable}
        caption="Contacts"
        columns=${columns}
        rows=${contacts.data?.contacts}
        rowKey=${(row) => row.id}
        loading=${contacts.loading}
        empty=${html`<${Empty} title="No contacts yet">Your agent saves recruiters and hiring managers it finds in public sources with save_contact.</${Empty}>`}
      />
    </section>
    <section class="section" aria-labelledby="outreach-title">
      <div class="section__head">
        <h2 id="outreach-title">Outreach drafts</h2>
        <${Segmented}
          legend="Outreach drafts to show"
          hideLegend
          value=${status}
          onChange=${(value) => setQuery({ outreach: value === "draft" ? undefined : value })}
          options=${[{ value: "draft", label: "To send" }, { value: "sent_by_user", label: "Sent" }, { value: "discarded", label: "Discarded" }]}
        />
      </div>
      <p class="small muted" style=${{ marginBottom: "0.75rem" }}>Copy a draft and send it yourself; nothing is sent from here.</p>
      ${drafts.error ? html`<${ErrorNotice} error=${drafts.error} onRetry=${drafts.reload} />` : null}
      ${drafts.loading && !drafts.data ? html`<div class="panel panel--pad"><${Skeleton} lines=${3} /></div>` : null}
      ${drafts.data?.drafts.length
        ? html`<ul class="rows">${drafts.data.drafts.map((draft) => html`<${OutreachDraft} key=${draft.id} draft=${draft} contacts=${contactRows} onChanged=${() => drafts.reload({ quiet: true })} />`)}</ul>`
        : drafts.data
          ? html`<div class="panel"><${Empty} title=${status === "draft" ? "No drafts to send" : `No ${label(status).toLowerCase()} drafts`} /></div>`
          : null}
    </section>
  </div>`;
}

function safeLink(value) {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

export function NotesTab({ query }) {
  const [company, setCompany] = useState(query.get("company") ?? "");
  const settled = useDebounced(company.trim(), 300);
  useEffect(() => {
    if (settled !== (query.get("company") ?? "")) setQuery({ company: settled });
  }, [settled]);
  const notes = useResource(() => api.get("/api/company-notes", { company: settled, limit: 200 }), [settled]);
  return html`<div class="stack">
    <div class="filters" role="search" aria-label="Filter research notes">
      <div class="field">
        <label class="field__label" for="notes-company">Company</label>
        <input id="notes-company" class="input input--search" type="search" placeholder="Every company" data-search value=${company} onInput=${(event) => setCompany(event.currentTarget.value)} />
      </div>
    </div>
    ${notes.error ? html`<${ErrorNotice} error=${notes.error} onRetry=${notes.reload} />` : null}
    ${notes.loading && !notes.data ? html`<div class="panel panel--pad"><${Skeleton} lines=${4} /></div>` : null}
    ${notes.data && notes.data.count === 0
      ? html`<div class="panel"><${Empty} title=${settled ? `No notes on ${settled}` : "No research notes yet"}>Your agent saves research, culture, pay and news notes with save_company_note, citing where each came from.</${Empty}></div>`
      : null}
    ${notes.data?.count
      ? html`<ul class="rows">
          ${notes.data.notes.map(
            (note) => html`<li key=${note.id} class="note">
              <div class="row">
                <span class="cell-main">${note.company}</span>
                <${Plate} text=${label(note.kind)} tone=${note.kind === "redflag" ? "warn" : "muted"} />
                <span class="small muted">${dateTime(note.createdAt)}</span>
              </div>
              <p class="note__text">${note.content}</p>
              ${note.sources.length
                ? html`<p class="small">Sources: ${note.sources.map((source, index) => {
                    const href = safeLink(source);
                    return html`${index ? ", " : ""}${href ? html`<${ExternalLink} href=${href}>${new URL(href).hostname}</${ExternalLink}>` : source}`;
                  })}</p>`
                : null}
            </li>`,
          )}
        </ul>`
      : null}
  </div>`;
}
