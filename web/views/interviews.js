import { api } from "../api.js";
import { Drawer } from "../components/drawer.js";
import { DataTable } from "../components/table.js";
import { TabPanel, Tabs } from "../components/tabs.js";
import { Check, Empty, ErrorNotice, ExternalLink, Icon, PageHead, Plate, Segmented, Skeleton } from "../components/ui.js";
import { dateTime, inDays, label, money, when } from "../lib/format.js";
import { html } from "../lib/html.js";
import { useResource, useTitle } from "../lib/hooks.js";
import { Markdown } from "../lib/markdown.js";
import { setQuery } from "../lib/router.js";
import { useStatus } from "../lib/store.js";
import { ContactsTab, NotesTab, StoriesTab } from "./career-tabs.js";

/** Interviews with calendar files and prep notes, offers side by side, and the material behind them. */

const TABS = [
  { id: "interviews", label: "Interviews" },
  { id: "offers", label: "Offers" },
  { id: "stories", label: "Story bank" },
  { id: "contacts", label: "Contacts and outreach" },
  { id: "notes", label: "Company research" },
];

function isLink(value) {
  return /^https?:\/\//i.test(value ?? "");
}

function IcsLink({ interview }) {
  if (!interview.scheduledAt) return html`<span class="muted small">No time yet</span>`;
  return html`<a class="nowrap" href=${`/api/interviews/${encodeURIComponent(interview.id)}/ics`} download>
    <${Icon} name="download" /> Calendar file
  </a>`;
}

function InterviewDetail({ interviewId, onClose }) {
  const { data, error, loading, reload } = useResource(() => api.get(`/api/interviews/${encodeURIComponent(interviewId)}`), [interviewId]);
  const interview = data?.interview;
  return html`<${Drawer}
    wide
    title=${interview ? `${label(interview.stage)}: ${interview.company}` : "Interview"}
    sub=${interview ? interview.title : null}
    onClose=${onClose}
  >
    ${error ? html`<${ErrorNotice} error=${error} onRetry=${reload} />` : null}
    ${loading && !data ? html`<${Skeleton} lines=${6} />` : null}
    ${interview
      ? html`
          <section class="drawer__section">
            <dl class="facts">
              <dt>When</dt><dd>${interview.scheduledAt ? `${when(interview.scheduledAt)} · ${interview.durationMinutes ?? 45} min` : "Not scheduled yet"}</dd>
              <dt>Status</dt><dd><${Plate} value=${interview.status} /></dd>
              ${interview.format ? html`<dt>Format</dt><dd>${label(interview.format)}</dd>` : null}
              ${interview.locationOrLink
                ? html`<dt>Where</dt><dd>${isLink(interview.locationOrLink) ? html`<${ExternalLink} href=${interview.locationOrLink}>${interview.locationOrLink}</${ExternalLink}>` : interview.locationOrLink}</dd>`
                : null}
              ${interview.interviewers.length
                ? html`<dt>With</dt><dd>${interview.interviewers.map((person) => (person.role ? `${person.name} (${person.role})` : person.name)).join(", ")}</dd>`
                : null}
              <dt>Application</dt><dd><a href=${`/applications?app=${encodeURIComponent(interview.applicationId)}`}>Open the application</a></dd>
              <dt>Calendar</dt><dd><${IcsLink} interview=${interview} /></dd>
            </dl>
            ${interview.notes ? html`<p class="small" style=${{ marginTop: "0.75rem" }}>${interview.notes}</p>` : null}
          </section>
          <section class="drawer__section">
            <h3>Prep and debriefs</h3>
            ${data.sessions.length
              ? data.sessions.map(
                  (session) => html`<article class="session" key=${session.id}>
                    <div class="row"><${Plate} text=${label(session.kind)} tone="info" /><span class="small muted">${dateTime(session.createdAt)}</span></div>
                    <${Markdown} text=${session.content} />
                  </article>`,
                )
              : html`<${Empty} title="No prep notes yet">Ask your agent for an interview plan (interview_context, then save_interview_session); it appears here.</${Empty}>`}
          </section>
        `
      : null}
  </${Drawer}>`;
}

