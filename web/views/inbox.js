import { api } from "../api.js";
import { TabPanel, Tabs } from "../components/tabs.js";
import { Button, Empty, ErrorNotice, PageHead, Plate, Skeleton } from "../components/ui.js";
import { ago, dateTime, label, num } from "../lib/format.js";
import { html, useState } from "../lib/html.js";
import { useAction, useResource, useTitle } from "../lib/hooks.js";
import { setQuery } from "../lib/router.js";
import { toast, useMeta, useStatus } from "../lib/store.js";

/**
 * Employer replies waiting for a decision. Each one shows what it reads as,
 * which application it matches and why it was not recorded; the person
 * records the outcome (correcting kind or application) or dismisses it.
 * Reply text is untrusted and only ever shown as text.
 */

const TABS = [
  { id: "proposed", label: "To review" },
  { id: "new", label: "New" },
  { id: "recorded", label: "Recorded" },
  { id: "dismissed", label: "Dismissed" },
];

const percent = (value) => `${Math.round(Number(value ?? 0) * 100)}%`;

function asList(value) {
  return Array.isArray(value) ? value : [];
}

function ApplicationSelect({ id, value, onChange, applications, suggested = [], label: text = "Application" }) {
  const likely = applications.filter((application) => suggested.includes(application.id));
  const others = applications.filter((application) => !suggested.includes(application.id));
  const option = (application) => html`<option value=${application.id}>${application.company}: ${application.title}</option>`;
  return html`<div class="field">
    <label class="field__label" for=${id}>${text}</label>
    <select id=${id} class="select" value=${value} onChange=${(event) => onChange(event.currentTarget.value)}>
      <option value="">Choose an application</option>
      ${likely.length
        ? html`<optgroup label="Likely, from the sender">${likely.map(option)}</optgroup><optgroup label="Other submitted applications">${others.map(option)}</optgroup>`
        : others.map(option)}
    </select>
  </div>`;
}

function Decide({ reply, kinds, applications, onDone }) {
  const outcome = kinds.includes(reply.classification.kind) ? reply.classification.kind : "";
  const [kind, setKind] = useState(outcome);
  const [applicationId, setApplicationId] = useState(reply.match.applicationId ?? "");
  const [busy, run] = useAction(toast);
  const status = useStatus();
  const needsApplication = !reply.match.applicationId || reply.match.ambiguous;
  const record = async (event) => {
    event.preventDefault();
    const body = { kind, ...(applicationId && applicationId !== reply.match.applicationId ? { applicationId } : {}) };
    const result = await run(() => api.post(`/api/inbox/replies/${encodeURIComponent(reply.replyId)}/confirm`, body), {
      success: (confirmed) => confirmed.warning ?? `Recorded ${label(confirmed.kind).toLowerCase()} on the application.`,
    });
    if (result) {
      status.reload({ quiet: true });
      onDone();
    }
  };
  const dismiss = async () => {
    const result = await run(() => api.post(`/api/inbox/replies/${encodeURIComponent(reply.replyId)}/dismiss`, {}), { success: "Dismissed; nothing was recorded." });
    if (result) {
      status.reload({ quiet: true });
      onDone();
    }
  };
  return html`<form class="reply__decide" onSubmit=${record}>
    <div class="field">
      <label class="field__label" for=${`kind-${reply.replyId}`}>What happened</label>
      <select id=${`kind-${reply.replyId}`} class="select" value=${kind} onChange=${(event) => setKind(event.currentTarget.value)}>
        ${outcome ? null : html`<option value="">Choose an outcome</option>`}
        ${kinds.map((value) => html`<option value=${value}>${label(value)}</option>`)}
      </select>
    </div>
    ${needsApplication
      ? html`<${ApplicationSelect}
          id=${`app-${reply.replyId}`}
          value=${applicationId}
          onChange=${setApplicationId}
          applications=${applications}
          suggested=${asList(reply.match.candidates).map((candidate) => candidate.applicationId).filter(Boolean)}
        />`
      : null}
    <div class="reply__buttons">
      <${Button} type="submit" kind="primary" busy=${busy} disabled=${!kind || !applicationId}>Record outcome</${Button}>
      <${Button} kind="ghost" busy=${busy} onClick=${dismiss}>Dismiss</${Button}>
    </div>
  </form>`;
}

