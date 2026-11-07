import { api, artifactUrl } from "../api.js";
import { Drawer } from "../components/drawer.js";
import { Button, Check, Empty, ErrorNotice, ExternalLink, Plate, Skeleton, TierPlate } from "../components/ui.js";
import { ago, dateTime, inDays, label, money, num, when } from "../lib/format.js";
import { html, useState } from "../lib/html.js";
import { useAction, useResource } from "../lib/hooks.js";
import { navigate } from "../lib/router.js";
import { toast, useMeta, useStatus } from "../lib/store.js";

/** One application: its exact packet, the questions only a person can answer, and every decision on it. */

/** Shown wherever a posting reads closed: what it means and the ways forward. */
function ClosedNotice({ jobId, liveness, message, skipped }) {
  return html`<div class="notice notice--bad" role=${message ? "alert" : undefined}>
    <p class="notice__title">Posting closed: the employer no longer takes applications here.</p>
    <p>${message ?? `Confirmed ${ago(liveness.checkedAt)} from the ${liveness.via === "api" ? "board's API" : "posting page"}: ${liveness.detail}.`} Submission is refused while it reads closed.</p>
    ${skipped
      ? html`<p>This application is skipped. <a href=${`/jobs?job=${encodeURIComponent(jobId)}&dismissed=include`}>Re-check the job</a> if the posting reopens.</p>`
      : html`<p><a href=${`/jobs?job=${encodeURIComponent(jobId)}&dismissed=include`}>Re-check or dismiss the job</a>, or skip this application under Approval.</p>`}
  </div>`;
}

const FOLLOW_UP_STEP = { first: "first", second: "second", close: "closing" };

function eventText(event) {
  const payload = event.payload && typeof event.payload === "object" ? event.payload : {};
  const step = FOLLOW_UP_STEP[payload.kind] ?? label(payload.kind ?? "").toLowerCase();
  switch (event.type) {
    case "submission.blocked":
      return `Submission blocked: ${label(payload.code ?? "guard").toLowerCase()}`;
    case "outcome.recorded":
      return `Outcome recorded: ${label(payload.status ?? "").toLowerCase()}`;
    case "application.approval":
      return payload.decision === "rejected" ? "Packet rejected; application skipped" : "Packet approved";
    case "followup.done":
      return `Follow-up sent by you (${step})`;
    case "followup.skipped":
      return `Follow-up skipped, not sent (${step})`;
    case "followup.snoozed":
      return `Follow-up snoozed (${step})${payload.until ? ` until ${dateTime(payload.until)}` : ""}`;
    case "job.dismissed":
      return `Role dismissed${payload.reason ? `: ${payload.reason}` : ""}${payload.batchItemsSkipped ? `; taken out of ${payload.batchItemsSkipped === 1 ? "a prepared batch" : `${payload.batchItemsSkipped} prepared batches`}` : ""}`;
    case "job.restored":
      return "Role restored to the queue";
    default: {
      // Anything else reads as words: "application.prepared" becomes "Application prepared".
      const words = String(event.type).replace(/[._]+/g, " ").trim();
      return words ? words.charAt(0).toUpperCase() + words.slice(1) : "Event";
    }
  }
}

