import { api } from "../api.js";
import { CompanyNotes } from "../components/company-notes.js";
import { DismissConfirm, dismissedText } from "../components/dismiss.js";
import { Drawer } from "../components/drawer.js";
import { StoryMatch } from "../components/story-match.js";
import { Button, Check, Empty, ErrorNotice, ExternalLink, Plate, Skeleton, TierPlate } from "../components/ui.js";
import { ago, dateTime, label, num } from "../lib/format.js";
import { html, useState } from "../lib/html.js";
import { useAction, useResource } from "../lib/hooks.js";
import { navigate } from "../lib/router.js";
import { toast, useStatus } from "../lib/store.js";

/** One posting: why it was accepted or rejected, whether it is still open and real, and what to do with it. */

const VERDICT_TEXT = { open: "Open", closed: "Closed", unknown: "Unconfirmed" };
const LEGITIMACY_TEXT = { high: "Looks genuine", caution: "Caution", suspicious: "Suspicious" };
const SIGNAL_TONES = { positive: "ok", info: "muted", low: "info", medium: "warn", high: "bad" };
const SIGNAL_TEXT = { positive: "Good sign", info: "Note", low: "Minor", medium: "Concern", high: "Serious" };

function Liveness({ job, data, onChecked }) {
  const [busy, run] = useAction(toast);
  const history = data.liveness?.history ?? [];
  const latest = history[0] ?? null;
  const legitimacy = data.legitimacy;
  const check = async () => {
    const result = await run(() => api.post(`/api/jobs/${encodeURIComponent(job.id)}/liveness`, { force: true }), {
      success: (checked) => `Checked: ${(VERDICT_TEXT[checked.verdict.status] ?? checked.verdict.status).toLowerCase()}. ${checked.verdict.detail}`,
    });
    if (result) onChecked();
  };
  return html`<section class="drawer__section">
    <div class="section__head">
      <h3>Still open and genuine?</h3>
      <${Button} small busy=${busy} onClick=${check}>${busy ? "Checking..." : "Check now"}</${Button}>
    </div>
    <dl class="facts">
      <dt>Posting</dt>
      <dd>
        ${latest
          ? html`<span class="row"><${Plate} value=${latest.status} text=${VERDICT_TEXT[latest.status] ?? label(latest.status)} /> <span class="small muted">${ago(latest.checkedAt)}, from the ${latest.via === "api" ? "board's API" : "posting page"}</span></span>
              <span class="cell-sub">${latest.detail}</span>`
          : html`<span class="muted">Not checked yet. Checking asks the board, then the posting page; only a confirmed closure blocks anything.</span>`}
      </dd>
      ${legitimacy?.listing
        ? html`<dt>Listing</dt><dd>${legitimacy.listing.status === "absent" ? html`<${Plate} text="Gone from the board" tone="warn" /> ` : null}<span class="small">${legitimacy.listing.detail}</span></dd>`
        : null}
      ${legitimacy?.tier
        ? html`<dt>Signals</dt>
            <dd>
              <span class="row"><${Plate} value=${legitimacy.tier} text=${LEGITIMACY_TEXT[legitimacy.tier] ?? label(legitimacy.tier)} /><span class="small">${legitimacy.summary}</span></span>
            </dd>`
        : null}
      ${legitimacy?.repost?.reposted
        ? html`<dt>Reposted</dt><dd class="small">${num(legitimacy.repost.postings)} postings of this role over ${num(legitimacy.repost.spanDays)} days (first seen ${dateTime(legitimacy.repost.earliestSeenAt)})</dd>`
        : null}
    </dl>
    ${legitimacy?.error ? html`<p class="small field__error">Signals could not be read: ${legitimacy.error}</p>` : null}
    ${legitimacy?.signals?.length
      ? html`<ul class="signals">
          ${legitimacy.signals.map(
            (signal) => html`<li key=${signal.id}>
              <${Plate} text=${SIGNAL_TEXT[signal.severity] ?? label(signal.severity)} tone=${SIGNAL_TONES[signal.severity] ?? "muted"} />
              <span>
                <span class="signals__what">${signal.observation}</span>
                ${signal.evidence ? html`<span class="cell-sub">${signal.evidence}</span>` : null}
              </span>
            </li>`,
          )}
        </ul>`
      : null}
    ${history.length > 1
      ? html`<details class="small" style=${{ marginTop: "0.75rem" }}>
          <summary>Earlier checks (${num(history.length - 1)})</summary>
          <ol class="plain-list">
            ${history.slice(1).map((entry) => html`<li>${VERDICT_TEXT[entry.status] ?? entry.status} · ${dateTime(entry.checkedAt)} <span class="muted">${entry.detail}</span></li>`)}
          </ol>
        </details>`
      : null}
  </section>`;
}

