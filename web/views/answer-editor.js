import { api } from "../api.js";
import { ConfirmInline, DeleteAction, EditorDrawer } from "../components/confirm.js";
import { FormError, ListInput, TextArea, TextField, useDraft, useSubmit, useUnsavedGuard } from "../components/form.js";
import { Button, ErrorNotice, Plate, Skeleton } from "../components/ui.js";
import { html, useState } from "../lib/html.js";
import { useAction, useResource } from "../lib/hooks.js";
import { toast } from "../lib/store.js";

/**
 * One answer in the library. Legally material answers open read-only behind a
 * lock that names what they are used for; the AI-policy question is fixed to
 * ask you. Everything is written to profile.json with a backup on save.
 */

export const MODES = [
  { id: "ask", title: "Ask me every time", text: "The application stops for you on this question." },
  { id: "suggest", title: "Suggest this answer", text: "Filled in as a suggestion; the application still waits for you to confirm it." },
  { id: "auto", title: "Fill it in without asking", text: "Used on every application that asks, with no stop." },
  { id: "skip", title: "Leave it blank on purpose", text: "For optional questions better left empty; it no longer holds applications." },
];

export const MODE_SHORT = { ask: "Asks you", suggest: "Suggested", auto: "Fills in", skip: "Left blank" };

const EMPTY = { key: "", label: "", patterns: [], answer: "", alternatives: [], allowAutoFill: false, skip: false, whenNoDecline: "", note: "", mode: "ask" };

function draftOf(row) {
  if (!row) return EMPTY;
  return {
    key: row.key,
    label: row.label,
    patterns: row.patterns,
    answer: row.answer,
    alternatives: row.alternatives,
    allowAutoFill: row.allowAutoFill,
    skip: row.skip,
    whenNoDecline: row.whenNoDecline ?? "",
    note: row.note ?? "",
    mode: row.mode,
  };
}

/** The body the API takes: the chosen mode decides answer, allowAutoFill and skip. */
function bodyOf(draft, initial) {
  const answer = draft.mode === "ask" ? "" : draft.answer;
  const allowAutoFill =
    draft.mode === "auto" ? true : draft.mode === "ask" ? initial.mode === "ask" && initial.allowAutoFill : draft.mode === "skip" ? draft.allowAutoFill : false;
  return {
    key: draft.key.trim(),
    label: draft.label.trim(),
    patterns: draft.patterns,
    answer,
    alternatives: draft.mode === "ask" ? [] : draft.alternatives,
    allowAutoFill,
    skip: draft.mode === "skip",
    ...(draft.whenNoDecline.trim() ? { whenNoDecline: draft.whenNoDecline.trim() } : {}),
    ...(draft.note.trim() ? { note: draft.note.trim() } : {}),
  };
}

/** Field errors from a refusal: the body is `{answer: {...}}`, so issues read "answer.<field>". */
function answerErrors(error) {
  const byField = {};
  for (const issue of error?.details?.issues ?? []) {
    const [head, field] = String(issue.path ?? "").split(".");
    if (head === "answer" && field && !byField[field]) byField[field] = issue.message;
  }
  return byField;
}

function ModePicker({ value, onChange, disabled }) {
  return html`<fieldset class="field form-grid--wide mode-picker" disabled=${disabled}>
    <legend class="field__label">How it is answered</legend>
    ${MODES.map(
      (mode) => html`<label key=${mode.id} class="check check--top mode-picker__option">
        <input type="radio" name="answer-mode" value=${mode.id} checked=${value === mode.id} onChange=${() => onChange(mode.id)} />
        <span><span class="mode-picker__title">${mode.title}</span><span class="small muted">${mode.text}</span></span>
      </label>`,
    )}
  </fieldset>`;
}

function LockNotice({ lock }) {
  return html`<div class="notice notice--held">
    <p class="notice__title">Locked: ${lock.labels.join(" and ")}</p>
    <p>${lock.consequence}</p>
  </div>`;
}

function AiPolicyNotice() {
  return html`<div class="notice">
    <p class="notice__title">Always asks you</p>
    <p>Employers' rules on using AI in applications and interviews differ. Read each one and answer this yourself; it cannot be given an automatic answer.</p>
  </div>`;
}

