import { api } from "../api.js";
import { DataTable } from "../components/table.js";
import { Button, Empty, ErrorNotice, ExternalLink, PageHead, Plate, Segmented, Skeleton } from "../components/ui.js";
import { ago, label, num, plural } from "../lib/format.js";
import { html, useEffect, useState } from "../lib/html.js";
import { useAction, useResource, useTitle } from "../lib/hooks.js";
import { setQuery } from "../lib/router.js";
import { toast, useStatus } from "../lib/store.js";

/**
 * Where new companies come from: leads from job alerts, funding news and
 * harvested boards, which you can ignore or restore to new (a resolved lead
 * keeps its status); boards a propose run verified for them, saved only when
 * you accept one; and what board harvesting has found.
 */

const RUN_LINKS = [
  ["alerts", "Import job alerts"],
  ["funded", "Read funding news"],
  ["propose", "Propose boards"],
  ["harvest", "Harvest boards"],
];

function ProposedBoard({ proposal, board, onAccepted }) {
  const [tier, setTier] = useState("C");
  const [busy, run] = useAction(toast);
  const status = useStatus();
  const accept = async () => {
    const result = await run(() =>
      api.post("/api/leads/proposals/accept", { proposals: [{ company: proposal.company, ats: board.ats, board: board.board, region: board.region, tier }] }),
    );
    if (!result) return;
    if (result.saved.length) toast(`Saved ${proposal.company} (${label(board.ats)}). Start a discovery run to read its postings.`, { href: "/runs?start=discovery", linkText: "Discovery" });
    else toast(`Not saved: ${result.rejected.map((entry) => entry.reason).join("; ")}`, { tone: "bad" });
    status.reload({ quiet: true });
    onAccepted();
  };
  const tierId = `tier-${proposal.company}-${board.board}`.replace(/[^A-Za-z0-9-]/g, "-");
  return html`<li class="proposal__board">
    <span>
      <span class="cell-main">${label(board.ats)} <span class="mono">${board.board}</span>${board.region === "eu" ? " (EU)" : ""}</span>
      <span class="cell-sub">${plural(board.postings, "posting")} now${board.sampleTitles.length ? `, such as ${board.sampleTitles.slice(0, 3).join("; ")}` : ""}</span>
    </span>
    <span class="row" style=${{ flexWrap: "nowrap" }}>
      <label class="sr-only" for=${tierId}>Tier for ${proposal.company}</label>
      <select id=${tierId} class="select" style=${{ width: "auto" }} value=${tier} onChange=${(event) => setTier(event.currentTarget.value)}>
        <option value="A">Tier A</option>
        <option value="B">Tier B</option>
        <option value="C">Tier C</option>
      </select>
      <${Button} small kind="primary" busy=${busy} onClick=${accept}>Accept board</${Button}>
    </span>
  </li>`;
}

function Proposals() {
  const proposals = useResource(() => api.get("/api/leads/proposals"), []);
  const data = proposals.data;
  if (proposals.error) return html`<${ErrorNotice} error=${proposals.error} onRetry=${proposals.reload} />`;
  if (!data) return html`<div class="panel panel--pad"><${Skeleton} lines=${3} /></div>`;
  return html`<div class="stack">
    ${data.runId
      ? html`<p class="small muted">From <a href=${`/runs?run=${encodeURIComponent(data.runId)}`}>the latest propose run</a>${data.finishedAt ? `, ${ago(data.finishedAt)}` : ""}. Each board is verified again when you accept it; saving a board does not allow submission to it.${data.alreadyTracked ? ` ${plural(data.alreadyTracked, "proposal")} already in companies.json ${data.alreadyTracked === 1 ? "is" : "are"} hidden.` : ""}</p>`
      : null}
    ${data.proposals.length
      ? html`<ul class="rows">
          ${data.proposals.map(
            (proposal) => html`<li key=${proposal.company} class="proposal">
              <div class="row">
                <span class="cell-main">${proposal.company}</span>
                ${proposal.sources.map((source) => html`<${Plate} text=${label(source)} tone="muted" />`)}
                <span class="small muted">${plural(proposal.leadIds.length, "lead")}</span>
              </div>
              <ul class="proposal__boards">${proposal.boards.map((board) => html`<${ProposedBoard} key=${`${board.ats}:${board.board}`} proposal=${proposal} board=${board} onAccepted=${() => proposals.reload({ quiet: true })} />`)}</ul>
            </li>`,
          )}
        </ul>`
      : html`<div class="panel">
          <${Empty} title="No board proposals waiting" action=${html`<a class="btn" href="/runs?start=propose">Propose boards</a>`}>
            A propose run resolves companies from new leads to verified ATS boards; they wait here for you.
          </${Empty}>
        </div>`}
    ${data.unresolved.length
      ? html`<p class="small muted">No public board found for ${data.unresolved.map((entry) => entry.company).join(", ")}. They are checked again after two weeks.</p>`
      : null}
  </div>`;
}

