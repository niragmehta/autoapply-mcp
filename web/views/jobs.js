import { api } from "../api.js";
import { DismissConfirm, dismissedText } from "../components/dismiss.js";
import { DataTable, Pager } from "../components/table.js";
import { Button, Empty, ErrorNotice, PageHead, Plate, TierPlate, Toggles } from "../components/ui.js";
import { ago, label, num, plural } from "../lib/format.js";
import { html, useEffect, useState } from "../lib/html.js";
import { useAction, useDebounced, useResource, useTitle } from "../lib/hooks.js";
import { listParam, setQuery } from "../lib/router.js";
import { toast, useMeta, useStatus } from "../lib/store.js";
import { JobDetail } from "./job-detail.js";

/** Every stored posting, filterable and sortable, with the filters kept in the URL. */

const PAGE_SIZE = 50;
const FILTER_KEYS = ["q", "decision", "tier", "track", "locationClass", "ats", "company", "hasApplication", "minScore", "dismissed"];

function readFilters(query) {
  return {
    q: query.get("q") ?? "",
    decision: query.get("decision") ?? "",
    tier: listParam(query, "tier"),
    track: query.get("track") ?? "",
    locationClass: query.get("locationClass") ?? "",
    ats: query.get("ats") ?? "",
    company: query.get("company") ?? "",
    hasApplication: query.get("hasApplication") ?? "",
    minScore: query.get("minScore") ?? "",
    dismissed: query.get("dismissed") ?? "",
    sort: query.get("sort") ?? "score",
    dir: query.get("dir") ?? "desc",
    page: Math.max(1, Number(query.get("page") ?? 1) || 1),
  };
}

const LIVENESS_TEXT = { open: "Open", closed: "Closed", unknown: "Unconfirmed" };

/** Liveness as one quiet line under the posted date; a closed posting is the only one in colour. */
function LivenessLine({ liveness }) {
  if (!liveness) return null;
  const text = `${LIVENESS_TEXT[liveness.status] ?? label(liveness.status)} · ${ago(liveness.checkedAt)}`;
  return liveness.status === "closed"
    ? html`<span class="cell-sub"><${Plate} text=${text} tone="bad" title=${liveness.detail} /></span>`
    : html`<span class="cell-sub" title=${liveness.detail}>${text}</span>`;
}

function BulkBar({ selected, rows, onDone, onClear }) {
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, run] = useAction(toast);
  const status = useStatus();
  const picked = rows.filter((row) => selected.has(row.id));
  const dismissible = picked.filter((row) => !row.dismissal && row.application?.status !== "submitted");
  const restorable = picked.filter((row) => row.dismissal);
  const unsent = dismissible.filter((row) => row.application && row.application.status !== "skipped").length;
  const finish = () => {
    setReason("");
    setConfirming(false);
    status.reload({ quiet: true });
    onDone();
  };
  const dismiss = async () => {
    const result = await run(() => api.post("/api/jobs/dismiss", { jobIds: dismissible.map((row) => row.id), ...(reason.trim() ? { reason: reason.trim() } : {}) }));
    if (!result) return;
    toast(dismissedText(result.dismissed, result.failed), { tone: result.failed.length ? "bad" : "ok" });
    finish();
  };
  const restore = async () => {
    const result = await run(() => api.post("/api/jobs/restore", { jobIds: restorable.map((row) => row.id) }));
    if (!result) return;
    const failed = result.failed ?? [];
    toast(
      failed.length
        ? `Restored ${plural(result.restored.length, "posting")}; ${plural(failed.length, "was", "were")} refused: ${failed.map((entry) => entry.message).join("; ")}`
        : `Restored ${plural(result.restored.length, "posting")} to the queue. Skipped applications stay skipped until prepared again.`,
      { tone: failed.length ? "bad" : "ok" },
    );
    finish();
  };
  const cancel = () => {
    setConfirming(false);
    requestAnimationFrame(() => document.getElementById("bulk-dismiss")?.focus());
  };
  if (confirming && dismissible.length) {
    return html`<div class="bulkbar-confirm">
      <${DismissConfirm} count=${dismissible.length} unsent=${unsent} busy=${busy} onConfirm=${dismiss} onCancel=${cancel} />
    </div>`;
  }
  return html`<div class="bulkbar" role="region" aria-label="Selected postings">
    <span class="bulkbar__count"><strong>${num(picked.length)}</strong> selected</span>
    ${dismissible.length
      ? html`<div class="field bulkbar__reason">
          <label class="field__label sr-only" for="bulk-reason">Reason for dismissing</label>
          <input id="bulk-reason" class="input" placeholder="Reason (optional)" maxlength="500" value=${reason} onInput=${(event) => setReason(event.currentTarget.value)} />
        </div>
        <${Button} id="bulk-dismiss" busy=${busy} onClick=${() => setConfirming(true)}>Dismiss ${num(dismissible.length)}...</${Button}>`
      : null}
    ${restorable.length ? html`<${Button} busy=${busy} onClick=${restore}>Restore ${num(restorable.length)}</${Button}>` : null}
    ${picked.length > dismissible.length + restorable.length
      ? html`<span class="small muted">${plural(picked.length - dismissible.length - restorable.length, "is", "are")} already submitted and cannot be dismissed</span>`
      : null}
    <${Button} kind="ghost" small onClick=${onClear}>Clear selection</${Button}>
  </div>`;
}

