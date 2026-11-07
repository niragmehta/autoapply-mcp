import { api } from "../api.js";
import { DataTable, Pager } from "../components/table.js";
import { Button, Empty, ErrorNotice, PageHead, Plate, TierPlate } from "../components/ui.js";
import { ago, label, num } from "../lib/format.js";
import { html, useEffect, useState } from "../lib/html.js";
import { useDebounced, useResource, useTitle } from "../lib/hooks.js";
import { listParam, setQuery } from "../lib/router.js";
import { useStatus } from "../lib/store.js";
import { ApplicationDetail } from "./application-detail.js";

/** Every application by status, opening into its packet and decisions. */

const PAGE_SIZE = 50;

const STATUS_FILTERS = [
  { value: "", label: "All" },
  { value: "needs_human", label: "Needs human" },
  { value: "awaiting_approval,approved", label: "Ready" },
  { value: "awaiting_approval", label: "Awaiting approval" },
  { value: "approved", label: "Approved" },
  { value: "submitted", label: "Submitted" },
  { value: "failed", label: "Failed" },
  { value: "skipped", label: "Skipped" },
];

export default function Applications({ query }) {
  useTitle("Applications");
  const statuses = listParam(query, "status");
  const statusKey = statuses.join(",");
  const q = query.get("q") ?? "";
  const sort = query.get("sort") ?? "created";
  const dir = query.get("dir") ?? "desc";
  const page = Math.max(1, Number(query.get("page") ?? 1) || 1);
  const openApp = query.get("app");
  const byStatus = useStatus().data?.applications?.byStatus ?? {};
  const [search, setSearch] = useState(q);
  const settled = useDebounced(search, 300);

  useEffect(() => {
    if (settled !== q) setQuery({ q: settled, page: undefined });
  }, [settled]);

  const request = { status: statuses, q, sort, dir, page, pageSize: PAGE_SIZE };
  const list = useResource(() => api.get("/api/applications", request), [JSON.stringify(request)]);
  const total = Object.values(byStatus).reduce((sum, count) => sum + count, 0);
  const countFor = (value) => (value === "" ? total : value.split(",").reduce((sum, part) => sum + (byStatus[part] ?? 0), 0));

  const columns = [
    { key: "status", label: "Status", sort: "status", defaultDir: "asc", render: (row) => html`<${Plate} value=${row.status} />` },
    {
      key: "role",
      label: "Company and role",
      sort: "company",
      defaultDir: "asc",
      render: (row) => html`<span class="cell-main">${row.company}</span><span class="cell-sub">${row.title}</span>`,
    },
    {
      key: "fit",
      label: "Score",
      sort: "score",
      numeric: true,
      render: (row) => html`<span class="row" style=${{ justifyContent: "flex-end", flexWrap: "nowrap" }}>${row.score === null ? "-" : num(Math.round(row.score))} <${TierPlate} tier=${row.tier} /></span>`,
    },
    {
      key: "unresolved",
      label: "Blocked",
      numeric: true,
      render: (row) => (row.unresolved ? html`<${Plate} text=${`${row.unresolved} to answer`} tone="held" />` : html`<span class="muted">-</span>`),
    },
    { key: "created", label: "Prepared", sort: "created", render: (row) => html`<span class="nowrap small">${ago(row.createdAt)}</span>` },
    {
      key: "submitted",
      label: "Submitted",
      sort: "submitted",
      render: (row) => html`<span class="nowrap small">${row.submittedAt ? ago(row.submittedAt) : "-"}</span>${row.submissionMode ? html`<span class="cell-sub">${label(row.submissionMode)}</span>` : null}`,
    },
    {
      key: "outcome",
      label: "Outcome",
      render: (row) => (row.latestOutcome ? html`<${Plate} value=${row.latestOutcome.status} />` : html`<span class="muted">-</span>`),
    },
  ];

  const empty = statuses.length || q
    ? html`<${Empty} title="No applications match" action=${html`<${Button} small onClick=${() => { setSearch(""); setQuery({ status: undefined, q: undefined, page: undefined }); }}>Show all</${Button}>`}>
        Try another status or search term.
      </${Empty}>`
    : html`<${Empty} title="No applications yet" action=${html`<a class="btn btn--primary" href="/jobs?decision=accept&hasApplication=no">Find jobs to prepare</a>`}>
        Prepare an accepted job, or start a prepare run, and its application appears here for review.
      </${Empty}>`;

  return html`<div>
    <${PageHead} title="Applications" sub=${list.data ? `${num(list.data.total)} shown` : "Prepared, approved and sent"} />
    <div class="filters" role="search" aria-label="Filter applications">
      <fieldset>
        <legend>Status</legend>
        <div class="toggles" role="group">
          ${STATUS_FILTERS.map(
            (filter) => html`<button
              type="button"
              aria-pressed=${statusKey === filter.value ? "true" : "false"}
              onClick=${() => setQuery({ status: filter.value || undefined, page: undefined })}
            >
              ${filter.label}<span class="count">${num(countFor(filter.value))}</span>
            </button>`,
          )}
        </div>
      </fieldset>
      <div class="field">
        <label class="field__label" for="apps-q">Search</label>
        <input id="apps-q" class="input input--search" type="search" placeholder="Company, role or id" value=${search} data-search onInput=${(event) => setSearch(event.currentTarget.value)} />
      </div>
    </div>
    ${list.error ? html`<${ErrorNotice} error=${list.error} onRetry=${list.reload} />` : null}
    <${DataTable}
      caption="Applications"
      columns=${columns}
      rows=${list.data?.rows}
      rowKey=${(row) => row.id}
      sort=${sort}
      dir=${dir}
      onSort=${(nextSort, nextDir) => setQuery({ sort: nextSort, dir: nextDir, page: undefined })}
      onOpen=${(row) => setQuery({ app: row.id }, { replace: false })}
      selectedKey=${openApp}
      loading=${list.loading}
      empty=${empty}
    />
    <${Pager} page=${page} pageSize=${PAGE_SIZE} total=${list.data?.total} onPage=${(next) => setQuery({ page: next }, { replace: false })} />
    ${openApp
      ? html`<${ApplicationDetail} key=${openApp} applicationId=${openApp} onClose=${() => setQuery({ app: undefined })} onChanged=${() => list.reload({ quiet: true })} />`
      : null}
  </div>`;
}
