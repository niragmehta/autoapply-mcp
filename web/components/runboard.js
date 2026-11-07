import { html } from "../lib/html.js";
import { clock, duration, shortId } from "../lib/format.js";
import { navigate } from "../lib/router.js";
import { isActive, runSummary, runTitle } from "../lib/runs.js";
import { DataTable } from "./table.js";
import { Plate, Progress } from "./ui.js";

/** Runs as a departure board: when it left, what it is, where it stands. `compact` keeps the first four columns. */
export function RunBoard({ runs, caption = "Runs", loading, empty, selectedKey, onOpen, compact = false }) {
  const columns = [
    {
      key: "time",
      label: "Started",
      render: (run) => html`<span class="nowrap">${clock(run.startedAt ?? run.createdAt)}</span>`,
    },
    {
      key: "run",
      label: "Run",
      render: (run) => html`<span class="cell-main nowrap">${runTitle(run)}</span><span class="cell-sub mono nowrap">${shortId(run.id)}</span>`,
    },
    { key: "status", label: "Status", render: (run) => html`<${Plate} value=${run.status} />` },
    {
      key: "progress",
      label: "Progress",
      render: (run) =>
        isActive(run) || run.progressTotal > 0
          ? html`<${Progress} done=${run.progressDone} total=${run.progressTotal} />`
          : html`<span class="muted">-</span>`,
    },
  ];
  if (!compact) {
    columns.push(
      {
        key: "took",
        label: "Time",
        render: (run) => html`<span class="nowrap muted">${run.startedAt ? duration(run.startedAt, run.finishedAt) : "-"}</span>`,
      },
      { key: "summary", label: "Result", render: (run) => html`<span class="small">${runSummary(run) || html`<span class="muted">-</span>`}</span>` },
    );
  }
  return html`<${DataTable}
    caption=${caption}
    columns=${columns}
    rows=${runs}
    rowKey=${(run) => run.id}
    loading=${loading}
    selectedKey=${selectedKey}
    onOpen=${onOpen ?? ((run) => navigate(`/runs?run=${encodeURIComponent(run.id)}`))}
    empty=${empty}
  />`;
}
