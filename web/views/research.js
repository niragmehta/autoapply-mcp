import { api } from "../api.js";
import { NoteForm, NoteList } from "../components/company-notes.js";
import { Button, Empty, ErrorNotice, PageHead, Skeleton } from "../components/ui.js";
import { label } from "../lib/format.js";
import { html, useEffect, useState } from "../lib/html.js";
import { useDebounced, useResource, useTitle } from "../lib/hooks.js";
import { setQuery } from "../lib/router.js";
import { useMeta } from "../lib/store.js";

/**
 * Company research: strategy, culture, pay signals, news and red flags,
 * each with where it came from. Notes also show on the company's jobs,
 * applications and interviews.
 */

export default function Research({ query }) {
  useTitle("Company research");
  const [company, setCompany] = useState(query.get("company") ?? "");
  const settled = useDebounced(company.trim(), 300);
  useEffect(() => {
    if (settled !== (query.get("company") ?? "")) setQuery({ company: settled });
  }, [settled]);
  const kind = query.get("kind") ?? "";
  const adding = query.get("note") === "new";
  const kinds = useMeta().data?.career?.noteKinds ?? ["research", "culture", "comp", "news", "redflag"];
  const notes = useResource(() => api.get("/api/company-notes", { company: settled, kind, limit: 200 }), [settled, kind]);
  const kindText = (value) => (value === "redflag" ? "Red flag" : value === "comp" ? "Pay" : label(value));
  return html`<div>
    <${PageHead}
      title="Company research"
      sub="What you learned about each company and where you learned it. Notes show up on its jobs, applications and interviews."
      actions=${adding ? null : html`<a class="btn btn--primary" href=${`/research?note=new${settled ? `&company=${encodeURIComponent(settled)}` : ""}`}>Add a note</a>`}
    />
    ${adding
      ? html`<section class="panel panel--pad" aria-labelledby="new-note-title" style=${{ marginBottom: "1.5rem" }}>
          <h2 id="new-note-title" style=${{ marginBottom: "0.75rem" }}>New note</h2>
          <${NoteForm}
            defaultCompany=${settled}
            idPrefix="research-new"
            onSaved=${(saved) => {
              setQuery({ note: undefined, company: saved.company });
              setCompany(saved.company);
              notes.reload({ quiet: true });
            }}
            onCancel=${() => setQuery({ note: undefined })}
          />
        </section>`
      : null}
    <div class="filters" role="search" aria-label="Filter research notes">
      <div class="field">
        <label class="field__label" for="notes-company">Company</label>
        <input id="notes-company" class="input input--search" type="search" placeholder="Every company" data-search value=${company} onInput=${(event) => setCompany(event.currentTarget.value)} />
      </div>
      <div class="field">
        <label class="field__label" for="notes-kind">Kind</label>
        <select id="notes-kind" class="select" value=${kind} onChange=${(event) => setQuery({ kind: event.currentTarget.value })}>
          <option value="">Any</option>
          ${kinds.map((value) => html`<option value=${value}>${kindText(value)}</option>`)}
        </select>
      </div>
      ${settled || kind
        ? html`<div class="filters__end"><${Button} kind="ghost" small onClick=${() => {
            setCompany("");
            setQuery({ company: undefined, kind: undefined });
          }}>Clear filters</${Button}></div>`
        : null}
    </div>
    ${notes.error ? html`<${ErrorNotice} error=${notes.error} onRetry=${notes.reload} />` : null}
    ${notes.loading && !notes.data ? html`<div class="panel panel--pad"><${Skeleton} lines=${4} /></div>` : null}
    ${notes.data && notes.data.count === 0
      ? html`<div class="panel"><${Empty}
          title=${settled ? `No notes on ${settled}` : kind ? `No ${kindText(kind).toLowerCase()} notes` : "No research notes yet"}
          action=${html`<a class="btn" href=${`/research?note=new${settled ? `&company=${encodeURIComponent(settled)}` : ""}`}>Add a note</a>`}
        >Research, culture and pay notes cite where they came from; red flags can stand on what you saw yourself.</${Empty}></div>`
      : null}
    ${notes.data?.count ? html`<${NoteList} notes=${notes.data.notes} showCompany=${!settled} focusId=${adding ? null : query.get("note")} onChanged=${() => notes.reload({ quiet: true })} />` : null}
  </div>`;
}