/** Sets leads to ignored or back to new. Resolved leads are never changed; the toast says what was left alone. */
function useLeadStatus(onChanged) {
  const [busy, run] = useAction(toast);
  const status = useStatus();
  const change = async (ids, target) => {
    const result = await run(() => api.post("/api/leads/status", { ids, status: target }));
    if (!result) return;
    const unchanged = ids.length - result.updated - result.missing.length;
    const parts = [`${target === "ignored" ? "Ignored" : "Restored"} ${plural(result.updated, "lead")}${target === "new" && result.updated ? " to new" : ""}.`];
    if (unchanged > 0) parts.push(`${plural(unchanged, "was", "were")} left as ${unchanged === 1 ? "it was" : "they were"}.`);
    if (result.missing.length) parts.push(`${plural(result.missing.length, "was", "were")} not found.`);
    toast(parts.join(" "), { tone: result.updated ? "ok" : "bad" });
    status.reload({ quiet: true });
    onChanged();
  };
  return [busy, change];
}

function LeadsBulkBar({ picked, busy, onChange, onClear }) {
  const toIgnore = picked.filter((lead) => lead.status === "new");
  const toRestore = picked.filter((lead) => lead.status === "ignored");
  return html`<div class="bulkbar" role="region" aria-label="Selected leads">
    <span class="bulkbar__count"><strong>${num(picked.length)}</strong> selected</span>
    ${toIgnore.length ? html`<${Button} busy=${busy} onClick=${() => onChange(toIgnore.map((lead) => lead.id), "ignored")}>Ignore ${num(toIgnore.length)}</${Button}>` : null}
    ${toRestore.length ? html`<${Button} busy=${busy} onClick=${() => onChange(toRestore.map((lead) => lead.id), "new")}>Restore ${num(toRestore.length)} to new</${Button}>` : null}
    <${Button} kind="ghost" small onClick=${onClear}>Clear selection</${Button}>
  </div>`;
}

function Leads({ query }) {
  const status = ["new", "resolved", "ignored", "all"].includes(query.get("lead")) ? query.get("lead") : "new";
  const leads = useResource(() => api.get("/api/leads", { status: status === "all" ? "" : status, limit: 200 }), [status]);
  const [selected, setSelected] = useState(() => new Set());
  useEffect(() => setSelected(new Set()), [status]);
  const [busy, change] = useLeadStatus(() => {
    setSelected(new Set());
    leads.reload({ quiet: true });
  });
  const counts = leads.data?.counts ?? [];
  const total = (wanted) => counts.filter((entry) => wanted === "all" || entry.status === wanted).reduce((sum, entry) => sum + entry.count, 0);
  const rows = leads.data?.leads ?? [];
  const changeable = rows.filter((lead) => lead.status !== "resolved");
  const picked = rows.filter((lead) => selected.has(lead.id));
  const allPicked = changeable.length > 0 && changeable.every((lead) => selected.has(lead.id));
  const toggle = (id, on) => {
    const next = new Set(selected);
    if (on) next.add(id);
    else next.delete(id);
    setSelected(next);
  };
  const columns = [
    {
      key: "pick",
      label: changeable.length
        ? html`<input type="checkbox" class="pick" aria-label="Select every new or ignored lead shown" checked=${allPicked} onChange=${(event) => setSelected(event.currentTarget.checked ? new Set(changeable.map((lead) => lead.id)) : new Set())} />`
        : html`<span class="sr-only">Select</span>`,
      render: (row) =>
        row.status === "resolved"
          ? html`<span class="sr-only">Resolved leads keep their status</span>`
          : html`<input type="checkbox" class="pick" aria-label=${`Select ${row.company || "lead"}${row.title ? `: ${row.title}` : ""}`} checked=${selected.has(row.id)} onChange=${(event) => toggle(row.id, event.currentTarget.checked)} />`,
    },
    { key: "company", label: "Company", render: (row) => html`<span class="cell-main">${row.company || "-"}</span><span class="cell-sub">${row.title || ""}</span>` },
    { key: "source", label: "Source", render: (row) => html`<${Plate} text=${label(row.source)} tone="muted" />` },
    { key: "where", label: "Location", render: (row) => html`<span class="small">${row.location || "-"}</span>` },
    { key: "found", label: "Found", render: (row) => html`<span class="nowrap small">${ago(row.publishedAt ?? row.foundAt)}</span>` },
    { key: "status", label: "Status", render: (row) => html`<${Plate} value=${row.status} />${row.resolvedBoard ? html`<span class="cell-sub mono">${row.resolvedBoard}</span>` : null}` },
    { key: "link", label: "Link", render: (row) => (row.url ? html`<${ExternalLink} href=${row.url}>Open</${ExternalLink}>` : html`<span class="muted">-</span>`) },
    {
      key: "act",
      label: html`<span class="sr-only">Action</span>`,
      render: (row) =>
        row.status === "new"
          ? html`<${Button} small kind="ghost" busy=${busy} label=${`Ignore ${row.company || "this lead"}`} onClick=${() => change([row.id], "ignored")}>Ignore</${Button}>`
          : row.status === "ignored"
            ? html`<${Button} small kind="ghost" busy=${busy} label=${`Restore ${row.company || "this lead"} to new`} onClick=${() => change([row.id], "new")}>Restore</${Button}>`
            : null,
    },
  ];
  return html`<div class="stack">
    <${Segmented}
      legend="Lead status"
      hideLegend
      value=${status}
      onChange=${(value) => setQuery({ lead: value === "new" ? undefined : value })}
      options=${["new", "resolved", "ignored", "all"].map((value) => ({ value, label: value === "all" ? "All" : label(value), count: leads.data ? num(total(value)) : undefined }))}
    />
    ${leads.error ? html`<${ErrorNotice} error=${leads.error} onRetry=${leads.reload} />` : null}
    ${picked.length ? html`<${LeadsBulkBar} picked=${picked} busy=${busy} onChange=${change} onClear=${() => setSelected(new Set())} />` : null}
    <${DataTable}
      caption="Leads"
      columns=${columns}
      rows=${leads.data?.leads}
      rowKey=${(row) => row.id}
      loading=${leads.loading}
      empty=${html`<${Empty} title=${status === "new" ? "No new leads" : `No ${status === "all" ? "" : `${label(status).toLowerCase()} `}leads`}>Import job alerts or read funding news to find companies that are hiring.</${Empty}>`}
    />
    ${status !== "new" && rows.some((lead) => lead.status === "resolved")
      ? html`<p class="small muted">Resolved leads already have a board in companies.json, so they keep their status.</p>`
      : null}
  </div>`;
}