function BlockedAnswers({ application, answers, onSaved }) {
  const blocked = answers.filter((answer) => answer.blocked);
  const [values, setValues] = useState({});
  const [busy, run] = useAction(toast);
  if (blocked.length === 0) return null;
  const filled = blocked.filter((answer) => (values[answer.questionKey] ?? "").trim().length > 0);
  const save = async (event) => {
    event.preventDefault();
    const result = await run(
      () => api.post(`/api/applications/${encodeURIComponent(application.id)}/answers`, {
        answers: filled.map((answer) => ({ questionKey: answer.questionKey, answer: values[answer.questionKey].trim() })),
      }),
      { success: (saved) => (saved.outstandingQuestions.length ? `Saved; ${saved.outstandingQuestions.length} still to answer.` : "Saved. Review the packet and approve it.") },
    );
    if (result) {
      setValues({});
      onSaved();
    }
  };
  return html`<section class="drawer__section">
    <h3>Answer to continue</h3>
    <form class="stack" onSubmit=${save}>
      <p class="muted small">Only you can answer these. Your answer is recorded as a human answer and changes the packet hash, so approve again afterwards.</p>
      ${blocked.map(
        (answer) => html`<div class="field" key=${answer.questionKey}>
          <label class="field__label" for=${`answer-${answer.questionKey}`}>${answer.label} <${Plate} text=${label(answer.category)} tone="held" /></label>
          ${answer.guidance ? html`<span class="field__hint">${answer.guidance}</span>` : null}
          <textarea
            id=${`answer-${answer.questionKey}`}
            class="textarea"
            rows="2"
            value=${values[answer.questionKey] ?? ""}
            onInput=${(event) => setValues({ ...values, [answer.questionKey]: event.currentTarget.value })}
          ></textarea>
        </div>`,
      )}
      <div class="row">
        <${Button} type="submit" kind="primary" busy=${busy} disabled=${filled.length === 0}>
          ${busy ? "Saving..." : `Save ${filled.length || ""} answer${filled.length === 1 ? "" : "s"}`}
        </${Button}>
      </div>
    </form>
  </section>`;
}

function Approval({ detail, onChanged }) {
  const { application, preview, approval } = detail;
  const [busy, run] = useAction(toast);
  if (application.status === "submitted") return null;
  const current = approval?.decision === "approved" && approval.packetHash === preview.packetHash;
  const rejected = approval?.decision === "rejected";
  const unresolved = preview.unresolvedRequired.length;
  const decide = (decision) =>
    run(() => api.post(`/api/applications/${encodeURIComponent(application.id)}/approve`, { packetHash: preview.packetHash, decision }), {
      success: decision === "approved" ? "Approved this exact packet." : "Skipped. It will not be submitted.",
    }).then((result) => result && onChanged());
  return html`<section class="drawer__section">
    <h3>Approval</h3>
    <div class="stack">
      <p>Approval binds to this packet hash. Any later edit voids it.</p>
      <p class="hash">${preview.packetHash}</p>
      ${current
        ? html`<p><${Plate} text="Approved" tone="ok" /> <span class="muted small">at this hash, ${ago(approval.decidedAt)}${approval.note ? `: ${approval.note}` : ""}</span></p>`
        : null}
      ${rejected
        ? html`<p><${Plate} text="Rejected" tone="muted" /> <span class="small">${ago(approval.decidedAt)}${approval.note ? `: ${approval.note}` : ""}. It will not be submitted unless you approve it again.</span></p>`
        : null}
      ${unresolved ? html`<p class="notice notice--held">Answer ${unresolved === 1 ? "the blocked question" : `the ${unresolved} blocked questions`} before approving.</p>` : null}
      <div class="row">
        ${current ? null : html`<${Button} kind="primary" busy=${busy} disabled=${unresolved > 0} onClick=${() => decide("approved")}>Approve packet</${Button}>`}
        ${application.status === "skipped" ? null : html`<${Button} kind="ghost" busy=${busy} onClick=${() => decide("rejected")}>Skip application</${Button}>`}
      </div>
    </div>
  </section>`;
}

