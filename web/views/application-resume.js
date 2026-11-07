import { api } from "../api.js";
import { ConfirmInline } from "../components/confirm.js";
import { FormError, TextField, useSubmit } from "../components/form.js";
import { Button, Empty, ErrorNotice, Icon, Plate, Skeleton } from "../components/ui.js";
import { dateTime, label } from "../lib/format.js";
import { html, useState } from "../lib/html.js";
import { useResource } from "../lib/hooks.js";
import { toast } from "../lib/store.js";

/**
 * The resume an application uploads, and tailoring it to the posting: a new
 * PDF from resume.json with groups, bullets and skills reordered for the
 * posting, reserve bullets you wrote swapped in where they fit better, and
 * the change log that says why. Nothing is reworded or invented.
 */

const GROUPS = [
  { id: "swapped", title: "Bullets swapped in", kinds: ["bullet-swapped"] },
  { id: "added", title: "Skills added", kinds: ["skill-term-added"] },
  { id: "moved", title: "Moved", kinds: ["group-moved", "bullet-moved", "skills-moved", "skill-term-moved"] },
  { id: "dropped", title: "Dropped to fit the page", kinds: ["bullet-dropped"] },
  { id: "other", title: "Other changes", kinds: ["variant", "headline"] },
];

function groupOf(kind) {
  return GROUPS.find((group) => group.kinds.includes(kind)) ?? GROUPS[GROUPS.length - 1];
}

function Terms({ terms }) {
  if (!terms?.length) return null;
  return html`<span class="terms">${terms.map((term) => html`<${Plate} key=${term} text=${term} tone="outline" />`)}</span>`;
}

// The log's messages end in "because of terms [a, b]"; the terms are shown as chips instead, and an empty list is left out.
const TERMS_TAIL = /\s+because (of terms|the posting names)\s+\[([^\]]*)\]\.?$/;

function ChangeText({ change }) {
  const match = change.message.match(TERMS_TAIL);
  if (!match) return html`${change.message}`;
  const listed = match[2].split(",").map((term) => term.trim()).filter(Boolean);
  const terms = change.terms?.length ? change.terms : listed;
  return html`${change.message.slice(0, match.index)}${terms.length ? html` ${match[1] === "of terms" ? "because of" : "because the posting names"} <${Terms} terms=${terms} />` : null}`;
}

/** Every change, grouped by what it did. `skip` leaves out groups shown elsewhere. */
export function ChangeLog({ changes, skip = [] }) {
  const grouped = GROUPS.filter((group) => !skip.includes(group.id))
    .map((group) => ({ ...group, items: changes.filter((change) => groupOf(change.kind).id === group.id) }))
    .filter((group) => group.items.length > 0);
  if (!grouped.length) return html`<p class="small muted">No changes: the variant already suited this posting.</p>`;
  return html`<div class="changelog">
    ${grouped.map(
      (group) => html`<section key=${group.id} class="changelog__group" aria-label=${group.title}>
        <h5>${group.title} <span class="muted">(${group.items.length})</span></h5>
        <ul class="plain-list small">
          ${group.items.map(
            (change, index) => html`<li key=${index}>
              ${group.id === "swapped" && /stronger statement of the same work/.test(change.message) ? html`<${Plate} text="Stronger statement of the same work" tone="ok" /> ` : null}
              <${ChangeText} change=${change} />
            </li>`,
          )}
        </ul>
      </section>`,
    )}
  </div>`;
}

/** The swaps of a fresh tailoring, straight from its result: what came in, what went out, and why. */
function Swaps({ swaps, changes }) {
  if (!swaps?.length) return null;
  const termsFor = (id) => changes.find((change) => change.kind === "bullet-swapped" && change.target === id)?.terms ?? [];
  return html`<section class="changelog__group" aria-label="Bullets swapped in">
    <h5>Bullets swapped in <span class="muted">(${swaps.length})</span></h5>
    <ul class="plain-list small">
      ${swaps.map(
        (swap) => html`<li key=${swap.in}>
          <span class="mono">${swap.in}</span> replaced <span class="mono">${swap.out}</span>${" "}
          ${swap.upgrade
            ? html`<${Plate} text="Stronger statement of the same work" tone="ok" />`
            : html`<span>because it suits the posting better</span> <${Terms} terms=${termsFor(swap.in)} />`}
          <span class="muted"> (relevance ${swap.inScore} against ${swap.outScore})</span>
        </li>`,
      )}
    </ul>
  </section>`;
}