function InterviewsTab({ query }) {
  const scope = query.get("scope") === "all" ? "all" : "upcoming";
  const openInterview = query.get("interview");
  const interviews = useResource(() => api.get("/api/interviews", { scope, limit: 200 }), [scope]);
  const columns = [
    {
      key: "when",
      label: "When",
      render: (row) =>
        row.scheduledAt
          ? html`<span class="nowrap">${when(row.scheduledAt)}</span><span class="cell-sub">${inDays(row.daysUntil)}</span>`
          : html`<span class="muted">Not scheduled</span>`,
    },
    { key: "role", label: "Application", render: (row) => html`<span class="cell-main">${row.company}</span><span class="cell-sub">${row.title}</span>` },
    { key: "stage", label: "Stage", render: (row) => html`<span class="small">${label(row.stage)}</span>` },
    { key: "with", label: "With", render: (row) => html`<span class="small">${row.interviewers.map((person) => person.name).join(", ") || "-"}</span>` },
    { key: "status", label: "Status", render: (row) => html`<${Plate} value=${row.status} />` },
    { key: "ics", label: "Calendar", render: (row) => html`<${IcsLink} interview=${row} />` },
  ];
  return html`<div class="stack">
    <div class="row">
      <${Segmented}
        legend="Interviews to show"
        hideLegend
        value=${scope}
        onChange=${(value) => setQuery({ scope: value === "all" ? "all" : undefined })}
        options=${[{ value: "upcoming", label: "Upcoming" }, { value: "all", label: "All" }]}
      />
    </div>
    ${interviews.error ? html`<${ErrorNotice} error=${interviews.error} onRetry=${interviews.reload} />` : null}
    <${DataTable}
      caption="Interviews"
      columns=${columns}
      rows=${interviews.data?.interviews}
      rowKey=${(row) => row.id}
      loading=${interviews.loading}
      selectedKey=${openInterview}
      onOpen=${(row) => setQuery({ interview: row.id }, { replace: false })}
      empty=${html`<${Empty} title=${scope === "upcoming" ? "No interviews coming up" : "No interviews recorded"}>
        Interviews are recorded with schedule_interview, usually by your agent once an employer books one.
      </${Empty}>`}
    />
    ${openInterview ? html`<${InterviewDetail} key=${openInterview} interviewId=${openInterview} onClose=${() => setQuery({ interview: undefined })} />` : null}
  </div>`;
}

function percentText(value) {
  if (value === null || value === undefined) return "";
  return `${value > 0 ? "+" : ""}${Math.round(value)}%`;
}

function rangePosition(position) {
  if (position === null || position === undefined) return null;
  if (position < 0) return "Below the posted range";
  if (position > 1) return "Above the posted range";
  return `${Math.round(position * 100)}% up the range`;
}

