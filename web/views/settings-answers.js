import { api } from "../api.js";
import { DataTable } from "../components/table.js";
import { Empty, ErrorNotice, Plate } from "../components/ui.js";
import { html, useEffect, useState } from "../lib/html.js";
import { useDebounced, useResource } from "../lib/hooks.js";
import { setQuery } from "../lib/router.js";
import { AnswerEditor, MODE_SHORT } from "./answer-editor.js";

/**
 * The answers library: every recurring question in profile.answers and how it
 * is answered. Locked answers and the AI-policy question are marked in the list.
 */

function AnswerCell({ row }) {
  if (row.aiPolicy) return html`<span class="muted">Always asks you</span>`;
  if (row.mode === "ask") return html`<span class="muted">Asks you</span>`;
  if (row.mode === "skip") return html`<span class="muted">Left blank on purpose</span>`;
  return html`<span class="cell-clamp">${row.answer}</span>`;
}

const columns = [
  {
    key: "label",
    label: "Question",
    render: (row) => html`<span class="cell-main">${row.label}</span><span class="cell-sub mono">${row.key}</span>`,
  },
  { key: "answer", label: "Answer", render: (row) => html`<${AnswerCell} row=${row} />` },
  {
    key: "mode",
    label: "Used",
    render: (row) => html`<${Plate} text=${row.aiPolicy ? "Asks you" : MODE_SHORT[row.mode]} tone=${row.mode === "auto" && !row.aiPolicy ? "ok" : "muted"} />`,
  },
  {
    key: "lock",
    label: "Lock",
    render: (row) =>
      row.aiPolicy
        ? html`<${Plate} text="AI policy" tone="info" />`
        : row.lock
          ? html`<span class="lock-cell"><${Plate} text="Locked" tone="held" /><span class="cell-sub">${row.lock.labels.join(", ")}</span></span>`
          : html`<span class="muted">-</span>`,
  },
];

export function SavedNotice({ saved, onDismiss }) {
  if (!saved) return null;
  return html`<div class=${`notice${saved.reloaded ? "" : " notice--bad"}`} role="status">
    <p class="notice__title">${saved.reloaded ? `Saved to ${saved.file}` : "Saved, but the dashboard could not reload its configuration"}</p>
    ${saved.reloadError ? html`<p>${saved.reloadError}</p>` : null}
    ${saved.backup ? html`<p>The previous version is kept at <span class="mono">${saved.backup}</span>.</p>` : null}
    <p>${saved.mcpReload}</p>
    <div><button type="button" class="link-button" onClick=${onDismiss}>Dismiss</button></div>
  </div>`;
}

export function AnswersLibrary({ query }) {
  const [search, setSearch] = useState(query.get("q") ?? "");
  const settled = useDebounced(search.trim(), 250);
  useEffect(() => {
    if (settled !== (query.get("q") ?? "")) setQuery({ q: settled });
  }, [settled]);
  const group = query.get("group") ?? "";
  const open = query.get("answer");
  const [saved, setSaved] = useState(null);
  const list = useResource(() => api.get("/api/settings/answers", { q: settled, group }), [settled, group]);
  const groups = list.data?.groups ?? [];
  const lockedCount = groups.reduce((sum, entry) => sum + entry.count, 0);
  const afterSave = (result) => {
    setSaved(result.saved);
    list.reload({ quiet: true });
  };
  return html`<div class="stack">
    <${SavedNotice} saved=${saved} onDismiss=${() => setSaved(null)} />
    <div class="filters" role="search" aria-label="Filter answers">
      <div class="field">
        <label class="field__label" for="answers-q">Search</label>
        <input id="answers-q" class="input input--search" type="search" placeholder="Question, phrase or answer" data-search value=${search} onInput=${(event) => setSearch(event.currentTarget.value)} />
      </div>
      <div class="field">
        <label class="field__label" for="answers-group">Show</label>
        <select id="answers-group" class="select" value=${group} onChange=${(event) => setQuery({ group: event.currentTarget.value })}>
          <option value="">Every answer</option>
          <option value="locked">Locked${lockedCount ? ` (${lockedCount})` : ""}</option>
          ${groups.map((entry) => html`<option value=${entry.id}>${entry.label}${entry.count ? ` (${entry.count})` : ""}</option>`)}
          <option value="ai-policy">AI policy</option>
        </select>
      </div>
      <div class="filters__end">
        <a class="btn btn--primary" href="/settings?answer=new">Add answer</a>
      </div>
    </div>
    ${list.data ? html`<p class="small muted" aria-live="polite">${list.data.count} of ${list.data.total} answers. Locked answers change only after you unlock them; the AI-policy question always asks you.</p>` : null}
    ${list.error ? html`<${ErrorNotice} error=${list.error} onRetry=${list.reload} />` : null}
    <${DataTable}
      caption="Answers library"
      columns=${columns}
      rows=${list.data?.answers}
      rowKey=${(row) => row.key}
      loading=${list.loading}
      selectedKey=${open}
      onOpen=${(row) => setQuery({ answer: row.key }, { replace: false })}
      empty=${html`<${Empty} title=${settled || group ? "No answer matches" : "No answers yet"} action=${html`<a class="btn" href="/settings?answer=new">Add an answer</a>`}>
        Answers to the questions forms keep asking, each with the phrases that find it and whether it may fill in without asking you.
      </${Empty}>`}
    />
    ${open
      ? html`<${AnswerEditor}
          key=${open}
          answerKey=${open}
          aiPolicyCount=${list.data?.aiPolicyCount ?? 0}
          onClose=${() => setQuery({ answer: undefined })}
          onSaved=${(result) => {
            afterSave(result);
            if (result.answer.key !== open) setQuery({ answer: result.answer.key });
          }}
          onDeleted=${(result) => {
            afterSave(result);
            setQuery({ answer: undefined });
          }}
        />`
      : null}
  </div>`;
}
