import { api } from "../api.js";
import { EditorDrawer } from "../components/confirm.js";
import { TabPanel, Tabs } from "../components/tabs.js";
import { Empty, ErrorNotice, ExternalLink, Plate, Skeleton, TierPlate } from "../components/ui.js";
import { ago, dateTime, label, num } from "../lib/format.js";
import { html, useState } from "../lib/html.js";
import { useResource } from "../lib/hooks.js";
import { setQuery } from "../lib/router.js";
import { useStatus } from "../lib/store.js";
import { ApplicationCareer } from "./application-career.js";
import { ApplicationEdit } from "./application-edit.js";
import { AnswersTable, Approval, BlockedAnswers, ClosedNotice, eventText, Outcome, Screenshots, Submission } from "./application-packet.js";
import { ApplicationResume } from "./application-resume.js";

/**
 * One application, in tabs: the packet and every decision on it; editing the
 * letter, answers and notes; the resume and its tailoring; interviews,
 * offers, people and research for its company; and its history.
 */

const TABS = [
  { id: "packet", label: "Packet" },
  { id: "edit", label: "Edit" },
  { id: "resume", label: "Resume" },
  { id: "career", label: "Interviews and notes" },
  { id: "history", label: "History" },
];

function Facts({ data }) {
  return html`<dl class="facts">
    <dt>Posting</dt>
    <dd class="row">
      <${ExternalLink} href=${data.job.url}>Posting</${ExternalLink}>
      <${ExternalLink} href=${data.job.applyUrl}>Apply page</${ExternalLink}>
      <a href=${`/jobs?job=${encodeURIComponent(data.job.id)}&dismissed=include`}>Evaluation</a>
    </dd>
    ${data.evaluation ? html`<dt>Fit</dt><dd class="row">Score ${num(Math.round(data.evaluation.score))} <${TierPlate} tier=${data.evaluation.tier} /> ${data.evaluation.trackId ?? ""}</dd>` : null}
    ${data.liveness && data.liveness.status !== "closed"
      ? html`<dt>Still open</dt><dd><${Plate} value=${data.liveness.status} text=${data.liveness.status === "open" ? "Open" : "Unconfirmed"} /> <span class="small muted">checked ${ago(data.liveness.checkedAt)}</span></dd>`
      : null}
    <dt>Resume</dt><dd>${data.application.resumeId} <span class="muted small">(${data.application.resumeFile})</span></dd>
    <dt>Prepared</dt><dd>${dateTime(data.application.createdAt)}</dd>
    ${data.application.submittedAt
      ? html`<dt>Submitted</dt><dd>${dateTime(data.application.submittedAt)} · ${label(data.application.submissionMode)}${data.application.confirmationRef ? html`<span class="cell-sub">${data.application.confirmationRef}</span>` : null}</dd>`
      : null}
  </dl>`;
}

function Packet({ data, changed }) {
  return html`
    <${BlockedAnswers} application=${data.application} answers=${data.answers} onSaved=${changed} />
    <${Approval} detail=${data} onChanged=${changed} />
    <${Submission} detail=${data} onChanged=${changed} />
    <${Outcome} detail=${data} onChanged=${changed} />
    <section class="drawer__section">
      <h3>Packet</h3>
      ${data.preview.storedHashStale ? html`<p class="notice notice--held" style=${{ marginBottom: "0.75rem" }}>The content changed since its hash was stored; approve the current packet.</p>` : null}
      <pre class="packet" tabindex="0">${data.preview.text}</pre>
    </section>
    <section class="drawer__section">
      <h3>Answers</h3>
      <${AnswersTable} answers=${data.answers} />
    </section>
    <section class="drawer__section">
      <h3>Screenshots</h3>
      <${Screenshots} artifacts=${data.artifacts} />
    </section>
  `;
}

function History({ events }) {
  return html`<section class="drawer__section">
    <h3>History</h3>
    ${events.length
      ? html`<ol class="stack small" style=${{ margin: 0, paddingLeft: "1.1rem" }}>
          ${events.map(
            (event) => html`<li key=${event.id}>
              <strong class=${event.type === "submission.blocked" && event.payload?.code === "posting_closed" ? "text-bad" : undefined}>${eventText(event)}</strong>
              <span class="muted"> ${dateTime(event.ts)}</span>
            </li>`,
          )}
        </ol>`
      : html`<${Empty} title="No recorded events" />`}
  </section>`;
}

export function ApplicationDetail({ applicationId, tab, onClose, onChanged }) {
  const resource = useResource(() => api.get(`/api/applications/${encodeURIComponent(applicationId)}`), [applicationId]);
  const status = useStatus();
  const [dirty, setDirty] = useState(false);
  const { data, error, loading, reload } = resource;
  const current = TABS.some((entry) => entry.id === tab) ? tab : "packet";
  const changed = () => {
    reload({ quiet: true });
    status.reload({ quiet: true });
    onChanged?.();
  };
  const career = data ? (data.interviews?.length ?? 0) + (data.offers?.length ?? 0) : 0;
  const tabs = TABS.map((entry) => ({ ...entry, count: entry.id === "career" && career ? career : undefined }));
  return html`<${EditorDrawer}
    wide
    dirty=${dirty}
    title=${data ? `${data.job.company}: ${data.job.title}` : "Application"}
    sub=${data ? html`<span class="row"><${Plate} value=${data.application.status} /><span class="mono">${data.application.id}</span></span>` : null}
    onClose=${onClose}
  >
    ${error ? html`<div class="drawer__section"><${ErrorNotice} error=${error} onRetry=${reload} /></div>` : null}
    ${loading && !data ? html`<div class="drawer__section"><${Skeleton} lines=${8} /></div>` : null}
    ${data
      ? html`
          ${data.liveness?.status === "closed" && data.application.status !== "submitted"
            ? html`<section class="drawer__section"><${ClosedNotice} jobId=${data.job.id} liveness=${data.liveness} skipped=${data.application.status === "skipped"} /></section>`
            : null}
          <section class="drawer__section">
            <${Facts} data=${data} />
          </section>
          <div class="drawer__tabs">
            <${Tabs} label="Application" idPrefix="app" tabs=${tabs} current=${current} onChange=${(id) => setQuery({ tab: id === "packet" ? undefined : id })} />
          </div>
          <${TabPanel} idPrefix="app" current=${current}>
            ${current === "packet" ? html`<${Packet} data=${data} changed=${changed} />` : null}
            ${current === "edit" ? html`<${ApplicationEdit} key=${data.preview.packetHash} detail=${data} onDirty=${setDirty} onSaved=${changed} />` : null}
            ${current === "resume" ? html`<${ApplicationResume} detail=${data} onChanged=${changed} />` : null}
            ${current === "career" ? html`<${ApplicationCareer} detail=${data} />` : null}
            ${current === "history" ? html`<${History} events=${data.events} />` : null}
          </${TabPanel}>
        `
      : null}
  </${EditorDrawer}>`;
}