function Select({ id, label: text, value, onChange, options, any = "Any" }) {
  return html`<div class="field">
    <label class="field__label" for=${id}>${text}</label>
    <select id=${id} class="select" value=${value} onChange=${(event) => onChange(event.currentTarget.value)}>
      <option value="">${any}</option>
      ${options.map((option) => html`<option value=${option.value}>${option.label}</option>`)}
    </select>
  </div>`;
}

export default function Jobs({ query }) {
  useTitle("Jobs");
  const filters = readFilters(query);
  const openJob = query.get("job");
  const meta = useMeta().data;
  const facets = useResource(() => api.get("/api/jobs/facets"), []);
  const [search, setSearch] = useState(filters.q);
  const [selected, setSelected] = useState(() => new Set());
  const settled = useDebounced(search, 300);

  useEffect(() => {
    if (settled !== filters.q) setQuery({ q: settled, page: undefined });
  }, [settled]);

  const request = {
    q: filters.q,
    decision: filters.decision,
    tier: filters.tier,
    track: filters.track,
    locationClass: filters.locationClass,
    ats: filters.ats,
    company: filters.company,
    hasApplication: filters.hasApplication,
    minScore: filters.minScore,
    dismissed: filters.dismissed,
    sort: filters.sort,
    dir: filters.dir,
    page: filters.page,
    pageSize: PAGE_SIZE,
  };
  const key = JSON.stringify(request);
  const jobs = useResource(() => api.get("/api/jobs", request), [key]);
  useEffect(() => setSelected(new Set()), [key]);
  const active = FILTER_KEYS.some((name) => (Array.isArray(filters[name]) ? filters[name].length > 0 : filters[name] !== ""));
  const update = (changes) => setQuery({ ...changes, page: undefined });
  const facetCount = (group, value) => facets.data?.[group]?.find((entry) => entry.value === value)?.count;
  const rows = jobs.data?.rows ?? [];
  const toggle = (id, on) => {
    const next = new Set(selected);
    if (on) next.add(id);
    else next.delete(id);
    setSelected(next);
  };
  const allOnPage = rows.length > 0 && rows.every((row) => selected.has(row.id));
  const reloadAll = () => {
    setSelected(new Set());
    jobs.reload({ quiet: true });
    facets.reload({ quiet: true });
  };

  const columns = [
    {
      key: "pick",
      label: html`<input type="checkbox" class="pick" aria-label="Select every posting on this page" checked=${allOnPage} onChange=${(event) => setSelected(event.currentTarget.checked ? new Set(rows.map((row) => row.id)) : new Set())} />`,
      render: (row) => html`<input type="checkbox" class="pick" aria-label=${`Select ${row.company}: ${row.title}`} checked=${selected.has(row.id)} onChange=${(event) => toggle(row.id, event.currentTarget.checked)} />`,
    },
    {
      key: "score",
      label: "Score",
      sort: "score",
      numeric: true,
      render: (row) => html`<span class="row" style=${{ justifyContent: "flex-end", flexWrap: "nowrap" }}>${row.evaluation ? num(Math.round(row.evaluation.score)) : "-"} <${TierPlate} tier=${row.evaluation?.tier} /></span>`,
    },
    {
      key: "role",
      label: "Role",
      sort: "title",
      defaultDir: "asc",
      render: (row) => html`<span class="cell-main">${row.title}</span><span class="cell-sub">${row.company}</span>`,
    },
    { key: "track", label: "Track", render: (row) => html`<span class="small nowrap">${row.evaluation?.trackId ?? "-"}</span>` },
    {
      key: "where",
      label: "Location",
      render: (row) => html`<span class="small">${row.locations[0] ?? label(row.locationClass)}</span><span class="cell-sub">${label(row.locationClass)} · ${label(row.workplaceType)}</span>`,
    },
    { key: "pay", label: "Pay", render: (row) => html`<span class="small nowrap">${row.compensation ?? html`<span class="muted">-</span>`}</span>` },
    {
      key: "posted",
      label: "Posted",
      sort: "posted",
      render: (row) => html`<span class="nowrap small">${row.postedAt ? ago(row.postedAt) : "-"}</span><${LivenessLine} liveness=${row.liveness} />`,
    },
    {
      key: "gate",
      label: "Decision",
      render: (row) =>
        row.dismissal
          ? html`<${Plate} text="Dismissed" tone="muted" title=${row.dismissal.reason || "Dismissed by you"} /><span class="cell-sub">${row.dismissal.reason || ago(row.dismissal.dismissedAt)}</span>`
          : row.evaluation
            ? html`<${Plate} value=${row.evaluation.decision} title=${row.evaluation.gateReason || undefined} />${row.evaluation.gateRule ? html`<span class="cell-sub">${label(row.evaluation.gateRule)}</span>` : null}`
            : html`<span class="muted">-</span>`,
    },
    {
      key: "application",
      label: "Application",
      render: (row) =>
        row.application
          ? html`<${Plate} value=${row.application.status} />`
          : row.roleApplied
            ? html`<span class="small muted" title="The same role already has an application on another board">Applied elsewhere</span>`
            : html`<span class="muted">-</span>`,
    },
  ];

  const empty = active
    ? html`<${Empty} title="No postings match these filters" action=${html`<${Button} small onClick=${() => setQuery(Object.fromEntries(FILTER_KEYS.map((name) => [name, undefined])))}>Clear filters</${Button}>`}>
        Loosen a filter, or search by a different company or title.
      </${Empty}>`
    : html`<${Empty} title="No postings yet" action=${html`<a class="btn btn--primary" href="/runs">Start a discovery run</a>`}>
        Discovery fetches every active board, gates and scores each posting, and lists them here.
      </${Empty}>`;

  return html`<div>
    <${PageHead}
      title="Jobs"
      sub=${jobs.data ? `${num(jobs.data.total)} posting${jobs.data.total === 1 ? "" : "s"}${active ? " match" : " stored"}` : "Postings from your boards"}
    />
    <form class="filters" role="search" aria-label="Filter postings" onSubmit=${(event) => event.preventDefault()}>
      <div class="field">
        <label class="field__label" for="jobs-q">Search</label>
        <input id="jobs-q" class="input input--search" type="search" placeholder="Title or company" value=${search} data-search onInput=${(event) => setSearch(event.currentTarget.value)} />
      </div>
      <${Select}
        id="jobs-decision"
        label="Decision"
        value=${filters.decision}
        onChange=${(value) => update({ decision: value })}
        options=${["accept", "review", "reject"].map((value) => ({ value, label: `${label(value)}${facetCount("decisions", value) !== undefined ? ` (${num(facetCount("decisions", value))})` : ""}` }))}
      />
      <${Toggles}
        legend="Tier"
        value=${filters.tier}
        onChange=${(value) => update({ tier: value })}
        options=${["A", "B", "C"].map((value) => ({ value, label: value, count: facetCount("tiers", value) }))}
      />
      <${Select}
        id="jobs-track"
        label="Track"
        value=${filters.track}
        onChange=${(value) => update({ track: value })}
        options=${(meta?.tracks ?? []).map((track) => ({ value: track.id, label: track.label }))}
      />
      <${Select}
        id="jobs-location"
        label="Location"
        value=${filters.locationClass}
        onChange=${(value) => update({ locationClass: value })}
        options=${(facets.data?.locationClasses ?? []).map((entry) => ({ value: entry.value, label: `${label(entry.value)} (${num(entry.count)})` }))}
      />
      <${Select}
        id="jobs-ats"
        label="Board type"
        value=${filters.ats}
        onChange=${(value) => update({ ats: value })}
        options=${(facets.data?.ats ?? []).map((entry) => ({ value: entry.value, label: `${label(entry.value)} (${num(entry.count)})` }))}
      />
      <${Select}
        id="jobs-application"
        label="Application"
        value=${filters.hasApplication}
        onChange=${(value) => update({ hasApplication: value })}
        options=${[{ value: "no", label: "Not prepared" }, { value: "yes", label: "Prepared" }]}
      />
      <${Select}
        id="jobs-dismissed"
        label="Dismissed"
        any="Hidden"
        value=${filters.dismissed === "hide" ? "" : filters.dismissed}
        onChange=${(value) => update({ dismissed: value })}
        options=${[
          { value: "include", label: "Shown too" },
          { value: "only", label: `Only dismissed${facets.data?.dismissed !== undefined ? ` (${num(facets.data.dismissed)})` : ""}` },
        ]}
      />
      <div class="field">
        <label class="field__label" for="jobs-min">Min score</label>
        <input id="jobs-min" class="input" type="number" inputmode="numeric" min="0" max="100" placeholder="0" style=${{ width: "6rem" }} value=${filters.minScore} onChange=${(event) => update({ minScore: event.currentTarget.value })} />
      </div>
      ${active
        ? html`<div class="filters__end"><${Button} small kind="ghost" onClick=${() => { setSearch(""); setQuery(Object.fromEntries(FILTER_KEYS.map((name) => [name, undefined]))); }}>Clear filters</${Button}></div>`
        : null}
    </form>
    ${jobs.error ? html`<${ErrorNotice} error=${jobs.error} onRetry=${jobs.reload} />` : null}
    ${selected.size > 0 ? html`<${BulkBar} selected=${selected} rows=${rows} onDone=${reloadAll} onClear=${() => setSelected(new Set())} />` : null}
    <${DataTable}
      caption="Postings"
      columns=${columns}
      rows=${jobs.data?.rows}
      rowKey=${(row) => row.id}
      sort=${filters.sort}
      dir=${filters.dir}
      onSort=${(sort, dir) => setQuery({ sort, dir, page: undefined })}
      onOpen=${(row) => setQuery({ job: row.id }, { replace: false })}
      selectedKey=${openJob}
      loading=${jobs.loading}
      empty=${empty}
    />
    <${Pager} page=${filters.page} pageSize=${PAGE_SIZE} total=${jobs.data?.total} onPage=${(page) => setQuery({ page }, { replace: false })} />
    ${openJob ? html`<${JobDetail} key=${openJob} jobId=${openJob} onClose=${() => setQuery({ job: undefined })} onChanged=${reloadAll} />` : null}
  </div>`;
}