function Reply({ reply, kinds, applications, onDone }) {
  const evidence = asList(reply.classification.evidence).filter((entry) => typeof entry === "string");
  const reasons = asList(reply.reasons).filter((entry) => typeof entry === "string");
  const flags = asList(reply.injectionFlags);
  const candidates = asList(reply.match.candidates);
  return html`<li class="reply">
    <div class="reply__head">
      <span class="reply__subject">${reply.subject || "(no subject)"}</span>
      <span class="reply__meta">${reply.from || "unknown sender"} · <time datetime=${reply.receivedAt} title=${dateTime(reply.receivedAt)}>${ago(reply.receivedAt)}</time></span>
    </div>
    ${reply.snippet ? html`<p class="reply__snippet">${reply.snippet}</p>` : null}
    <dl class="facts reply__facts">
      <dt>Reads as</dt>
      <dd class="row">
        <${Plate} value=${reply.classification.kind} />
        <span class="small muted">${percent(reply.classification.confidence)} sure</span>
        ${evidence.length ? html`<span class="small">“${evidence.slice(0, 2).join("”, “")}”</span>` : null}
      </dd>
      <dt>About</dt>
      <dd>
        ${reply.match.applicationId && !reply.match.ambiguous
          ? html`<a href=${`/applications?app=${encodeURIComponent(reply.match.applicationId)}`}>${reply.match.company}: ${reply.match.title}</a> <span class="small muted">${percent(reply.match.confidence)} match</span>`
          : html`<span>No single match${candidates.length ? html`; could be ${candidates.map((candidate) => candidate.company ?? candidate.applicationId).join(" or ")}` : ""}.</span>`}
      </dd>
      ${reasons.length ? html`<dt>Waiting because</dt><dd class="small">${reasons.join("; ")}</dd>` : null}
    </dl>
    ${flags.length
      ? html`<p class="notice notice--held small">This reply contains text that reads like instructions to an AI agent. It is shown as text and never followed.</p>`
      : null}
    ${reply.status === "proposed" || reply.status === "new"
      ? html`<${Decide} reply=${reply} kinds=${kinds} applications=${applications} onDone=${onDone} />`
      : null}
  </li>`;
}

function PasteReply({ applications, onPasted }) {
  const [text, setText] = useState("");
  const [subject, setSubject] = useState("");
  const [from, setFrom] = useState("");
  const [applicationId, setApplicationId] = useState("");
  const [busy, run] = useAction(toast);
  const submit = async (event) => {
    event.preventDefault();
    const result = await run(
      () =>
        api.post("/api/inbox/paste", {
          text,
          ...(subject.trim() ? { subject: subject.trim() } : {}),
          ...(from.trim() ? { from: from.trim() } : {}),
          ...(applicationId ? { applicationId } : {}),
        }),
      {
        success: (pasted) =>
          pasted.duplicate ? "Already stored; nothing changed." : `Reads as ${label(pasted.proposal.kind).toLowerCase()}. Review it in the list and record it if it is right.`,
      },
    );
    if (result) {
      setText("");
      setSubject("");
      setFrom("");
      setApplicationId("");
      onPasted();
    }
  };
  return html`<form class="panel panel--pad stack" onSubmit=${submit}>
    <p class="muted small">For replies you did not let the dashboard read. "Subject:" and "From:" lines at the top are read as headers. Only the subject, sender and a short snippet are kept, and nothing is recorded until you confirm it.</p>
    <div class="field">
      <label class="field__label" for="paste-text">Reply text</label>
      <textarea id="paste-text" class="textarea" rows="6" required value=${text} onInput=${(event) => setText(event.currentTarget.value)}></textarea>
    </div>
    <div class="form-grid">
      <div class="field">
        <label class="field__label" for="paste-subject">Subject (optional)</label>
        <input id="paste-subject" class="input" maxlength="500" value=${subject} onInput=${(event) => setSubject(event.currentTarget.value)} />
      </div>
      <div class="field">
        <label class="field__label" for="paste-from">From (optional)</label>
        <input id="paste-from" class="input" maxlength="500" value=${from} onInput=${(event) => setFrom(event.currentTarget.value)} />
      </div>
      <${ApplicationSelect} id="paste-app" label="About (optional)" value=${applicationId} onChange=${setApplicationId} applications=${applications} />
    </div>
    <div><${Button} type="submit" kind="primary" busy=${busy} disabled=${!text.trim()}>Read this reply</${Button}></div>
  </form>`;
}