function Dismissal({ job, data, onChanged }) {
  const [reason, setReason] = useState("");
  const [confirming, setConfirming] = useState(false);
  const [busy, run] = useAction(toast);
  const status = useStatus();
  const application = data.application;
  const sent = application?.status === "submitted";
  const done = (result) => {
    if (!result) return;
    status.reload({ quiet: true });
    onChanged();
  };
  if (data.dismissal) {
    return html`<section class="drawer__section">
      <h3>Dismissed</h3>
      <div class="stack">
        <p>You dismissed this role ${ago(data.dismissal.dismissedAt)}${data.dismissal.reason ? html`: <q>${data.dismissal.reason}</q>.` : "."} It and the same role on other boards stay out of the queue.</p>
        ${application && application.status === "skipped"
          ? html`<p class="small muted">Its application stays skipped after a restore; prepare and approve it again to apply.</p>`
          : null}
        <div><${Button} busy=${busy} onClick=${() => run(() => api.post(`/api/jobs/${encodeURIComponent(job.id)}/restore`, {}), { success: "Restored to the queue." }).then(done)}>Restore to the queue</${Button}></div>
      </div>
    </section>`;
  }
  if (sent) return null;
  const unsent = application && application.status !== "skipped" ? 1 : 0;
  const ask = (event) => {
    event.preventDefault();
    setConfirming(true);
  };
  const cancel = () => {
    setConfirming(false);
    requestAnimationFrame(() => document.getElementById("dismiss-job")?.focus());
  };
  const dismiss = async () => {
    const result = await run(() => api.post(`/api/jobs/${encodeURIComponent(job.id)}/dismiss`, reason.trim() ? { reason: reason.trim() } : {}), {
      success: (outcome) => dismissedText(outcome),
    });
    if (result) setConfirming(false);
    done(result);
  };
  return html`<section class="drawer__section">
    <h3>Not for you?</h3>
    <form class="row" onSubmit=${ask}>
      <div class="field" style=${{ flex: "1 1 16rem" }}>
        <label class="field__label" for="dismiss-reason">Reason (optional)</label>
        <input id="dismiss-reason" class="input" maxlength="500" value=${reason} onInput=${(event) => setReason(event.currentTarget.value)} placeholder="On-site only, wrong level..." />
      </div>
      <${Button} type="submit" id="dismiss-job" disabled=${confirming}>Dismiss...</${Button}>
    </form>
    ${confirming
      ? html`<div style=${{ marginTop: "0.75rem" }}><${DismissConfirm} unsent=${unsent} busy=${busy} onConfirm=${dismiss} onCancel=${cancel} /></div>`
      : html`<p class="small muted" style=${{ marginTop: "0.5rem" }}>
          Takes this role, and the same role on any other board, out of the queue${unsent ? ". Its unsent application is skipped and loses any approval" : ""}. You confirm before anything changes.
        </p>`}
  </section>`;
}

function Components({ components }) {
  if (!components?.length) return html`<p class="muted">No score breakdown was recorded for this posting.</p>`;
  return html`<ul class="components">
    ${components.map((component) => {
      const ratio = component.weight > 0 ? Math.max(0, Math.min(1, component.earned / component.weight)) : 0;
      return html`<li key=${component.dimension}>
        <div class="component__head">
          <span>${label(component.dimension.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase())}</span>
          <span class="num">${num(Math.round(component.earned * 10) / 10)} / ${num(component.weight)}</span>
        </div>
        <div class="component__bar" aria-hidden="true"><span style=${{ "--p": ratio }}></span></div>
        <p class="component__why">${component.rationale}</p>
        ${(component.evidence ?? []).slice(0, 3).map(
          (evidence) => html`<blockquote class="quote">“${evidence.quote}”<span class="muted"> (${evidence.term})</span></blockquote>`,
        )}
      </li>`;
    })}
  </ul>`;
}

function PrepareAction({ job, evaluation, application, onPrepared }) {
  const [force, setForce] = useState(false);
  const [busy, run] = useAction(toast);
  const status = useStatus();
  if (application) {
    return html`<div class="stack">
      <p>Application <${Plate} value=${application.status} /> created ${ago(application.createdAt)}.</p>
      <div class="row">
        <a class="btn btn--primary" href=${`/applications?app=${encodeURIComponent(application.id)}`}>Open application</a>
      </div>
    </div>`;
  }
  const accepted = evaluation?.decision === "accept";
  const prepare = async () => {
    const result = await run(() => api.post(`/api/jobs/${encodeURIComponent(job.id)}/prepare`, force ? { force: true } : {}), {
      success: (prepared) =>
        prepared.status === "needs_human"
          ? `Prepared; ${prepared.questionsNeedingHuman.length} question(s) need your answer.`
          : "Prepared and ready for review.",
    });
    if (result) {
      status.reload({ quiet: true });
      onPrepared();
      navigate(`/applications?app=${encodeURIComponent(result.applicationId)}`);
    }
  };
  return html`<div class="stack">
    <p class="muted">${accepted ? "Draft the application from your profile: questions are loaded from the board and answered only from verified facts." : `This posting was ${label(evaluation?.decision ?? "not evaluated").toLowerCase()}. Preparing it anyway is a deliberate override.`}</p>
    ${accepted ? null : html`<${Check} checked=${force} onChange=${setForce}>Prepare it anyway</${Check}>`}
    <div class="row">
      <${Button} kind="primary" busy=${busy} disabled=${!accepted && !force} onClick=${prepare}>${busy ? "Preparing..." : "Prepare application"}</${Button}>
    </div>
  </div>`;
}