function Harvest() {
  const harvest = useResource(() => api.get("/api/harvest"), []);
  const data = harvest.data;
  if (harvest.error) return html`<${ErrorNotice} error=${harvest.error} onRetry=${harvest.reload} />`;
  if (!data) return html`<div class="panel panel--pad"><${Skeleton} lines=${3} /></div>`;
  const byStatus = new Map();
  for (const entry of data.boards) byStatus.set(entry.status, (byStatus.get(entry.status) ?? 0) + entry.count);
  return html`<div class="stack">
    <p class="small">
      ${data.boards.length
        ? [...byStatus.entries()].map(([status, count], index) => html`${index ? " · " : ""}<strong>${num(count)}</strong> ${label(status).toLowerCase()}`)
        : "Nothing harvested yet."}
    </p>
    <${DataTable}
      caption="Harvested boards with fitting roles"
      columns=${[
        { key: "board", label: "Board", render: (row) => html`<span class="cell-main">${row.company || row.board}</span><span class="cell-sub">${label(row.ats)} <span class="mono">${row.board}</span></span>` },
        { key: "matching", label: "Fitting roles", numeric: true, render: (row) => num(row.matching) },
        { key: "postings", label: "Postings", numeric: true, render: (row) => num(row.postings) },
        { key: "scanned", label: "Scanned", render: (row) => html`<span class="nowrap small">${row.lastScanned ? ago(row.lastScanned) : "-"}</span>` },
      ]}
      rows=${data.matching}
      rowKey=${(row) => `${row.ats}:${row.board}`}
      empty=${html`<${Empty} title="No untracked boards with fitting roles">A harvest run scans boards it finds and lists the ones with roles that pass your gates.</${Empty}>`}
    />
    ${data.runs.length
      ? html`<p class="small muted">Recent harvests: ${data.runs.slice(0, 3).map((entry, index) => html`${index ? "; " : ""}${label(entry.kind)} ${label(entry.status).toLowerCase()} ${ago(entry.startedAt)}`)}.</p>`
      : null}
  </div>`;
}

export default function LeadsPage({ query }) {
  useTitle("Leads");
  return html`<div>
    <${PageHead}
      title="Leads"
      sub="Companies seen hiring in job alerts, funding news and harvested boards. A lead becomes a source only when you accept a verified board."
      actions=${html`${RUN_LINKS.map(([type, text]) => html`<a class="btn btn--small" href=${`/runs?start=${type}`}>${text}</a>`)}`}
    />
    <section aria-labelledby="proposals-title">
      <div class="section__head"><h2 id="proposals-title">Board proposals</h2></div>
      <${Proposals} />
    </section>
    <section class="section" aria-labelledby="leads-title">
      <div class="section__head"><h2 id="leads-title">Leads</h2></div>
      <${Leads} query=${query} />
    </section>
    <section class="section" aria-labelledby="harvest-title">
      <div class="section__head"><h2 id="harvest-title">Board harvesting</h2></div>
      <${Harvest} />
    </section>
  </div>`;
}