function Submission({ detail, onChanged }) {
  const { application, preview, job } = detail;
  const meta = useMeta().data;
  const [mode, setMode] = useState("auto");
  const [headed, setHeaded] = useState(false);
  const [packet, setPacket] = useState(null);
  const [closed, setClosed] = useState(null);
  const [confirmation, setConfirmation] = useState("");
  const [busy, run] = useAction(toast);
  const [packetBusy, setPacketBusy] = useState(false);
  if (application.status === "submitted" || application.status === "skipped") return null;
  const campaignMode = meta?.submission?.mode ?? "manual";
  const modes = ["auto", "assisted"].filter((option) => (option === "auto" ? campaignMode === "auto" : campaignMode !== "manual"));
  const chosen = modes.includes(mode) ? mode : modes[0];
  const blocked = preview.unresolvedRequired.length > 0;
  const postingClosed = detail.liveness?.status === "closed";

  const startRun = async () => {
    const result = await run(() =>
      api.post("/api/runs", {
        type: "submit",
        params: { applicationIds: [application.id], mode: chosen, headed, packetHashes: { [application.id]: preview.packetHash } },
      }),
    );
    if (result) {
      toast("Submit run started.", { href: `/runs?run=${encodeURIComponent(result.runId)}`, linkText: "Watch it" });
      navigate(`/runs?run=${encodeURIComponent(result.runId)}`);
    }
  };
  const manual = async () => {
    setPacketBusy(true);
    setClosed(null);
    try {
      const result = await api.post(`/api/applications/${encodeURIComponent(application.id)}/submit`, { mode: "manual" });
      setPacket(result.packetText);
    } catch (error) {
      if (error?.code === "posting_closed") setClosed(error.message);
      else toast(error?.message ?? String(error), { tone: "bad" });
    } finally {
      setPacketBusy(false);
    }
  };
  const record = async (event) => {
    event.preventDefault();
    const result = await run(
      () => api.post(`/api/applications/${encodeURIComponent(application.id)}/record-submission`, confirmation.trim() ? { confirmationRef: confirmation.trim() } : {}),
      { success: "Recorded as submitted." },
    );
    if (result) onChanged();
  };

  return html`<section class="drawer__section">
    <h3>Send</h3>
    <div class="stack">
      ${modes.length
        ? html`<div class="stack">
            <p>Submit in a browser through a run you can watch and cancel. Starting it approves the packet above if it is not approved yet.</p>
            <div class="row">
              <div class="field">
                <label class="field__label" for="submit-mode">Mode</label>
                <select id="submit-mode" class="select" value=${chosen} onChange=${(event) => setMode(event.currentTarget.value)}>
                  ${modes.map((option) => html`<option value=${option}>${option === "auto" ? "Auto: fill and submit" : "Assisted: fill, you submit"}</option>`)}
                </select>
              </div>
              <${Check} checked=${headed || chosen === "assisted" || job.ats === "ashby"} disabled=${chosen === "assisted" || job.ats === "ashby"} onChange=${setHeaded}>Show the browser window</${Check}>
            </div>
            <div class="row">
              <${Button} kind="primary" busy=${busy} disabled=${blocked || postingClosed} onClick=${startRun}>Start submit run</${Button}>
              ${blocked ? html`<span class="small muted">Answer the blocked questions first.</span>` : null}
              ${postingClosed && !blocked ? html`<span class="small muted">The posting reads closed; re-check it on the job first.</span>` : null}
            </div>
          </div>`
        : html`<p class="muted">The campaign's submission mode is manual, so send this one by hand.</p>`}
      <details open=${closed ? true : undefined}>
        <summary>Send by hand instead</summary>
        <div class="stack" style=${{ marginTop: "0.75rem" }}>
          <p class="small muted">Shows the approved packet to copy into the employer's form, then record the submission so limits and pacing stay accurate.</p>
          <div><${Button} busy=${packetBusy} onClick=${manual}>Show packet to send</${Button}></div>
          ${closed ? html`<${ClosedNotice} jobId=${job.id} message=${closed} />` : null}
          ${packet ? html`<pre class="packet" tabindex="0">${packet}</pre>` : null}
          <form class="row" onSubmit=${record}>
            <div class="field" style=${{ flex: "1 1 16rem" }}>
              <label class="field__label" for="confirmation-ref">Confirmation reference (optional)</label>
              <input id="confirmation-ref" class="input" value=${confirmation} onInput=${(event) => setConfirmation(event.currentTarget.value)} />
            </div>
            <${Button} type="submit" busy=${busy} label="Record this application as submitted">Record as submitted</${Button}>
          </form>
        </div>
      </details>
    </div>
  </section>`;
}

function Outcome({ detail, onChanged }) {
  const { application, outcomes } = detail;
  const meta = useMeta().data;
  const kinds = meta?.outcomes?.kinds ?? meta?.outcomeStatuses ?? [];
  const [status, setStatus] = useState("");
  const [note, setNote] = useState("");
  const [busy, run] = useAction(toast);
  if (application.status !== "submitted" && outcomes.length === 0) return null;
  const chosen = status || kinds[0] || "";
  const save = async (event) => {
    event.preventDefault();
    const result = await run(() => api.post(`/api/applications/${encodeURIComponent(application.id)}/outcome`, { status: chosen, detail: note.trim() }), {
      success: `Recorded: ${label(chosen).toLowerCase()}.`,
    });
    if (result) {
      setNote("");
      onChanged();
    }
  };
  return html`<section class="drawer__section">
    <h3>Outcome</h3>
    ${outcomes.length
      ? html`<ol class="stack" style=${{ margin: "0 0 1rem", paddingLeft: "1.1rem" }}>
          ${outcomes.map((outcome) => html`<li><${Plate} value=${outcome.status} /> <span class="small muted">${dateTime(outcome.notedAt)}</span>${outcome.detail ? html` <span class="small">${outcome.detail}</span>` : null}</li>`)}
        </ol>`
      : null}
    <form class="row" onSubmit=${save}>
      <div class="field">
        <label class="field__label" for="outcome-status">What happened</label>
        <select id="outcome-status" class="select" value=${chosen} onChange=${(event) => setStatus(event.currentTarget.value)}>
          ${kinds.map((value) => html`<option value=${value}>${label(value)}</option>`)}
        </select>
      </div>
      <div class="field" style=${{ flex: "1 1 14rem" }}>
        <label class="field__label" for="outcome-note">Note (optional)</label>
        <input id="outcome-note" class="input" value=${note} onInput=${(event) => setNote(event.currentTarget.value)} />
      </div>
      <${Button} type="submit" busy=${busy} disabled=${!chosen}>Record outcome</${Button}>
    </form>
  </section>`;
}

/** Interviews and offers on this application, linking to the page where they are worked. */
function AfterApplying({ detail }) {
  const interviews = detail.interviews ?? [];
  const offers = detail.offers ?? [];
  if (interviews.length === 0 && offers.length === 0) return null;
  return html`<section class="drawer__section">
    <h3>Interviews and offers</h3>
    <ul class="plain-list">
      ${interviews.map(
        (interview) => html`<li key=${interview.id}>
          <a href=${`/interviews?interview=${encodeURIComponent(interview.id)}`}>${label(interview.stage)}</a>
          <${Plate} value=${interview.status} />
          <span class="cell-sub">${interview.scheduledAt ? `${when(interview.scheduledAt)} (${inDays(interview.daysUntil)})` : "Not scheduled yet"}</span>
        </li>`,
      )}
      ${offers.map(
        (offer) => html`<li key=${offer.id}>
          <a href="/interviews?tab=offers">Offer${offer.level ? `, ${offer.level}` : ""}: ${money(offer.base, offer.currency)} base</a>
          <${Plate} value=${offer.status} />
          ${offer.deadline ? html`<span class="cell-sub">Decide by ${offer.deadline} (${inDays(offer.daysToDeadline)})</span>` : null}
        </li>`,
      )}
    </ul>
  </section>`;
}

function AnswersTable({ answers }) {
  if (answers.length === 0) return html`<p class="muted">No questions were recorded for this application.</p>`;
  return html`<div class="table-wrap">
    <table class="table">
      <caption class="sr-only">Answers in this packet</caption>
      <thead><tr><th scope="col">Question</th><th scope="col">Answer</th><th scope="col">Source</th></tr></thead>
      <tbody>
        ${answers.map(
          (answer) => html`<tr key=${answer.questionKey}>
            <td><span class="cell-main" style=${{ fontWeight: 500 }}>${answer.label}</span>${answer.required ? null : html`<span class="cell-sub">Optional</span>`}</td>
            <td style=${{ maxWidth: "22rem", overflowWrap: "anywhere" }}>${answer.blocked ? html`<${Plate} text="Needs your answer" tone="held" />` : answer.answer || html`<span class="muted">${answer.notApplicable ? "Not applicable" : "Blank"}</span>`}</td>
            <td><${Plate} value=${answer.source} tone=${answer.source === "human" ? "info" : answer.source === "blocked" ? "held" : "muted"} title=${answer.citation || undefined} /></td>
          </tr>`,
        )}
      </tbody>
    </table>
  </div>`;
}

function Screenshots({ artifacts }) {
  if (artifacts.length === 0) return html`<p class="muted">No screenshots. They are saved when a browser run reaches a form.</p>`;
  return html`<div class="shots">
    ${artifacts.map(
      (artifact) => html`<a class="shot" href=${artifactUrl(artifact.name)} target="_blank" rel="noopener noreferrer" key=${artifact.name}>
        <img src=${artifactUrl(artifact.name)} alt=${`Screenshot at the ${label(artifact.stage).toLowerCase()} stage`} loading="lazy" />
        <span>${label(artifact.stage)} · ${ago(artifact.modifiedAt)}</span>
      </a>`,
    )}
  </div>`;
}

export function ApplicationDetail({ applicationId, onClose, onChanged }) {
  const resource = useResource(() => api.get(`/api/applications/${encodeURIComponent(applicationId)}`), [applicationId]);
  const status = useStatus();
  const { data, error, loading, reload } = resource;
  const changed = () => {
    reload({ quiet: true });
    status.reload({ quiet: true });
    onChanged?.();
  };
  return html`<${Drawer}
    wide
    title=${data ? `${data.job.company}: ${data.job.title}` : "Application"}
    sub=${data ? html`<span class="row"><${Plate} value=${data.application.status} /><span class="mono">${data.application.id}</span></span>` : null}
    onClose=${onClose}
  >
    ${error ? html`<${ErrorNotice} error=${error} onRetry=${reload} />` : null}
    ${loading && !data ? html`<${Skeleton} lines=${8} />` : null}
    ${data
      ? html`
          ${data.liveness?.status === "closed" && data.application.status !== "submitted"
            ? html`<section class="drawer__section"><${ClosedNotice} jobId=${data.job.id} liveness=${data.liveness} skipped=${data.application.status === "skipped"} /></section>`
            : null}
          <section class="drawer__section">
            <dl class="facts">
              <dt>Posting</dt>
              <dd class="row">
                <${ExternalLink} href=${data.job.url}>Posting</${ExternalLink}>
                <${ExternalLink} href=${data.job.applyUrl}>Apply page</${ExternalLink}>
                <a href=${`/jobs?job=${encodeURIComponent(data.job.id)}&dismissed=include`}>Evaluation</a>
              </dd>
              ${data.evaluation
                ? html`<dt>Fit</dt><dd class="row">Score ${num(Math.round(data.evaluation.score))} <${TierPlate} tier=${data.evaluation.tier} /> ${data.evaluation.trackId ?? ""}</dd>`
                : null}
              ${data.liveness && data.liveness.status !== "closed"
                ? html`<dt>Still open</dt><dd><${Plate} value=${data.liveness.status} text=${data.liveness.status === "open" ? "Open" : "Unconfirmed"} /> <span class="small muted">checked ${ago(data.liveness.checkedAt)}</span></dd>`
                : null}
              <dt>Resume</dt><dd>${data.application.resumeId} <span class="muted small">(${data.application.resumeFile})</span> <a class="small" href=${`/documents?app=${encodeURIComponent(data.application.id)}`}>Documents</a></dd>
              <dt>Prepared</dt><dd>${dateTime(data.application.createdAt)}</dd>
              ${data.application.submittedAt
                ? html`<dt>Submitted</dt><dd>${dateTime(data.application.submittedAt)} · ${label(data.application.submissionMode)}${data.application.confirmationRef ? html`<span class="cell-sub">${data.application.confirmationRef}</span>` : null}</dd>`
                : null}
            </dl>
          </section>
          <${BlockedAnswers} application=${data.application} answers=${data.answers} onSaved=${changed} />
          <${Approval} detail=${data} onChanged=${changed} />
          <${Submission} detail=${data} onChanged=${changed} />
          <${Outcome} detail=${data} onChanged=${changed} />
          <${AfterApplying} detail=${data} />
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
          <section class="drawer__section">
            <h3>History</h3>
            ${data.events.length
              ? html`<ol class="stack small" style=${{ margin: 0, paddingLeft: "1.1rem" }}>
                  ${data.events.map(
                    (event) => html`<li key=${event.id}>
                      <strong class=${event.type === "submission.blocked" && event.payload?.code === "posting_closed" ? "text-bad" : undefined}>${eventText(event)}</strong>
                      <span class="muted"> ${dateTime(event.ts)}</span>
                    </li>`,
                  )}
                </ol>`
              : html`<${Empty} title="No recorded events" />`}
          </section>
        `
      : null}
  </${Drawer}>`;
}