function Summary({ row }) {
  return html`<dl class="facts">
    <dt>Asked as</dt><dd>${row.label}</dd>
    <dt>Matched by</dt><dd>${row.patterns.map((pattern, index) => html`<span key=${index}><q>${pattern}</q>${index < row.patterns.length - 1 ? ", " : ""}</span>`)}</dd>
    <dt>Answer</dt><dd>${row.mode === "ask" ? html`<span class="muted">None: asks you</span>` : row.mode === "skip" ? html`<span class="muted">Left blank on purpose</span>` : row.answer}</dd>
    ${row.alternatives.length ? html`<dt>Fallbacks</dt><dd>${row.alternatives.join("; ")}</dd>` : null}
    <dt>Used</dt><dd>${MODES.find((mode) => mode.id === row.mode)?.title}</dd>
    ${row.note ? html`<dt>Note</dt><dd>${row.note}</dd>` : null}
  </dl>`;
}

function AnswerForm({ row, unlocked, onSaved, onDeleted, onDirty }) {
  const initial = draftOf(row);
  const { draft, set, setDraft, dirty, reset } = useDraft(initial);
  const guard = useUnsavedGuard(dirty, onDirty);
  const { busy, error, setError, submit } = useSubmit();
  const [deleting, remove] = useAction(toast);
  const errors = answerErrors(error);
  const aiPolicy = row?.aiPolicy === true;
  const needsAnswer = draft.mode === "suggest" || draft.mode === "auto";
  const showDecline = Boolean(row?.lock?.groups.includes("demographics") || draft.whenNoDecline);

  const save = async (event, unlock = unlocked) => {
    event?.preventDefault();
    if (needsAnswer && !draft.answer.trim()) {
      setError({ message: "Write the answer to use, or choose to be asked.", details: { issues: [{ path: "answer.answer", message: "Write the answer to use, or choose to be asked." }] } });
      return;
    }
    const body = bodyOf(draft, initial);
    const result = await submit(() =>
      row
        ? api.patch(`/api/settings/answers/${encodeURIComponent(row.key)}`, { version: row.version, answer: body, ...(unlock ? { unlock: true } : {}) })
        : api.post("/api/settings/answers", { answer: body, ...(unlock ? { unlock: true } : {}) }),
    );
    if (!result) return;
    guard.release();
    reset(draftOf(result.answer));
    onSaved(result);
  };

  const destroy = async () => {
    const query = new URLSearchParams({ version: row.version, ...(unlocked ? { unlock: "true" } : {}) });
    const result = await remove(() => api.del(`/api/settings/answers/${encodeURIComponent(row.key)}?${query}`), { success: "Answer deleted from profile.json." });
    if (!result) return;
    guard.release();
    onDeleted(result);
  };

  // A change that turns an unlocked answer into a locked one (a question about sponsorship, say) is refused with the lock: confirm it here.
  const lockError = error?.code === "answer_locked" ? error.details?.lock : null;
  return html`<form class="drawer__section stack" onSubmit=${save} noValidate>
    <${FormError} error=${lockError ? null : error} />
    ${lockError
      ? html`<${ConfirmInline}
          title=${`This is now a ${lockError.labels.join(" and ").toLowerCase()} answer`}
          confirmLabel="Unlock and save"
          cancelLabel="Keep editing"
          danger=${false}
          busy=${busy}
          onConfirm=${() => save(null, true)}
          onCancel=${() => setError(null)}
        ><p>${lockError.consequence}</p></${ConfirmInline}>`
      : null}
    ${aiPolicy ? html`<${AiPolicyNotice} />` : null}
    <div class="form-grid">
      <${TextField} id="answer-label" label="Question" required wide value=${draft.label} onInput=${set("label")} error=${errors.label} maxlength="300" placeholder="Will you now or in the future require sponsorship?" />
      <${TextField} id="answer-key" label="Key" required value=${draft.key} onInput=${set("key")} error=${errors.key} maxlength="120" hint="A short id, unique in the library." placeholder="visa-sponsorship" />
      <${ListInput}
        id="answer-patterns"
        label="Matched by"
        lines
        values=${draft.patterns}
        onChange=${set("patterns")}
        error=${errors.patterns}
        hint="Phrases looked for in the question on the form, ignoring case. One per line."
      />
      <${ModePicker} value=${aiPolicy ? "ask" : draft.mode} disabled=${aiPolicy} onChange=${(mode) => setDraft((previous) => ({ ...previous, mode }))} />
      ${needsAnswer && !aiPolicy
        ? html`<${TextArea} id="answer-answer" label="Answer" required rows=${3} value=${draft.answer} onInput=${set("answer")} error=${errors.answer} maxlength="5000" />
            <${ListInput}
              id="answer-alternatives"
              label="Fallback choices"
              lines
              values=${draft.alternatives}
              onChange=${set("alternatives")}
              error=${errors.alternatives}
              hint="For dropdowns: the first of these that the form offers is chosen. One per line."
            />`
        : null}
      ${showDecline && !aiPolicy
        ? html`<${TextField}
            id="answer-decline"
            label="Only when the form offers no way to decline"
            wide
            value=${draft.whenNoDecline}
            onInput=${set("whenNoDecline")}
            error=${errors.whenNoDecline}
            maxlength="200"
            hint="Chosen only when the question is required and has no decline option. Leave empty to stop for you instead."
          />`
        : null}
      <${TextArea} id="answer-note" label="Note to yourself" rows=${2} value=${draft.note} onInput=${set("note")} error=${errors.note} maxlength="2000" />
    </div>
    <div class="form-actions">
      <${Button} type="submit" kind="primary" busy=${busy} disabled=${!dirty && Boolean(row)}>${row ? "Save answer" : "Add answer"}</${Button}>
      ${row && !(aiPolicy && row.onlyAiPolicy)
        ? html`<${DeleteAction}
            what="this answer"
            consequence=${row.lock ? "Forms asking this question will stop for you again." : "Applications asking this question will stop for you, or use another answer that matches."}
            busy=${deleting}
            onDelete=${destroy}
          />`
        : null}
    </div>
    <p class="small muted">Saving writes profile.json and keeps the previous version beside it.</p>
  </form>`;
}