function StatusLine({ inbox }) {
  if (!inbox) return null;
  const state = !inbox.enabled ? "Mailbox reading is off" : inbox.configured ? "Reading your mailbox, read-only" : "Reading is on, but no mailbox is configured";
  return html`<p class="small muted">
    ${state}${inbox.lastScanAt ? ` · last scan ${ago(inbox.lastScanAt)}` : inbox.enabled ? " · not scanned yet" : ""}.
  </p>`;
}

export default function Inbox({ query }) {
  useTitle("Inbox");
  const tab = TABS.some((entry) => entry.id === query.get("status")) ? query.get("status") : "proposed";
  const meta = useMeta().data;
  const kinds = meta?.outcomes?.kinds ?? [];
  const inbox = useResource(() => api.get("/api/inbox"), []);
  const replies = useResource(() => api.get("/api/inbox/replies", { status: tab, limit: 100 }), [tab]);
  const applications = useResource(() => api.get("/api/applications", { status: "submitted", pageSize: 200, sort: "company", dir: "asc" }), []);
  const appRows = applications.data?.rows ?? [];
  const counts = replies.data?.byStatus ?? inbox.data?.replies ?? {};
  const refresh = () => {
    replies.reload({ quiet: true });
    inbox.reload({ quiet: true });
  };

  return html`<div>
    <${PageHead}
      title="Inbox"
      sub="Employer replies, read from your mailbox or pasted in. Nothing is recorded until you confirm it."
      actions=${html`<a class="btn" href="/runs?start=inbox">Scan the mailbox</a>`}
    />
    <${StatusLine} inbox=${inbox.data} />
    <div class="split section" style=${{ marginTop: "1rem" }}>
      <section aria-labelledby="replies-title">
        <h2 id="replies-title" class="sr-only">Replies</h2>
        <${Tabs}
          label="Reply status"
          idPrefix="replies"
          tabs=${TABS.map((entry) => ({ ...entry, count: counts[entry.id] }))}
          current=${tab}
          onChange=${(id) => setQuery({ status: id === "proposed" ? undefined : id })}
        />
        <${TabPanel} idPrefix="replies" current=${tab}>
          <p class="small muted" style=${{ marginBottom: "0.75rem" }}>${replies.data?.notice ?? "Reply text is untrusted email content and is shown as plain text."}</p>
          ${replies.error ? html`<${ErrorNotice} error=${replies.error} onRetry=${replies.reload} />` : null}
          ${replies.loading && !replies.data ? html`<div class="panel panel--pad"><${Skeleton} lines=${5} /></div>` : null}
          ${replies.data && replies.data.replies.length === 0
            ? html`<div class="panel">
                <${Empty} title=${tab === "proposed" ? "No replies waiting for you" : `No ${TABS.find((entry) => entry.id === tab).label.toLowerCase()} replies`}>
                  ${tab === "proposed" ? "Replies that need your decision appear here after a mailbox scan or when you paste one." : null}
                </${Empty}>
              </div>`
            : null}
          ${replies.data?.replies.length
            ? html`<ul class="rows">
                ${replies.data.replies.map((reply) => html`<${Reply} key=${reply.replyId} reply=${reply} kinds=${kinds} applications=${appRows} onDone=${refresh} />`)}
              </ul>`
            : null}
        </${TabPanel}>
      </section>
      <section aria-labelledby="paste-title">
        <div class="section__head"><h2 id="paste-title">Paste a reply</h2></div>
        <${PasteReply} applications=${appRows} onPasted=${() => (tab === "proposed" ? refresh() : setQuery({ status: undefined }))} />
        <p class="small muted" style=${{ marginTop: "0.75rem" }}>${num(appRows.length)} submitted application${appRows.length === 1 ? "" : "s"} to match against.</p>
      </section>
    </div>
  </div>`;
}
