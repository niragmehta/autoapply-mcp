import { api } from "../api.js";
import { DataTable } from "../components/table.js";
import { CopyButton, Empty, ErrorNotice, ExternalLink, PageHead, Plate, Segmented, Skeleton } from "../components/ui.js";
import { label } from "../lib/format.js";
import { html, useEffect, useState } from "../lib/html.js";
import { useDebounced, useResource, useTitle } from "../lib/hooks.js";
import { setQuery } from "../lib/router.js";
import { useMeta } from "../lib/store.js";
import { ContactDrawer, KIND_TEXT } from "./contact-editor.js";
import { DraftList, OutreachComposer } from "./outreach.js";

/**
 * People found in public sources, and the drafts you write to them. Drafts
 * are copied and sent by you; "I sent it" records that you did.
 */

const DRAFT_VIEWS = [
  { value: "draft", label: "To send" },
  { value: "sent_by_user", label: "Sent by you" },
  { value: "discarded", label: "Discarded" },
];

export default function Contacts({ query }) {
  useTitle("Contacts and outreach");
  const [search, setSearch] = useState(query.get("company") ?? "");
  const settled = useDebounced(search.trim(), 300);
  useEffect(() => {
    if (settled !== (query.get("company") ?? "")) setQuery({ company: settled });
  }, [settled]);
  const kind = query.get("kind") ?? "";
  const outreach = DRAFT_VIEWS.some((entry) => entry.value === query.get("outreach")) ? query.get("outreach") : "draft";
  const openContact = query.get("contact");
  const compose = query.get("compose");
  const openDraft = query.get("draft");
  const kinds = useMeta().data?.career?.contactKinds ?? Object.keys(KIND_TEXT);
  const contacts = useResource(() => api.get("/api/contacts", { company: settled, kind, limit: 500 }), [settled, kind]);
  const allContacts = useResource(() => api.get("/api/contacts", { limit: 500 }), []);
  const drafts = useResource(() => api.get("/api/outreach", { status: outreach, limit: 200 }), [outreach]);
  const refresh = () => {
    contacts.reload({ quiet: true });
    allContacts.reload({ quiet: true });
    drafts.reload({ quiet: true });
  };
  const columns = [
    { key: "name", label: "Name", render: (row) => html`<span class="cell-main">${row.name}</span><span class="cell-sub">${row.role || "-"}</span>` },
    { key: "company", label: "Company", render: (row) => row.company },
    { key: "kind", label: "Kind", render: (row) => html`<${Plate} text=${KIND_TEXT[row.kind]?.replace(/ \(.*\)$/, "") ?? label(row.kind)} tone="muted" />` },
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
  return html`<div>
    <${PageHead}
      title="Contacts and outreach"
      sub="People found in public sources, and the notes you write to them. You send every message yourself."
      actions=${html`<a class="btn" href="/contacts?contact=new">Add contact</a><a class="btn btn--primary" href="/contacts?compose=1">Write a draft</a>`}
    />
    <section aria-labelledby="contacts-title">
      <div class="section__head"><h2 id="contacts-title">Contacts</h2></div>
      <div class="filters" role="search" aria-label="Filter contacts">
        <div class="field">
          <label class="field__label" for="contacts-company">Company</label>
          <input id="contacts-company" class="input input--search" type="search" placeholder="Every company" data-search value=${search} onInput=${(event) => setSearch(event.currentTarget.value)} />
        </div>
        <div class="field">
          <label class="field__label" for="contacts-kind">Kind</label>
          <select id="contacts-kind" class="select" value=${kind} onChange=${(event) => setQuery({ kind: event.currentTarget.value })}>
            <option value="">Any</option>
            ${kinds.map((entry) => html`<option value=${entry}>${KIND_TEXT[entry]?.replace(/ \(.*\)$/, "") ?? label(entry)}</option>`)}
          </select>
        </div>
      </div>
      ${contacts.error ? html`<${ErrorNotice} error=${contacts.error} onRetry=${contacts.reload} />` : null}
      <${DataTable}
        caption="Contacts"
        columns=${columns}
        rows=${contacts.data?.contacts}
        rowKey=${(row) => row.id}
        loading=${contacts.loading}
        selectedKey=${openContact}
        onOpen=${(row) => setQuery({ contact: row.id }, { replace: false })}
        empty=${html`<${Empty} title=${settled || kind ? "No contact matches" : "No contacts yet"} action=${html`<a class="btn" href="/contacts?contact=new">Add a contact</a>`}>
          Recruiters, hiring managers and peers you find in public sources, each with where you found them.
        </${Empty}>`}
      />
    </section>
    <section class="section" aria-labelledby="outreach-title">
      <div class="section__head">
        <h2 id="outreach-title">Drafts</h2>
        <${Segmented} legend="Drafts to show" hideLegend value=${outreach} onChange=${(value) => setQuery({ outreach: value === "draft" ? undefined : value })} options=${DRAFT_VIEWS} />
      </div>
      ${drafts.error ? html`<${ErrorNotice} error=${drafts.error} onRetry=${drafts.reload} />` : null}
      ${drafts.loading && !drafts.data ? html`<div class="panel panel--pad"><${Skeleton} lines=${3} /></div>` : null}
      ${drafts.data?.drafts.length
        ? html`<${DraftList} drafts=${drafts.data.drafts} contacts=${allContacts.data?.contacts ?? []} onChanged=${refresh} />`
        : drafts.data
          ? html`<div class="panel"><${Empty}
              title=${outreach === "draft" ? "No drafts to send" : outreach === "sent_by_user" ? "Nothing sent yet" : "No discarded drafts"}
              action=${outreach === "draft" ? html`<a class="btn" href="/contacts?compose=1">Write a draft</a>` : null}
            >${outreach === "draft" ? "Drafts are checked against your profile when saved; copy one and send it yourself." : null}</${Empty}></div>`
          : null}
    </section>
    ${openContact
      ? html`<${ContactDrawer} key=${openContact} contactId=${openContact} company=${query.get("for") ?? ""} onClose=${() => setQuery({ contact: undefined, for: undefined })} onChanged=${(saved) => {
          refresh();
          if (openContact === "new" && saved?.id) setQuery({ contact: saved.id, for: undefined });
        }} />`
      : null}
    ${compose || openDraft
      ? html`<${OutreachComposer}
          draftId=${openDraft}
          initial=${{ channel: query.get("channel") ?? undefined, applicationId: query.get("app") ?? undefined, contactId: query.get("to") ?? undefined }}
          onClose=${() => setQuery({ compose: undefined, draft: undefined, app: undefined, channel: undefined, to: undefined })}
          onChanged=${refresh}
        />`
      : null}
  </div>`;
}