function OffersTab({ query }) {
  const includeClosed = query.get("closed") === "1";
  const comparison = useResource(() => api.get("/api/offers/compare", { includeClosed: includeClosed ? "true" : "" }), [includeClosed]);
  const data = comparison.data;
  const currency = data?.currency;
  const top = data?.ranking?.[0];
  const columns = [
    {
      key: "offer",
      label: "Offer",
      render: (row) => html`<span class="cell-main">${row.company}</span><span class="cell-sub">${row.title}${row.level ? ` · ${row.level}` : ""}</span>`,
    },
    { key: "status", label: "Status", render: (row) => html`<${Plate} value=${row.status} />` },
    { key: "base", label: "Base", numeric: true, render: (row) => money(row.comp.base, row.comp.currency) },
    {
      key: "year",
      label: "First year",
      numeric: true,
      render: (row) => (row.inProfileCurrency ? money(row.inProfileCurrency.firstYearTotal, currency) : html`<span class="muted" title="No exchange rate for this currency">-</span>`),
    },
    {
      key: "annual",
      label: "Annualized",
      numeric: true,
      render: (row) => (row.inProfileCurrency ? html`<strong>${money(row.inProfileCurrency.annualizedTotal, currency)}</strong>` : html`<span class="muted">-</span>`),
    },
    {
      key: "target",
      label: "Against target",
      render: (row) =>
        row.vsTarget
          ? html`<span class=${row.vsTarget.delta >= 0 ? "text-ok" : "text-warn"}>${money(row.vsTarget.delta, currency)} ${percentText(row.vsTarget.pct)}</span>
              ${row.vsMinimum && !row.vsMinimum.meets ? html`<span class="cell-sub text-bad">Below your minimum</span>` : null}`
          : html`<span class="muted">-</span>`,
    },
    {
      key: "posting",
      label: "Posted range",
      render: (row) =>
        row.posting
          ? html`<span class="small">${row.posting.raw || "-"}</span>${rangePosition(row.posting.positionInRange) ? html`<span class="cell-sub">${rangePosition(row.posting.positionInRange)}</span>` : null}`
          : html`<span class="muted small">Not published</span>`,
    },
    {
      key: "deadline",
      label: "Decide by",
      render: (row) =>
        row.deadline
          ? html`<span class="nowrap">${row.deadline}</span><span class=${`cell-sub${row.daysToDeadline !== null && row.daysToDeadline <= 7 ? " text-warn" : ""}`}>${inDays(row.daysToDeadline)}</span>`
          : html`<span class="muted">-</span>`,
    },
  ];
  return html`<div class="stack">
    <div class="row">
      <${Check} checked=${includeClosed} onChange=${(value) => setQuery({ closed: value ? "1" : undefined })}>Include declined and expired offers</${Check}>
    </div>
    ${comparison.error ? html`<${ErrorNotice} error=${comparison.error} onRetry=${comparison.reload} />` : null}
    <${DataTable}
      caption="Offers compared"
      columns=${columns}
      rows=${data?.offers}
      rowKey=${(row) => row.offerId}
      loading=${comparison.loading}
      empty=${html`<${Empty} title="No offers in play">Offers are recorded with record_offer; they are compared here in ${currency ?? "your profile's currency"}.</${Empty}>`}
    />
    ${data?.offers?.some((row) => row.warnings.length)
      ? html`<ul class="plain-list small">
          ${data.offers.flatMap((row) => row.warnings.map((warning, index) => html`<li key=${`${row.offerId}-${index}`}><strong>${row.company}:</strong> ${warning}</li>`))}
        </ul>`
      : null}
    ${top && data.offers.length > 1 ? html`<p>Highest annualized: <strong>${top.company}</strong>, ${money(top.annualizedTotal, currency)}.</p>` : null}
    ${data?.assumptions?.length
      ? html`<details class="small">
          <summary>How these totals are computed</summary>
          <ul class="plain-list" style=${{ marginTop: "0.5rem" }}>${data.assumptions.map((assumption) => html`<li>${assumption}</li>`)}</ul>
        </details>`
      : null}
  </div>`;
}

export default function Interviews({ query }) {
  useTitle("Interviews and offers");
  const tab = TABS.some((entry) => entry.id === query.get("tab")) ? query.get("tab") : "interviews";
  const after = useStatus().data?.afterApply;
  const tabs = TABS.map((entry) => ({ ...entry, count: entry.id === "offers" ? after?.activeOffers : undefined }));
  const panels = { interviews: InterviewsTab, offers: OffersTab, stories: StoriesTab, contacts: ContactsTab, notes: NotesTab };
  const Panel = panels[tab];
  return html`<div>
    <${PageHead}
      title="Interviews and offers"
      sub=${after?.nextInterview ? html`Next: <strong>${after.nextInterview.company}</strong>, ${when(after.nextInterview.scheduledAt)} (${inDays(after.nextInterview.daysUntil)})` : "Interviews, offers and the material you prepare them with."}
    />
    <${Tabs}
      label="Interviews and offers"
      idPrefix="career"
      tabs=${tabs}
      current=${tab}
      onChange=${(id) => setQuery({ tab: id === "interviews" ? undefined : id, interview: undefined }, { replace: false })}
    />
    <${TabPanel} idPrefix="career" current=${tab}>
      <${Panel} query=${query} />
    </${TabPanel}>
    <p class="small muted" style=${{ marginTop: "1.5rem" }}>Drafts and notes here are written with your agent; this page never sends anything.</p>
  </div>`;
}
