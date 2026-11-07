import { api } from "../api.js";
import { Drawer } from "../components/drawer.js";
import { DataTable } from "../components/table.js";
import { TabPanel, Tabs } from "../components/tabs.js";
import { Button, Empty, ErrorNotice, ExternalLink, PageHead, Plate, Skeleton } from "../components/ui.js";
import { dateTime, label, num, plural } from "../lib/format.js";
import { html } from "../lib/html.js";
import { useResource, useTitle } from "../lib/hooks.js";
import { Markdown } from "../lib/markdown.js";
import { setQuery } from "../lib/router.js";

/** Evaluation reports to read, roles reposted under new ids, and the do-not-apply list. Read-only. */

const TABS = [
  { id: "reports", label: "Evaluation reports" },
  { id: "reposts", label: "Reposted roles" },
  { id: "blacklist", label: "Do-not-apply list" },
];

function ReportReader({ reportId, onClose }) {
  const { data, error, loading, reload } = useResource(() => api.get(`/api/reports/${encodeURIComponent(reportId)}`), [reportId]);
  const report = data?.report;
  const summary = report?.narrative && typeof report.narrative === "object" ? report.narrative.summary : null;
  return html`<${Drawer}
    wide
    title=${data?.job ? `${data.job.company}: ${data.job.title}` : "Evaluation report"}
    sub=${report ? html`<span class="row">Report ${num(report.number)} · ${dateTime(report.createdAt)} <${Plate} value=${report.verdict} /></span>` : null}
    onClose=${onClose}
  >
    ${error ? html`<${ErrorNotice} error=${error} onRetry=${reload} />` : null}
    ${loading && !data ? html`<${Skeleton} lines=${8} />` : null}
    ${report
      ? html`
          ${report.unverifiedFigures.length
            ? html`<section class="drawer__section">
                <div class="notice notice--held">
                  <p class="notice__title">${plural(report.unverifiedFigures.length, "figure")} not found in your profile or the posting</p>
                  <p>${report.unverifiedFigures.join(", ")}. Check them before relying on this report.</p>
                </div>
              </section>`
            : null}
          <section class="drawer__section">
            <dl class="facts">
              <dt>Score</dt><dd>${report.score === null ? "-" : `${report.score} of 5`}</dd>
              <dt>Posting</dt>
              <dd class="row">${data.job ? html`<a href=${`/jobs?job=${encodeURIComponent(data.job.id)}&dismissed=include`}>Evaluation and posting</a><${ExternalLink} href=${data.job.url}>Original</${ExternalLink}>` : "Missing"}</dd>
              ${report.fileName ? html`<dt>File</dt><dd class="mono small">${report.fileName}</dd>` : null}
            </dl>
          </section>
          <section class="drawer__section">
            ${data.markdown
              ? html`<${Markdown} text=${data.markdown} />`
              : html`<div class="stack">
                  <p class="notice">${data.markdownNote}</p>
                  ${summary ? html`<p class="prose">${summary}</p>` : null}
                </div>`}
            ${data.markdown && data.markdownNote ? html`<p class="small muted" style=${{ marginTop: "0.75rem" }}>${data.markdownNote}</p>` : null}
          </section>
        `
      : null}
  </${Drawer}>`;
}

function ReportsTab({ query }) {
  const jobId = query.get("job") ?? "";
  const openReport = query.get("report");
  const reports = useResource(() => api.get("/api/reports", { jobId, limit: 200 }), [jobId]);
  const columns = [
    { key: "number", label: "No.", numeric: true, render: (row) => num(row.number) },
    { key: "role", label: "Role", render: (row) => html`<span class="cell-main">${row.company}</span><span class="cell-sub">${row.title}</span>` },
    { key: "verdict", label: "Verdict", render: (row) => html`<${Plate} value=${row.verdict} />` },
    { key: "score", label: "Score", numeric: true, render: (row) => (row.score === null ? "-" : row.score) },
    {
      key: "checks",
      label: "Figures",
      render: (row) =>
        row.unverifiedFigures.length
          ? html`<${Plate} text=${`${row.unverifiedFigures.length} unverified`} tone="warn" />`
          : html`<span class="small muted">All verified</span>`,
    },
    { key: "date", label: "Written", render: (row) => html`<span class="nowrap small">${dateTime(row.createdAt)}</span>` },
  ];
  return html`<div class="stack">
    ${jobId
      ? html`<p class="row small">Reports for one posting. <${Button} small kind="ghost" onClick=${() => setQuery({ job: undefined })}>Show every report</${Button}></p>`
      : null}
    ${reports.error ? html`<${ErrorNotice} error=${reports.error} onRetry=${reports.reload} />` : null}
    <${DataTable}
      caption="Evaluation reports"
      columns=${columns}
      rows=${reports.data?.reports}
      rowKey=${(row) => row.id}
      loading=${reports.loading}
      selectedKey=${openReport}
      onOpen=${(row) => setQuery({ report: row.id }, { replace: false })}
      empty=${html`<${Empty} title="No evaluation reports yet">Ask your agent to evaluate a posting in depth (evaluate_job, then save_evaluation_report); the reports are read here.</${Empty}>`}
    />
    ${openReport ? html`<${ReportReader} key=${openReport} reportId=${openReport} onClose=${() => setQuery({ report: undefined })} />` : null}
  </div>`;
}