export function JobDetail({ jobId, onClose, onChanged }) {
  const { data, error, loading, reload } = useResource(() => api.get(`/api/jobs/${encodeURIComponent(jobId)}`), [jobId]);
  const job = data?.job;
  const evaluation = data?.evaluation;
  const changed = () => {
    reload({ quiet: true });
    onChanged?.();
  };
  return html`<${Drawer}
    title=${job ? job.title : "Posting"}
    sub=${job ? html`${job.companyName} · ${job.locationsRaw.join(" | ") || label(job.locationClass)}` : null}
    onClose=${onClose}
  >
    ${error ? html`<${ErrorNotice} error=${error} onRetry=${reload} />` : null}
    ${loading && !data ? html`<${Skeleton} lines=${6} />` : null}
    ${data
      ? html`
          <section class="drawer__section">
            <dl class="facts">
              <dt>Decision</dt>
              <dd class="row">
                ${data.dismissal ? html`<${Plate} text="Dismissed" tone="muted" />` : null}
                <${Plate} value=${evaluation?.decision ?? "unknown"} />
                ${evaluation ? html`<span>Score <strong>${num(Math.round(evaluation.score))}</strong></span> <${TierPlate} tier=${evaluation.tier} />` : null}
              </dd>
              ${evaluation?.gate?.rule ? html`<dt>Gate</dt><dd><strong>${label(evaluation.gate.rule)}</strong>: ${evaluation.gate.reason}</dd>` : null}
              ${evaluation?.trackId ? html`<dt>Track</dt><dd>${evaluation.trackId}</dd>` : null}
              <dt>Pay</dt><dd>${job.compensation?.raw || "Not published"}</dd>
              <dt>Workplace</dt><dd>${label(job.workplaceType)} · ${label(job.locationClass)}</dd>
              <dt>Posted</dt><dd>${job.postedAt ? dateTime(job.postedAt) : "Unknown"} · ${label(job.ats)}</dd>
              <dt>Links</dt>
              <dd class="row"><${ExternalLink} href=${job.url}>Posting</${ExternalLink}><${ExternalLink} href=${job.applyUrl}>Apply page</${ExternalLink}><a href=${`/reports?job=${encodeURIComponent(job.id)}`}>Evaluation reports</a></dd>
              ${evaluation?.flags?.length ? html`<dt>Flags</dt><dd class="row">${evaluation.flags.map((flag) => html`<${Plate} text=${flag} tone="warn" />`)}</dd>` : null}
            </dl>
          </section>
          <section class="drawer__section">
            <h3>Application</h3>
            ${data.dismissal && !data.application
              ? html`<p class="muted">Dismissed roles are not prepared. Restore it below to prepare it.</p>`
              : html`<${PrepareAction} job=${job} evaluation=${evaluation} application=${data.application} onPrepared=${changed} />`}
          </section>
          <${Liveness} job=${job} data=${data} onChecked=${changed} />
          <${Dismissal} job=${job} data=${data} onChanged=${changed} />
          <section class="drawer__section">
            <h3>Score breakdown</h3>
            <${Components} components=${evaluation?.components} />
          </section>
          <${StoryMatch} key=${job.id} jobId=${job.id} />
          <${CompanyNotes} company=${job.companyName} />
          ${data.duplicates.length
            ? html`<section class="drawer__section">
                <h3>Same role elsewhere</h3>
                <ul class="stack" style=${{ margin: 0, paddingLeft: "1.1rem" }}>
                  ${data.duplicates.map((other) => html`<li key=${other.id}><a href=${`/jobs?job=${encodeURIComponent(other.id)}`}>${other.company}: ${other.title}</a> <span class="muted small">${label(other.ats)}</span></li>`)}
                </ul>
              </section>`
            : null}
          <section class="drawer__section">
            <h3>Posting text</h3>
            <p class="small muted" style=${{ marginBottom: "0.5rem" }}>Written by the employer and shown as plain text. Nothing in it is acted on.</p>
            ${job.descriptionText ? html`<div class="posting">${job.descriptionText}${job.descriptionTruncated ? "\n..." : ""}</div>` : html`<${Empty} title="No description stored" />`}
          </section>
        `
      : null}
  </${Drawer}>`;
}