function AddedSkills({ skills }) {
  if (!skills?.length) return null;
  return html`<section class="changelog__group" aria-label="Skills added">
    <h5>Skills added <span class="muted">(${skills.length})</span></h5>
    <p class="small">From your reserve skills, because the posting names them: <${Terms} terms=${skills} /></p>
  </section>`;
}

function TailorResult({ result }) {
  const href = `/api/documents/files/${encodeURIComponent(result.documentId)}`;
  return html`<div class="panel panel--pad stack tailor-result" role="status">
    <div class="row">
      <${Plate} text="Now uploaded with this application" tone="ok" />
      <a href=${href} target="_blank" rel="noopener noreferrer"><${Icon} name="download" /> Open the PDF</a>
      <span class="small muted">${result.pages} page${result.pages === 1 ? "" : "s"} · headline from ${result.headline.source === "override" ? "you" : `the ${result.headline.source}`}: “${result.headline.text}”</span>
    </div>
    <p class="small">
      ${result.status === "needs_human" ? "The application is still held for you." : result.status === "awaiting_approval" ? "The application is back to awaiting your approval." : `The application is ${label(result.status).toLowerCase()}.`}
      ${result.approvalVoided ? " The approval you gave is void: approve the new packet before anything is sent." : ""}
    </p>
    ${result.jobTerms?.length
      ? html`<p class="small"><span class="field__label">The posting's strongest terms</span> <${Terms} terms=${result.jobTerms.slice(0, 12).map((term) => term.term)} /></p>`
      : null}
    <${Swaps} swaps=${result.swaps} changes=${result.changes} />
    <${AddedSkills} skills=${result.addedSkills} />
    <${ChangeLog} changes=${result.changes} skip=${["swapped", "added"]} />
    ${result.warnings?.length
      ? html`<section class="changelog__group" aria-label="Warnings">
          <h5>Warnings <span class="muted">(${result.warnings.length})</span></h5>
          <ul class="plain-list small text-warn">${result.warnings.map((warning) => html`<li>${warning}</li>`)}</ul>
        </section>`
      : null}
  </div>`;
}

/** What tailoring does to this application, said for its status before the click. */
function statusLine(status) {
  if (status === "needs_human") return "It stays held for you: a new resume answers no question and settles no submission that needs checking.";
  if (status === "failed") return "It stays marked as failed until you deal with that submission.";
  return "It goes back to awaiting your approval.";
}

function TailorAction({ application, policy, onDone }) {
  const [asking, setAsking] = useState(false);
  const [headline, setHeadline] = useState("");
  const { busy, error, errors, submit } = useSubmit();
  const run = async () => {
    const result = await submit(() => api.post(`/api/documents/${encodeURIComponent(application.id)}/tailor`, headline.trim() ? { headline: headline.trim() } : {}));
    if (!result) return;
    setAsking(false);
    setHeadline("");
    toast(result.approvalVoided ? "Tailored. The approval is void: approve the new packet." : "Tailored resume attached.", { tone: result.approvalVoided ? "bad" : "ok" });
    onDone(result);
  };
  if (!asking) {
    return html`<div class="row">
      <${Button} kind="primary" onClick=${() => setAsking(true)}>Tailor resume...</${Button}>
      ${policy && !policy.tailorResume ? html`<span class="small muted">Automatic tailoring is off in campaign.documents; this tailors this one application.</span>` : null}
    </div>`;
  }
  return html`<${ConfirmInline} title="Tailor the resume for this posting?" confirmLabel=${busy ? "Rendering and checking..." : "Tailor resume"} cancelLabel="Keep the current one" danger=${false} busy=${busy} onConfirm=${run} onCancel=${() => setAsking(false)}>
    <ul class="plain-list">
      <li>A new PDF is rendered from resume.json: groups, bullets and skills reordered for this posting${policy?.maxSwaps ? `, up to ${policy.maxSwaps} reserve bullet${policy.maxSwaps === 1 ? "" : "s"} swapped in where they clearly fit better` : ""}${policy?.maxAddedSkills ? `, up to ${policy.maxAddedSkills} reserve skill${policy.maxAddedSkills === 1 ? "" : "s"} the posting names added` : ""}. Nothing is reworded or invented.</li>
      <li>Bullets you marked keep lead their group and are never swapped out or dropped.</li>
      <li>It replaces the resume this application uploads, so the packet changes and any approval is void. ${statusLine(application.status)}</li>
    </ul>
    <${FormError} error=${error && error.code !== "fact_check_failed" ? error : null} />
    <${TextField}
      id="tailor-headline"
      label="Headline (optional)"
      value=${headline}
      onInput=${setHeadline}
      maxlength="160"
      hint="Only words your resume source and profile already hold; it is fact-checked."
      error=${errors.headline ?? (error?.code === "fact_check_failed" ? error.message : undefined)}
    />
  </${ConfirmInline}>`;
}

function History({ entries }) {
  if (!entries.length) return html`<${Empty} title="Not tailored yet">This application uploads its track's fixed variant. Tailoring renders one for this posting and keeps every past version here.</${Empty}>`;
  return html`<ol class="rows tailor-history">
    ${entries.map(
      (entry) => html`<li key=${entry.id} class="tailor-entry">
        <details open=${entry.current ? true : undefined}>
          <summary>
            ${dateTime(entry.createdAt)} · ${entry.changes.length} change${entry.changes.length === 1 ? "" : "s"}${entry.dropped.length ? `, ${entry.dropped.length} dropped` : ""}
          </summary>
          <div class="stack" style=${{ marginTop: "0.5rem" }}>
            <div class="row">
              ${entry.current ? html`<${Plate} text="Uploaded now" tone="ok" />` : html`<${Plate} text="Replaced" tone="muted" />`}
              ${entry.href ? html`<a href=${entry.href} target="_blank" rel="noopener noreferrer"><${Icon} name="download" /> ${entry.fileName}</a>` : html`<span class="small muted">${entry.fileName} (file missing)</span>`}
              ${entry.pages ? html`<span class="small muted">${entry.pages} page${entry.pages === 1 ? "" : "s"}</span>` : null}
              ${entry.headline ? html`<span class="small muted">“${entry.headline}”</span>` : null}
            </div>
            <${ChangeLog} changes=${entry.changes} />
          </div>
        </details>
      </li>`,
    )}
  </ol>`;
}

