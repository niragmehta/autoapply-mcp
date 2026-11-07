import { api, artifactUrl } from "../api.js";
import { Button, Check, Empty, ErrorNotice, PageHead, Plate, Skeleton } from "../components/ui.js";
import { label, plural } from "../lib/format.js";
import { html, useState } from "../lib/html.js";
import { useAction, useResource, useTitle } from "../lib/hooks.js";
import { toast, useStatus } from "../lib/store.js";

/**
 * The needs-human queue, one block per question. The same question recurs
 * across employers, so one answer can release every application waiting on it.
 */

function QuestionBlock({ group, onAnswered }) {
  const [answer, setAnswer] = useState("");
  const [selected, setSelected] = useState(() => new Set(group.applications.map((member) => member.applicationId)));
  const [busy, run] = useAction(toast);
  const inputId = `answer-${group.key}`;
  const chosen = group.applications.filter((member) => selected.has(member.applicationId));
  const long = group.category === "essay" || group.label.length > 90;

  const toggle = (applicationId, on) => {
    const next = new Set(selected);
    if (on) next.add(applicationId);
    else next.delete(applicationId);
    setSelected(next);
  };

  const submit = async (event) => {
    event.preventDefault();
    const text = answer.trim();
    if (!text || chosen.length === 0) return;
    const result = await run(() =>
      api.post("/api/needs-human/answers", {
        items: chosen.map((member) => ({ applicationId: member.applicationId, questionKey: member.questionKey, answer: text })),
      }),
    );
    if (!result) return;
    const ready = result.results.filter((entry) => entry.ok && entry.status !== "needs_human").length;
    toast(
      `Answered for ${plural(result.updated, "application")}${ready ? `; ${ready} now awaiting approval` : ""}${result.failed ? `; ${result.failed} failed` : ""}.`,
      { tone: result.failed ? "bad" : "ok", href: ready ? "/applications?status=awaiting_approval" : undefined, linkText: "Review" },
    );
    setAnswer("");
    onAnswered();
  };

  return html`<form class="question" onSubmit=${submit} aria-labelledby=${`${inputId}-label`}>
    <div class="question__head">
      <h2 class="question__label" id=${`${inputId}-label`}>${group.label}</h2>
      <${Plate} text=${label(group.category)} tone="held" />
      <span class="small muted">${plural(group.applications.length, "application")}</span>
    </div>
    ${group.guidance ? html`<p class="question__guidance">${group.guidance}</p>` : null}
    <ul class="question__apps" aria-label="Applications waiting on this answer">
      ${group.applications.map(
        (member) => html`<li key=${member.applicationId}>
          <${Check} checked=${selected.has(member.applicationId)} onChange=${(on) => toggle(member.applicationId, on)}>
            <strong>${member.company}</strong> <span class="muted">${member.title}</span>
          </${Check}>
          <a class="small" href=${`/applications?app=${encodeURIComponent(member.applicationId)}`}>Open</a>
          ${member.screenshot ? html`<a class="small" href=${artifactUrl(member.screenshot)} target="_blank" rel="noopener noreferrer">Last screenshot</a>` : null}
        </li>`,
      )}
    </ul>
    ${group.previousAnswers.length
      ? html`<div class="stack" style=${{ gap: "0.25rem" }}>
          <span class="small muted">You answered this before:</span>
          <div class="chips">
            ${group.previousAnswers.map((previous) => html`<button type="button" class="chip" onClick=${() => setAnswer(previous)}>${previous.length > 60 ? `${previous.slice(0, 60)}...` : previous}</button>`)}
          </div>
        </div>`
      : null}
    <div class="question__answer">
      <div class="field">
        <label class="field__label" for=${inputId}>Your answer</label>
        ${long
          ? html`<textarea id=${inputId} class="textarea" rows="3" value=${answer} onInput=${(event) => setAnswer(event.currentTarget.value)}></textarea>`
          : html`<input id=${inputId} class="input" value=${answer} onInput=${(event) => setAnswer(event.currentTarget.value)} />`}
      </div>
      <${Button} type="submit" kind="primary" busy=${busy} disabled=${!answer.trim() || chosen.length === 0}>
        ${busy ? "Saving..." : `Answer ${plural(chosen.length, "application")}`}
      </${Button}>
    </div>
  </form>`;
}

export default function NeedsHuman() {
  useTitle("Needs human");
  const queue = useResource(() => api.get("/api/needs-human"), []);
  const status = useStatus();
  const data = queue.data;
  const refresh = () => {
    queue.reload({ quiet: true });
    status.reload({ quiet: true });
  };

  return html`<div>
    <${PageHead}
      title="Needs human"
      sub=${data ? `${plural(data.applications, "application")} held on ${plural(data.questions.length, "question")}` : "Questions only you can answer"}
    />
    ${queue.error ? html`<${ErrorNotice} error=${queue.error} onRetry=${queue.reload} />` : null}
    ${queue.loading && !data ? html`<div class="panel panel--pad"><${Skeleton} lines=${5} /></div>` : null}
    ${data && data.questions.length === 0 && data.otherBlockers.length === 0
      ? html`<div class="panel"><${Empty} title="Nothing is held for you">
          When an application asks something only you can answer (sponsorship, salary, a legal attestation), it waits here, grouped with every other application asking the same thing.
        </${Empty}></div>`
      : null}
    ${data && data.questions.length
      ? html`<p class="small muted" style=${{ marginBottom: "0.75rem" }}>
            Answers are recorded as your own and change each packet's hash, so the applications move to Awaiting approval rather than straight to submission.
          </p>
          <div class="panel">${data.questions.map((group) => html`<${QuestionBlock} key=${group.key} group=${group} onAnswered=${refresh} />`)}</div>`
      : null}
    ${data && data.otherBlockers.length
      ? html`<section class="section" aria-labelledby="other-blockers">
          <div class="section__head">
            <h2 id="other-blockers">Held for another reason</h2>
            <p class="section__note">Open each to see what the submission engine reported.</p>
          </div>
          <ul class="rows">
            ${data.otherBlockers.map(
              (item) => html`<li key=${item.applicationId}>
                <a class="action-row" href=${`/applications?app=${encodeURIComponent(item.applicationId)}`} style=${{ gridTemplateColumns: "minmax(0, 1fr) auto" }}>
                  <span>
                    <span class="action-row__label">${item.company}: ${item.title}</span>
                    <span class="action-row__detail">${item.reason}</span>
                  </span>
                  <${Plate} value="needs_human" />
                </a>
              </li>`,
            )}
          </ul>
        </section>`
      : null}
  </div>`;
}
