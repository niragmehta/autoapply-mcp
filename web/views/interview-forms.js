import { api } from "../api.js";
import { FormError, SelectField, TextArea, TextField, useDraft, useSubmit, useUnsavedGuard } from "../components/form.js";
import { Button, IconButton } from "../components/ui.js";
import { label } from "../lib/format.js";
import { html } from "../lib/html.js";
import { useResource } from "../lib/hooks.js";
import { toast, useMeta } from "../lib/store.js";

/** Forms for interviews: scheduling one from an application, editing it, and saving a debrief or other session. */

const FORMATS = ["video", "phone", "onsite", "take-home"];
const STAGES = ["recruiter_screen", "technical", "system_design", "behavioral", "hiring_manager", "onsite", "other"];

/** datetime-local works in local time; the API takes an ISO instant. */
export function toLocalInput(iso) {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function fromLocalInput(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toISOString();
}

export function stageLabel(stage) {
  return stage === "hiring_manager" ? "Hiring manager" : stage === "recruiter_screen" ? "Recruiter screen" : label(stage);
}

/** Who will be in the room: a row per person, name and job title. */
function Interviewers({ value, onChange, idPrefix }) {
  const rows = value.length ? value : [];
  const update = (index, key, text) => onChange(rows.map((row, at) => (at === index ? { ...row, [key]: text } : row)));
  return html`<fieldset class="field form-grid--wide">
    <legend>Interviewers</legend>
    ${rows.length
      ? html`<ul class="people-rows">
          ${rows.map(
            (row, index) => html`<li key=${index} class="people-row">
              <label class="sr-only" for=${`${idPrefix}-name-${index}`}>Name of interviewer ${index + 1}</label>
              <input id=${`${idPrefix}-name-${index}`} class="input" placeholder="Name" maxlength="120" value=${row.name} onInput=${(event) => update(index, "name", event.currentTarget.value)} />
              <label class="sr-only" for=${`${idPrefix}-role-${index}`}>Job title of interviewer ${index + 1}</label>
              <input id=${`${idPrefix}-role-${index}`} class="input" placeholder="Job title, e.g. Engineering Manager" maxlength="160" value=${row.role} onInput=${(event) => update(index, "role", event.currentTarget.value)} />
              <${IconButton} icon="close" label=${`Remove interviewer ${index + 1}`} onClick=${() => onChange(rows.filter((_, at) => at !== index))} />
            </li>`,
          )}
        </ul>`
      : html`<p class="small muted">No one named yet. Their job titles shape what the prep sheet tells you to expect.</p>`}
    <div><${Button} small onClick=${() => onChange([...rows, { name: "", role: "" }])}>Add interviewer</${Button}></div>
  </fieldset>`;
}

function cleanPeople(rows) {
  return rows.map((row) => ({ name: row.name.trim(), role: row.role.trim() })).filter((row) => row.name.length > 0);
}

function InterviewFields({ draft, set, errors, idPrefix }) {
  const stages = useMeta().data?.career?.interviewStages ?? STAGES;
  return html`
    <${SelectField} id=${`${idPrefix}-stage`} label="Stage" required value=${draft.stage} onChange=${set("stage")} options=${stages.map((stage) => ({ value: stage, label: stageLabel(stage) }))} error=${errors.stage} />
    <${TextField} id=${`${idPrefix}-when`} label="When" type="datetime-local" value=${draft.when} onInput=${set("when")} hint="Your local time. Leave empty if not booked yet." error=${errors.scheduledAt} />
    <${TextField} id=${`${idPrefix}-duration`} label="Minutes" type="number" inputmode="numeric" min="5" max="1440" step="5" value=${draft.durationMinutes} onInput=${set("durationMinutes")} error=${errors.durationMinutes} />
    <${SelectField} id=${`${idPrefix}-format`} label="Format" value=${draft.format} onChange=${set("format")} any="Not set" options=${FORMATS.map((format) => ({ value: format, label: label(format) }))} />
    <${TextField} id=${`${idPrefix}-where`} label="Link or place" wide value=${draft.locationOrLink} onInput=${set("locationOrLink")} maxlength="500" placeholder="https://meet.example.com/... or an address" error=${errors.locationOrLink} />
    <${Interviewers} value=${draft.interviewers} onChange=${set("interviewers")} idPrefix=${idPrefix} />
    <${TextArea} id=${`${idPrefix}-notes`} label="Notes" rows=${3} value=${draft.notes} onInput=${set("notes")} maxlength="10000" error=${errors.notes} />
  `;
}

function payload(draft) {
  return {
    stage: draft.stage,
    format: draft.format,
    locationOrLink: draft.locationOrLink.trim(),
    interviewers: cleanPeople(draft.interviewers),
    notes: draft.notes,
  };
}

/** Schedules an interview; `applicationId` preselects the application it belongs to. */
export function ScheduleForm({ applicationId, onSaved, onCancel, onDirty }) {
  const applications = useResource(() => api.get("/api/applications", { pageSize: 200, sort: "created", dir: "desc" }), []);
  const { draft, set, dirty } = useDraft({
    applicationId: applicationId ?? "",
    stage: "recruiter_screen",
    when: "",
    durationMinutes: "45",
    format: "video",
    locationOrLink: "",
    interviewers: [],
    notes: "",
  });
  const guard = useUnsavedGuard(dirty, onDirty);
  const { busy, error, errors, submit } = useSubmit();
  const rows = applications.data?.rows ?? [];
  const sorted = [...rows.filter((row) => row.status === "submitted"), ...rows.filter((row) => row.status !== "submitted")];
  const save = async (event) => {
    event.preventDefault();
    const duration = Number(draft.durationMinutes);
    const result = await submit(() =>
      api.post("/api/interviews", {
        applicationId: draft.applicationId,
        ...payload(draft),
        ...(draft.when ? { scheduledAt: fromLocalInput(draft.when) } : {}),
        ...(draft.durationMinutes && Number.isFinite(duration) ? { durationMinutes: duration } : {}),
      }),
    );
    if (!result) return;
    guard.release();
    toast(
      result.outcomeRecorded ? `Scheduled. Recorded "${label(result.outcomeRecorded)}" on the application.` : "Scheduled.",
      { href: `/prep?interview=${encodeURIComponent(result.interview.id)}`, linkText: "Prep sheet" },
    );
    for (const warning of result.warnings ?? []) toast(warning, { tone: "bad" });
    onSaved(result.interview);
  };
  return html`<form class="stack" onSubmit=${save} noValidate>
    <${FormError} error=${error} />
    <div class="form-grid">
      <${SelectField}
        id="schedule-application"
        label="Application"
        required
        wide
        value=${draft.applicationId}
        onChange=${set("applicationId")}
        any=${applications.loading && !applications.data ? "Loading applications..." : "Choose an application"}
        options=${sorted.map((row) => ({ value: row.id, label: `${row.company}: ${row.title} (${label(row.status).toLowerCase()})` }))}
        error=${errors.applicationId ?? (error?.code === "application_not_found" ? error.message : undefined)}
      />
      <${InterviewFields} draft=${draft} set=${set} errors=${errors} idPrefix="schedule" />
    </div>
    <p class="small muted">Scheduling records a recruiter-screen or interview outcome on the application once, so response rates stay right.</p>
    <div class="form-actions">
      <${Button} type="submit" kind="primary" busy=${busy} disabled=${!draft.applicationId}>Schedule interview</${Button}>
      <${Button} kind="ghost" onClick=${() => {
        guard.release();
        onCancel();
      }}>Cancel</${Button}>
    </div>
  </form>`;
}

/** Reschedules or edits an interview through updateInterview. */
export function EditInterviewForm({ interview, onSaved, onCancel }) {
  const { draft, set, dirty } = useDraft({
    stage: interview.stage,
    when: toLocalInput(interview.scheduledAt),
    durationMinutes: interview.durationMinutes === null ? "" : String(interview.durationMinutes),
    format: interview.format,
    locationOrLink: interview.locationOrLink,
    interviewers: interview.interviewers,
    notes: interview.notes,
  });
  const guard = useUnsavedGuard(dirty);
  const { busy, error, errors, submit } = useSubmit();
  const save = async (event) => {
    event.preventDefault();
    const duration = Number(draft.durationMinutes);
    const result = await submit(() =>
      api.patch(`/api/interviews/${encodeURIComponent(interview.id)}`, {
        ...payload(draft),
        scheduledAt: draft.when ? fromLocalInput(draft.when) : null,
        durationMinutes: draft.durationMinutes && Number.isFinite(duration) ? duration : null,
      }),
    );
    if (!result) return;
    guard.release();
    toast(result.changed.length ? `Saved: ${result.changed.map((key) => label(key).toLowerCase()).join(", ")} changed.` : "Nothing changed.");
    onSaved(result.interview);
  };
  return html`<form class="stack" onSubmit=${save} noValidate>
    <${FormError} error=${error} />
    <div class="form-grid"><${InterviewFields} draft=${draft} set=${set} errors=${errors} idPrefix=${`edit-${interview.id}`} /></div>
    <div class="form-actions">
      <${Button} type="submit" kind="primary" busy=${busy}>Save changes</${Button}>
      <${Button} kind="ghost" onClick=${() => {
        guard.release();
        onCancel();
      }}>Cancel</${Button}>
    </div>
  </form>`;
}

const DEBRIEF_PARTS = [
  ["questions", "Questions they asked", "One per line, as close to their words as you remember."],
  ["howItWent", "How it went", "What landed, what did not, and how they reacted."],
  ["followUps", "Follow-ups you owe", "Anything you promised to send, and thank-you notes."],
  ["other", "Anything else", "Names, signals about the team, next steps they mentioned."],
];

function debriefMarkdown(parts) {
  return DEBRIEF_PARTS.filter(([key]) => parts[key].trim())
    .map(([key, heading]) => `## ${heading}\n${key === "questions" ? parts[key].trim().split("\n").filter(Boolean).map((line) => (line.startsWith("- ") ? line : `- ${line}`)).join("\n") : parts[key].trim()}`)
    .join("\n\n");
}

/** A debrief in four short parts, or a plan, practice notes or a red-flag review as Markdown. */
export function SessionForm({ applicationId, interviewId, onSaved, onCancel }) {
  const kinds = useMeta().data?.career?.sessionKinds ?? ["plan", "practice", "debrief", "redflags"];
  const { draft, set, dirty } = useDraft({ kind: "debrief", questions: "", howItWent: "", followUps: "", other: "", content: "" });
  const guard = useUnsavedGuard(dirty);
  const { busy, error, errors, submit } = useSubmit();
  const isDebrief = draft.kind === "debrief";
  const content = isDebrief ? debriefMarkdown(draft) : draft.content.trim();
  const save = async (event) => {
    event.preventDefault();
    const result = await submit(() => api.post("/api/interview-sessions", { applicationId, ...(interviewId ? { interviewId } : {}), kind: draft.kind, content }));
    if (!result) return;
    guard.release();
    toast(isDebrief ? "Debrief saved." : `${label(draft.kind)} saved.`);
    onSaved(result);
  };
  const kindLabel = (kind) => (kind === "redflags" ? "Red-flag review" : kind === "plan" ? "Prep plan" : label(kind));
  return html`<form class="stack session-form" onSubmit=${save} noValidate>
    <${FormError} error=${error} />
    <div class="form-grid">
      <${SelectField} id="session-kind" label="Kind" value=${draft.kind} onChange=${set("kind")} options=${kinds.map((kind) => ({ value: kind, label: kindLabel(kind) }))} />
      ${isDebrief
        ? DEBRIEF_PARTS.map(([key, text, hint]) => html`<${TextArea} key=${key} id=${`session-${key}`} label=${text} hint=${hint} rows=${key === "questions" ? 4 : 3} value=${draft[key]} onInput=${set(key)} />`)
        : html`<${TextArea} id="session-content" label="Notes (Markdown)" rows=${8} value=${draft.content} onInput=${set("content")} error=${errors.content} />`}
    </div>
    <div class="form-actions">
      <${Button} type="submit" kind="primary" busy=${busy} disabled=${!content}>Save ${isDebrief ? "debrief" : kindLabel(draft.kind).toLowerCase()}</${Button}>
      <${Button} kind="ghost" onClick=${() => {
        guard.release();
        onCancel();
      }}>Cancel</${Button}>
    </div>
  </form>`;
}
