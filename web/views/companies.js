import { api } from "../api.js";
import { DataTable } from "../components/table.js";
import { Button, Check, Empty, ErrorNotice, PageHead, Plate, Switch } from "../components/ui.js";
import { ago, label, num, plural } from "../lib/format.js";
import { html, useState } from "../lib/html.js";
import { useAction, useResource, useTitle } from "../lib/hooks.js";
import { toast, useMeta, useStatus } from "../lib/store.js";

/** Company boards: what each has produced, switching boards on and off, and adding a verified board. */

const COMMON_ATS = ["greenhouse", "lever", "ashby", "workday", "smartrecruiters", "workable", "recruitee"];

function AddBoard({ onAdded }) {
  const meta = useMeta().data;
  const [form, setForm] = useState({ name: "", ats: "greenhouse", board: "", tier: "B", tags: "", query: "" });
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);
  const kinds = meta?.atsKinds ?? COMMON_ATS;
  const set = (key) => (event) => setForm({ ...form, [key]: event.currentTarget.value });

  const submit = async (event) => {
    event.preventDefault();
    setResult(null);
    setBusy(true);
    const body = {
      name: form.name.trim(),
      ats: form.ats,
      board: form.board.trim(),
      tier: form.tier,
      ...(form.tags.trim() ? { tags: form.tags.split(",").map((tag) => tag.trim()).filter(Boolean) } : {}),
      ...(form.query.trim() ? { query: form.query.trim() } : {}),
    };
    try {
      const saved = await api.post("/api/companies", body);
      setResult({ ok: true, ...saved });
      setForm({ ...form, name: "", board: "", tags: "", query: "" });
      onAdded();
    } catch (error) {
      setResult({ ok: false, message: error.message });
    } finally {
      setBusy(false);
    }
  };

  return html`<form class="panel panel--pad" onSubmit=${submit} aria-labelledby="add-board-title">
    <h2 id="add-board-title" style=${{ marginBottom: "0.25rem" }}>Add a board</h2>
    <p class="muted small" style=${{ marginBottom: "1rem" }}>The board is fetched once and saved only if it actually serves postings.</p>
    <div class="form-grid">
      <div class="field">
        <label class="field__label" for="board-name">Company name</label>
        <input id="board-name" class="input" required value=${form.name} onInput=${set("name")} />
      </div>
      <div class="field">
        <label class="field__label" for="board-ats">Board type</label>
        <select id="board-ats" class="select" value=${form.ats} onChange=${set("ats")}>
          ${kinds.filter((kind) => kind !== "external").map((kind) => html`<option value=${kind}>${label(kind)}</option>`)}
        </select>
      </div>
      <div class="field">
        <label class="field__label" for="board-slug">Board slug</label>
        <input id="board-slug" class="input mono" required value=${form.board} onInput=${set("board")} aria-describedby="board-slug-hint" />
        <span class="field__hint" id="board-slug-hint">${form.ats === "workday" ? "tenant/datacenter/site, e.g. acme/wd5/External" : "From the careers URL, e.g. boards.greenhouse.io/acme"}</span>
      </div>
      <div class="field">
        <label class="field__label" for="board-tier">Tier</label>
        <select id="board-tier" class="select" value=${form.tier} onChange=${set("tier")}>
          ${["A", "B", "C"].map((tier) => html`<option value=${tier}>${tier}</option>`)}
        </select>
      </div>
      <div class="field">
        <label class="field__label" for="board-tags">Tags</label>
        <input id="board-tags" class="input" placeholder="comma separated" value=${form.tags} onInput=${set("tags")} />
      </div>
      <div class="field">
        <label class="field__label" for="board-query">Search filter</label>
        <input id="board-query" class="input" placeholder="optional" value=${form.query} onInput=${set("query")} />
      </div>
    </div>
    <div class="form-actions">
      <${Button} type="submit" kind="primary" busy=${busy}>${busy ? "Verifying..." : "Verify and save"}</${Button}>
    </div>
    ${result?.ok
      ? html`<div class="notice notice--ok" role="status" style=${{ marginTop: "1rem" }}>
          <p class="notice__title">${result.company.name} ${result.action === "added" ? "added" : "updated"}: ${plural(result.postings, "posting")} found.</p>
          ${result.sampleTitles?.length ? html`<p>For example: ${result.sampleTitles.join("; ")}</p>` : null}
        </div>`
      : null}
    ${result && !result.ok
      ? html`<div class="notice notice--bad" role="alert" style=${{ marginTop: "1rem" }}>
          <p class="notice__title">Not saved</p>
          <p>${result.message}</p>
        </div>`
      : null}
  </form>`;
}