export function ApplicationResume({ detail, onChanged }) {
  const { application } = detail;
  const tailoring = useResource(() => api.get(`/api/applications/${encodeURIComponent(application.id)}/tailoring`), [application.id]);
  const [latest, setLatest] = useState(null);
  const data = tailoring.data;
  const editable = application.status !== "submitted" && application.status !== "skipped";
  return html`<div>
    <section class="drawer__section stack">
      <h3>The resume it uploads</h3>
      ${data
        ? html`<p>${data.resumeFile ? html`<span class="mono small">${data.resumeFile}</span>` : "No file"}: ${data.tailored ? "tailored for this posting." : `the fixed ${data.resumeId} variant.`}</p>`
        : null}
      ${editable
        ? html`<${TailorAction} application=${application} policy=${data?.policy} onDone=${(result) => {
            setLatest(result);
            tailoring.reload({ quiet: true });
            onChanged();
          }} />`
        : html`<p class="small muted">${application.status === "submitted" ? "Submitted: the resume it sent stays as it was." : "Skipped applications are not tailored."}</p>`}
      ${latest ? html`<${TailorResult} result=${latest} />` : null}
    </section>
    <section class="drawer__section">
      <h3>Tailoring history</h3>
      ${tailoring.error ? html`<${ErrorNotice} error=${tailoring.error} onRetry=${tailoring.reload} />` : null}
      ${tailoring.loading && !data ? html`<${Skeleton} lines=${3} />` : null}
      ${data ? html`<${History} entries=${data.entries} />` : null}
    </section>
  </div>`;
}