/** `answerKey` is a key in the library, or "new". */
export function AnswerEditor({ answerKey, aiPolicyCount = 0, onSaved, onDeleted, onClose }) {
  const isNew = answerKey === "new";
  const loaded = useResource(() => (isNew ? Promise.resolve(null) : api.get(`/api/settings/answers/${encodeURIComponent(answerKey)}`)), [answerKey]);
  const [unlocked, setUnlocked] = useState(false);
  const [asking, setAsking] = useState(false);
  const [dirty, setDirty] = useState(false);
  const row = loaded.data?.answer ? { ...loaded.data.answer, onlyAiPolicy: loaded.data.answer.aiPolicy && aiPolicyCount <= 1 } : null;
  const title = isNew ? "New answer" : (row?.label ?? "Answer");
  const sub = row ? html`<span class="mono">${row.key}</span>` : isNew ? "A question forms ask, and how to answer it" : null;
  const shell = (children) => html`<${EditorDrawer} wide dirty=${dirty} onDiscard=${() => setDirty(false)} title=${title} sub=${sub} onClose=${onClose}>${children}</${EditorDrawer}>`;
  if (!isNew && loaded.error) return shell(html`<div class="drawer__section"><${ErrorNotice} error=${loaded.error} onRetry=${loaded.reload} /></div>`);
  if (!isNew && !row) return shell(html`<div class="drawer__section"><${Skeleton} lines=${8} /></div>`);
  const locked = row?.lock && !unlocked;
  if (locked) {
    return shell(html`<div class="drawer__section stack">
      <${LockNotice} lock=${row.lock} />
      <${Summary} row=${row} />
      ${asking
        ? html`<${ConfirmInline}
            title=${`Unlock this ${row.lock.labels.join(" and ").toLowerCase()} answer?`}
            confirmLabel="Unlock and edit"
            cancelLabel="Keep it locked"
            danger=${false}
            onConfirm=${() => {
              setAsking(false);
              setUnlocked(true);
            }}
            onCancel=${() => setAsking(false)}
          >
            <p>${row.lock.consequence}</p>
            <p>The lock comes back when you close this answer.</p>
          </${ConfirmInline}>`
        : html`<div class="row"><${Button} onClick=${() => setAsking(true)}>Unlock to edit...</${Button}></div>`}
    </div>`);
  }
  return shell(html`
    ${row?.lock ? html`<div class="drawer__section"><${Plate} text=${`Unlocked: ${row.lock.labels.join(" and ")}`} tone="held" /></div>` : null}
    <${AnswerForm}
      key=${row ? `${row.key}:${row.version}` : "new"}
      row=${row}
      unlocked=${unlocked}
      onDirty=${setDirty}
      onSaved=${(result) => {
        toast(result.saved?.reloaded === false ? "Saved, but the dashboard could not reload its configuration." : "Saved to profile.json.", { tone: result.saved?.reloaded === false ? "bad" : "ok" });
        loaded.reload({ quiet: true });
        onSaved(result);
      }}
      onDeleted=${onDeleted}
    />
  `);
}