export default function Companies({ query }) {
  useTitle("Companies");
  const list = useResource(() => api.get("/api/companies"), []);
  const status = useStatus();
  const [search, setSearch] = useState(query.get("q") ?? "");
  const [showInactive, setShowInactive] = useState(true);
  const [busy, run] = useAction(toast);

  const patch = async (company, changes, message) => {
    const result = await run(() => api.patch(`/api/companies/${encodeURIComponent(company.name)}`, changes), { success: message });
    if (result) {
      list.reload({ quiet: true });
      status.reload({ quiet: true });
    }
  };

  const needle = search.trim().toLowerCase();
  const rows = (list.data?.companies ?? []).filter(
    (company) => (showInactive || company.active) && (!needle || company.name.toLowerCase().includes(needle) || company.board.toLowerCase().includes(needle)),
  );

  const columns = [
    {
      key: "active",
      label: "Active",
      render: (company) => html`<${Switch}
        checked=${company.active}
        disabled=${busy}
        label=${`${company.active ? "Pause" : "Resume"} ${company.name}`}
        onChange=${(next) => patch(company, { active: next }, `${company.name} ${next ? "resumed" : "paused"}.`)}
      />`,
    },
    {
      key: "name",
      label: "Company",
      render: (company) => html`<span class="cell-main">${company.name}</span>${company.tags.length ? html`<span class="cell-sub">${company.tags.join(", ")}</span>` : null}`,
    },
    { key: "board", label: "Board", render: (company) => html`<span class="small">${label(company.ats)}</span><span class="cell-sub mono">${company.board}</span>` },
    {
      key: "tier",
      label: "Tier",
      render: (company) => html`<select class="select" style=${{ width: "4.5rem" }} aria-label=${`Tier for ${company.name}`} value=${company.tier} disabled=${busy} onChange=${(event) => patch(company, { tier: event.currentTarget.value }, `${company.name} is now tier ${event.currentTarget.value}.`)}>
        ${["A", "B", "C"].map((tier) => html`<option value=${tier}>${tier}</option>`)}
      </select>`,
    },
    { key: "jobs", label: "Postings", numeric: true, render: (company) => num(company.stats.jobs) },
    { key: "accepted", label: "Accepted", numeric: true, render: (company) => num(company.stats.accepted) },
    { key: "applications", label: "Applications", numeric: true, render: (company) => num(company.stats.applications) },
    {
      key: "submitted",
      label: "Submitted",
      numeric: true,
      render: (company) => (company.stats.submitted ? html`<${Plate} text=${num(company.stats.submitted)} tone="ok" />` : html`<span class="muted">0</span>`),
    },
    { key: "seen", label: "Last fetched", render: (company) => html`<span class="small nowrap">${company.stats.lastSeenAt ? ago(company.stats.lastSeenAt) : "Never"}</span>` },
  ];

  return html`<div>
    <${PageHead}
      title="Companies"
      sub=${list.data ? `${plural(list.data.total, "board")}, ${num(list.data.active)} active` : "Boards discovery reads from"}
    />
    <${AddBoard} onAdded=${() => list.reload({ quiet: true })} />
    <section class="section" aria-labelledby="boards-title">
      <div class="section__head">
        <h2 id="boards-title">Boards</h2>
      </div>
      <div class="filters" role="search" aria-label="Filter boards">
        <div class="field">
          <label class="field__label" for="companies-q">Search</label>
          <input id="companies-q" class="input input--search" type="search" placeholder="Company or board" value=${search} data-search onInput=${(event) => setSearch(event.currentTarget.value)} />
        </div>
        <div class="field" style=${{ alignSelf: "end" }}>
          <${Check} checked=${showInactive} onChange=${setShowInactive}>Show paused boards</${Check}>
        </div>
      </div>
      ${list.error ? html`<${ErrorNotice} error=${list.error} onRetry=${list.reload} />` : null}
      <${DataTable}
        caption="Company boards"
        columns=${columns}
        rows=${rows}
        rowKey=${(company) => company.name}
        loading=${list.loading}
        empty=${needle
          ? html`<${Empty} title="No boards match" />`
          : html`<${Empty} title="No boards configured">Add one above, or record boards with the add_company_board tool.</${Empty}>`}
      />
    </section>
  </div>`;
}
