import { api } from "../api.js";
import { FormError, TextArea, useDraft, useSubmit, useUnsavedGuard, wordCount } from "../components/form.js";
import { Button, Plate } from "../components/ui.js";
import { label } from "../lib/format.js";
import { html, useState } from "../lib/html.js";
import { useAction } from "../lib/hooks.js";
import { toast } from "../lib/store.js";

/**
 * Editing an application before it is sent: the cover letter (with the fact
 * check save_cover_letter runs, here as information), every answer, and your
 * notes. Approval is bound to the packet hash, so saving any change voids it.
 */

const ISSUE_TEXT = { number: "Figure", term: "Term", employer: "Employer", title: "Title", date: "Date" };

/** What the fact check found in the letter: each claim the resume source and profile do not hold. */
function FactCheckNotice({ check }) {
  if (!check) return null;
  if (check.ok) {
    return html`<p class="notice notice--ok small" role="status">Every figure, technology, employer, title and date in the letter is in your resume source or profile.${check.note ? ` ${check.note}` : ""}</p>`;
  }
  return html`<div class="notice notice--held" role="status">
    <p class="notice__title">${check.issues.length} claim${check.issues.length === 1 ? "" : "s"} your resume source and profile do not hold</p>
    <ul class="plain-list small">${check.issues.map((issue, index) => html`<li key=${index}><strong>${ISSUE_TEXT[issue.kind] ?? label(issue.kind)}:</strong> ${issue.detail}</li>`)}</ul>
    <p class="small">If one is true, add it to profile.json or resume.json so it can be checked; otherwise reword or drop it. Saving is still up to you.${check.note ? ` ${check.note}` : ""}</p>
  </div>`;
}

function answerValues(answers) {
  return Object.fromEntries(answers.map((answer) => [answer.questionKey, answer.answer ?? ""]));
}

export function ApplicationEdit({ detail, onSaved, onDirty }) {
  const { application, answers } = detail;
  const initial = { coverLetter: application.coverLetter ?? "", notes: application.notes ?? "", answers: answerValues(answers) };
  const { draft, set, setDraft, dirty, reset } = useDraft(initial);
  const guard = useUnsavedGuard(dirty, onDirty);
  const { busy, error, submit } = useSubmit();
  const [check, setCheck] = useState(null);
  const [checking, runCheck] = useAction(toast);
  const approved = application.status === "approved";

  if (application.status === "submitted") {
    return html`<section class="drawer__section"><p class="notice">This application was submitted; its packet no longer changes. Record what happened under Packet.</p></section>`;
  }
  if (application.status === "skipped") {
    return html`<section class="drawer__section"><p class="notice">This application is skipped, so it is not edited here. Prepare the job again to work on it.</p></section>`;
  }

  const changedAnswers = answers.filter((answer) => (draft.answers[answer.questionKey] ?? "") !== (answer.answer ?? ""));
  const letterChanged = draft.coverLetter !== initial.coverLetter;
  const notesChanged = draft.notes !== initial.notes;

  const checkLetter = async () => {
    const result = await runCheck(() => api.post(`/api/applications/${encodeURIComponent(application.id)}/cover-letter/check`, { text: draft.coverLetter }));
    if (result) setCheck(result);
  };

  const save = async (event) => {
    event.preventDefault();
    const body = {
      ...(letterChanged ? { coverLetter: draft.coverLetter } : {}),
      ...(notesChanged ? { notes: draft.notes } : {}),
      ...(changedAnswers.length ? { answers: changedAnswers.map((answer) => ({ questionKey: answer.questionKey, answer: draft.answers[answer.questionKey] })) } : {}),
    };
    const result = await submit(() => api.post(`/api/applications/${encodeURIComponent(application.id)}/content`, body));
    if (!result) return;
    guard.release();
    reset(draft);
    if (result.factCheck) setCheck(result.factCheck);
    toast(
      result.approvalVoided
        ? "Saved. The packet changed, so its approval is void: review and approve it again."
        : result.outstandingQuestions.length
          ? `Saved. ${result.outstandingQuestions.length} required question${result.outstandingQuestions.length === 1 ? "" : "s"} still need an answer.`
          : "Saved. Review the packet and approve it.",
      { tone: result.approvalVoided ? "bad" : "ok" },
    );
    onSaved();
  };

  return html`<form class="drawer__section stack app-edit" onSubmit=${save} noValidate>
    <div class=${`notice ${approved ? "notice--held" : ""}`}>
      <p class="notice__title">${approved ? "Saving voids this application's approval" : "Saving changes the packet"}</p>
      <p>Approval is bound to the exact packet. Any change you save here makes a new packet, ${approved ? "so the approval you gave no longer counts and nothing is sent until you approve again" : "which you review and approve before anything is sent"}.</p>
    </div>
    <${FormError} error=${error} />
    <section aria-labelledby="edit-letter">
      <div class="section__head">
        <h3 id="edit-letter">Cover letter</h3>
        <${Button} small busy=${checking} disabled=${!draft.coverLetter.trim()} onClick=${checkLetter}>Check facts</${Button}>
      </div>
      <${TextArea}
        id="edit-cover-letter"
        label="Letter"
        rows=${12}
        maxlength="50000"
        value=${draft.coverLetter}
        onInput=${(value) => {
          set("coverLetter")(value);
          setCheck(null);
        }}
        counter=${`${wordCount(draft.coverLetter)} words`}
        hint="Separate paragraphs with a blank line. Leave empty if the form takes no letter."
      />
      <${FactCheckNotice} check=${check} />
    </section>
    <section aria-labelledby="edit-answers">
      <h3 id="edit-answers">Answers</h3>
      ${answers.length
        ? html`<div class="stack">
            ${answers.map(
              (answer) => html`<div key=${answer.questionKey} class=${`answer-edit${answer.blocked ? " answer-edit--blocked" : ""}`}>
                <${TextArea}
                  id=${`edit-answer-${answer.questionKey}`}
                  label=${answer.label}
                  rows=${(answer.answer ?? "").length > 120 ? 4 : 2}
                  value=${draft.answers[answer.questionKey] ?? ""}
                  onInput=${(value) => setDraft((previous) => ({ ...previous, answers: { ...previous.answers, [answer.questionKey]: value } }))}
                  hint=${answer.guidance || (answer.required ? undefined : "Optional")}
                />
                <div class="row answer-edit__meta">
                  ${answer.blocked ? html`<${Plate} text="Needs your answer" tone="held" />` : null}
                  <${Plate} value=${answer.source} tone=${answer.source === "human" ? "info" : "muted"} title=${answer.citation || undefined} />
                  ${answer.category && answer.category !== "general" ? html`<span class="small muted">${label(answer.category)}</span>` : null}
                </div>
              </div>`,
            )}
          </div>`
        : html`<p class="muted small">This application has no questions recorded.</p>`}
    </section>
    <section aria-labelledby="edit-notes">
      <h3 id="edit-notes">Notes</h3>
      <${TextArea} id="edit-app-notes" label="Your notes" rows=${3} maxlength="20000" value=${draft.notes} onInput=${set("notes")} hint="For you; they are part of the packet record but not of the form." />
    </section>
    <div class="form-actions form-actions--sticky">
      <${Button} type="submit" kind="primary" busy=${busy} disabled=${!dirty}>${approved ? "Save and void approval" : "Save changes"}</${Button}>
      ${dirty ? html`<${Button} kind="ghost" onClick=${() => reset(initial)}>Undo changes</${Button}>` : html`<span class="small muted">No unsaved changes.</span>`}
    </div>
  </form>`;
}
