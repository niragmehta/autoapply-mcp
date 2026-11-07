import { api } from "../api.js";
import { CompanyNotes } from "../components/company-notes.js";
import { ConfirmInline } from "../components/confirm.js";
import { Drawer } from "../components/drawer.js";
import { Button, Empty, ErrorNotice, ExternalLink, Icon, Plate, Skeleton } from "../components/ui.js";
import { dateTime, label, when } from "../lib/format.js";
import { html, useState } from "../lib/html.js";
import { useAction, useResource } from "../lib/hooks.js";
import { Markdown } from "../lib/markdown.js";
import { toast, useStatus } from "../lib/store.js";
import { safeHref } from "../lib/urls.js";
import { EditInterviewForm, SessionForm, stageLabel } from "./interview-forms.js";

/** One interview: when and with whom, rescheduling and status, the prep sheet, debriefs, and the company's notes. */

export function IcsLink({ interview }) {
  if (!interview.scheduledAt) return html`<span class="muted small">No time yet</span>`;
  return html`<a class="nowrap" href=${`/api/interviews/${encodeURIComponent(interview.id)}/ics`} download>
    <${Icon} name="download" /> Calendar file
  </a>`;
}

const SESSION_LABEL = { plan: "Prep plan", practice: "Practice", debrief: "Debrief", redflags: "Red-flag review" };

export function SessionList({ sessions }) {
  if (!sessions.length) return null;
  return html`<ul class="rows sessions">
    ${sessions.map(
      (session) => html`<li class="session" key=${session.id}>
        <div class="row"><${Plate} text=${SESSION_LABEL[session.kind] ?? label(session.kind)} tone="info" /><span class="small muted">${dateTime(session.createdAt)}</span></div>
        <${Markdown} text=${session.content} />
      </li>`,
    )}
  </ul>`;
}

function StatusActions({ interview, onChanged }) {
  const [busy, run] = useAction(toast);
  const [confirmCancel, setConfirmCancel] = useState(false);
  const status = useStatus();
  const change = async (next, success) => {
    const result = await run(() => api.patch(`/api/interviews/${encodeURIComponent(interview.id)}`, { status: next }), { success });
    if (!result) return;
    setConfirmCancel(false);
    status.reload({ quiet: true });
    onChanged(result.interview);
  };
  if (confirmCancel) {
    return html`<${ConfirmInline} title="Cancel this interview?" confirmLabel="Cancel interview" cancelLabel="Keep it" busy=${busy} onConfirm=${() => change("cancelled", "Marked as cancelled.")} onCancel=${() => setConfirmCancel(false)}>
      <p>It stays in the history as cancelled; its debriefs and notes are kept. You can reopen it later.</p>
    </${ConfirmInline}>`;
  }
  if (interview.status === "scheduled") {
    return html`<div class="row">
      <${Button} busy=${busy} onClick=${() => change("done", "Marked as done. Add a debrief while it is fresh.")}>Mark as done</${Button}>
      <${Button} kind="ghost" onClick=${() => setConfirmCancel(true)}>Cancel interview...</${Button}>
    </div>`;
  }
  return html`<div class="row">
    <span class="small muted">This interview is ${interview.status}.</span>
    <${Button} small busy=${busy} onClick=${() => change("scheduled", "Reopened as scheduled.")}>Reopen</${Button}>
  </div>`;
}

export function InterviewDetail({ interviewId, onClose, onChanged }) {
  const { data, error, loading, reload } = useResource(() => api.get(`/api/interviews/${encodeURIComponent(interviewId)}`), [interviewId]);
  const [editing, setEditing] = useState(false);
  const [writing, setWriting] = useState(false);
  const interview = data?.interview;
  const changed = () => {
    reload({ quiet: true });
    onChanged?.();
  };
  const link = interview ? safeHref(interview.locationOrLink) : null;
  return html`<${Drawer}
    wide
    title=${interview ? `${stageLabel(interview.stage)}: ${interview.company}` : "Interview"}
    sub=${interview ? interview.title : null}
    onClose=${onClose}
  >
    ${error ? html`<div class="drawer__section"><${ErrorNotice} error=${error} onRetry=${reload} /></div>` : null}
    ${loading && !data ? html`<div class="drawer__section"><${Skeleton} lines=${6} /></div>` : null}
    ${interview
      ? html`
          <section class="drawer__section stack">
            <dl class="facts">
              <dt>When</dt><dd>${interview.scheduledAt ? `${when(interview.scheduledAt)} · ${interview.durationMinutes ?? 45} min` : "Not booked yet"}</dd>
              <dt>Status</dt><dd><${Plate} value=${interview.status} /></dd>
              ${interview.format ? html`<dt>Format</dt><dd>${label(interview.format)}</dd>` : null}
              ${interview.locationOrLink ? html`<dt>Where</dt><dd>${link ? html`<${ExternalLink} href=${link}>${interview.locationOrLink}</${ExternalLink}>` : interview.locationOrLink}</dd>` : null}
              ${interview.interviewers.length ? html`<dt>With</dt><dd>${interview.interviewers.map((person) => (person.role ? `${person.name} (${person.role})` : person.name)).join(", ")}</dd>` : null}
              <dt>Application</dt><dd><a href=${`/applications?app=${encodeURIComponent(interview.applicationId)}`}>${interview.company}: ${interview.title}</a></dd>
              <dt>Calendar</dt><dd><${IcsLink} interview=${interview} /></dd>
            </dl>
            ${interview.notes && !editing ? html`<p class="small prose">${interview.notes}</p>` : null}
            <div class="row">
              <a class="btn btn--primary" href=${`/prep?interview=${encodeURIComponent(interview.id)}`}>Open prep sheet</a>
              ${editing ? null : html`<${Button} onClick=${() => setEditing(true)}>Edit or reschedule</${Button}>`}
            </div>
            ${editing ? null : html`<${StatusActions} interview=${interview} onChanged=${changed} />`}
          </section>
          ${editing
            ? html`<section class="drawer__section">
                <h3>Edit or reschedule</h3>
                <${EditInterviewForm} interview=${interview} onSaved=${() => {
                  setEditing(false);
                  changed();
                }} onCancel=${() => setEditing(false)} />
              </section>`
            : null}
          <section class="drawer__section">
            <div class="section__head">
              <h3>Debriefs and prep notes</h3>
              ${writing ? null : html`<${Button} small onClick=${() => setWriting(true)}>${interview.status === "scheduled" ? "Add a note" : "Add a debrief"}</${Button}>`}
            </div>
            ${writing
              ? html`<div class="panel panel--pad"><${SessionForm} applicationId=${interview.applicationId} interviewId=${interview.id} onSaved=${() => {
                  setWriting(false);
                  changed();
                }} onCancel=${() => setWriting(false)} /></div>`
              : null}
            ${data.sessions.length
              ? html`<${SessionList} sessions=${data.sessions} />`
              : writing
                ? null
                : html`<${Empty} title="Nothing written yet">After the interview, a debrief of what they asked and how it went makes the next round and your follow-up easier.</${Empty}>`}
          </section>
          <${CompanyNotes} company=${interview.company} />
        `
      : null}
  </${Drawer}>`;
}