function RepostsTab() {
  const reposts = useResource(() => api.get("/api/reposts", { limit: 100 }), []);
  const data = reposts.data;
  const columns = [
    { key: "role", label: "Role", render: (row) => html`<span class="cell-main">${row.sampleTitle}</span><span class="cell-sub">${row.company}</span>` },
    { key: "board", label: "Board", render: (row) => html`<span class="small">${label(row.ats)}</span><span class="cell-sub mono">${row.board}</span>` },
    { key: "postings", label: "Postings", numeric: true, render: (row) => num(row.postings) },
    { key: "dates", label: "Days listed", numeric: true, render: (row) => num(row.distinctDates) },
    { key: "span", label: "Over", render: (row) => html`<span class="nowrap small">${plural(row.spanDays, "day")}</span>` },
    {
      key: "members",
      label: "Postings seen",
      render: (row) => html`<details class="small">
        <summary>${plural(row.members.length, "posting")}</summary>
        <ul class="plain-list">
          ${row.members.map((member) => html`<li key=${member.jobId}><a href=${`/jobs?job=${encodeURIComponent(member.jobId)}&dismissed=include`}>${dateTime(member.firstSeenAt)}</a> <span class="muted mono">${member.externalId}</span></li>`)}
        </ul>
      </details>`,
    },
  ];
  return html`<div class="stack">
    <p class="small muted">The same role re-listed under new posting ids on different days${data ? ` within ${data.windowDays} days (at least ${data.minPostings} postings)` : ""}. A weak ghost-job signal: evergreen and hard-to-fill roles are reposted too.</p>
    ${reposts.error ? html`<${ErrorNotice} error=${reposts.error} onRetry=${reposts.reload} />` : null}
    <${DataTable}
      caption="Reposted roles"
      columns=${columns}
      rows=${data?.clusters}
      rowKey=${(row) => `${row.ats}:${row.board}:${row.titleIdentity}`}
      loading=${reposts.loading}
      empty=${html`<${Empty} title="No reposted roles" />`}
    />
    ${data?.truncated ? html`<p class="small muted">${num(data.truncated)} more not shown.</p>` : null}
  </div>`;
}

function BlacklistTab() {
  const list = useResource(() => api.get("/api/blacklist"), []);
  return html`<div class="stack">
    <p class="small muted">Employers and domains you decided never to apply to. Postings that match are rejected at the gate. Add entries with blacklist_company through your agent, or in campaign.json.</p>
    ${list.error ? html`<${ErrorNotice} error=${list.error} onRetry=${list.reload} />` : null}
    <${DataTable}
      caption="Do-not-apply list"
      columns=${[
        { key: "value", label: "Entry", render: (row) => html`<span class="cell-main">${row.value}</span>` },
        { key: "scope", label: "Matches", render: (row) => html`<${Plate} text=${row.scope === "domain" ? "Domain" : "Company"} tone="muted" />` },
        { key: "reason", label: "Why", render: (row) => row.reason || html`<span class="muted">-</span>` },
        { key: "since", label: "Since", render: (row) => html`<span class="nowrap small">${row.since || "-"}</span>` },
      ]}
      rows=${list.data?.entries}
      rowKey=${(row) => `${row.scope}:${row.value}`}
      loading=${list.loading}
      empty=${html`<${Empty} title="Nobody is on the list" />`}
    />
  </div>`;
}

export default function Reports({ query }) {
  useTitle("Reports");
  const tab = TABS.some((entry) => entry.id === query.get("tab")) ? query.get("tab") : "reports";
  const panels = { reports: ReportsTab, reposts: RepostsTab, blacklist: BlacklistTab };
  const Panel = panels[tab];
  return html`<div>
    <${PageHead} title="Reports" sub="In-depth evaluations to read, and the hygiene signals behind what the gates reject." />
    <${Tabs} label="Reports" idPrefix="reports" tabs=${TABS} current=${tab} onChange=${(id) => setQuery({ tab: id === "reports" ? undefined : id, report: undefined }, { replace: false })} />
    <${TabPanel} idPrefix="reports" current=${tab}><${Panel} query=${query} /></${TabPanel}>
  </div>`;
}
