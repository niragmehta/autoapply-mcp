import { html, useEffect, useRef, useState } from "../lib/html.js";
import { setLeaveGuard } from "../lib/router.js";

/**
 * Form pieces for the editors: labelled fields that show an error or a
 * warning beside the field it is about, list inputs, draft state with a
 * dirty flag, and a guard that asks before unsaved changes are lost.
 */

/** Errors an API response attaches to fields: zod issues by path, and figures a check refused, by field. */
export function fieldErrors(error) {
  const details = error?.details ?? {};
  const byField = {};
  for (const issue of details.issues ?? []) {
    const key = String(issue.path ?? "").split(".")[0];
    if (key && !byField[key]) byField[key] = issue.message;
  }
  for (const [field, tokens] of Object.entries(details.byField ?? {})) {
    if (Array.isArray(tokens) && tokens.length) byField[field] = `Not in your profile: ${tokens.join(", ")}. Use figures from your facts, or add the fact first.`;
  }
  return byField;
}

function describedBy(id, { hint, error, warning }) {
  return [hint ? `${id}-hint` : null, error ? `${id}-error` : null, warning ? `${id}-warn` : null].filter(Boolean).join(" ") || undefined;
}

function Notes({ id, hint, error, warning }) {
  return html`${hint ? html`<span class="field__hint" id=${`${id}-hint`}>${hint}</span>` : null}
    ${error ? html`<span class="field__error" id=${`${id}-error`}>${error}</span>` : null}
    ${warning ? html`<span class="field__warn" id=${`${id}-warn`}>${warning}</span>` : null}`;
}

export function TextField({ id, label, value, onInput, hint, error, warning, type = "text", required, maxlength, placeholder, wide, inputmode, step, min, max }) {
  return html`<div class=${`field${wide ? " form-grid--wide" : ""}`}>
    <label class="field__label" for=${id}>${label}${required ? html` <span aria-hidden="true">*</span>` : null}</label>
    <input
      id=${id}
      class="input"
      type=${type}
      value=${value ?? ""}
      required=${required}
      maxlength=${maxlength}
      placeholder=${placeholder}
      inputmode=${inputmode}
      step=${step}
      min=${min}
      max=${max}
      aria-invalid=${error ? "true" : undefined}
      aria-describedby=${describedBy(id, { hint, error, warning })}
      onInput=${(event) => onInput(event.currentTarget.value)}
    />
    <${Notes} id=${id} hint=${hint} error=${error} warning=${warning} />
  </div>`;
}

export function TextArea({ id, label, value, onInput, hint, error, warning, rows = 3, maxlength, required, placeholder, counter }) {
  return html`<div class="field form-grid--wide">
    <div class="field__top">
      <label class="field__label" for=${id}>${label}${required ? html` <span aria-hidden="true">*</span>` : null}</label>
      ${counter ? html`<span class="field__count">${counter}</span>` : null}
    </div>
    <textarea
      id=${id}
      class="textarea"
      rows=${rows}
      maxlength=${maxlength}
      required=${required}
      placeholder=${placeholder}
      aria-invalid=${error ? "true" : undefined}
      aria-describedby=${describedBy(id, { hint, error, warning })}
      value=${value ?? ""}
      onInput=${(event) => onInput(event.currentTarget.value)}
    ></textarea>
    <${Notes} id=${id} hint=${hint} error=${error} warning=${warning} />
  </div>`;
}

/** options: [{ value, label }]; `any` adds a first, empty choice with that text. */
export function SelectField({ id, label, value, onChange, options, hint, error, any, required, wide }) {
  return html`<div class=${`field${wide ? " form-grid--wide" : ""}`}>
    <label class="field__label" for=${id}>${label}${required ? html` <span aria-hidden="true">*</span>` : null}</label>
    <select
      id=${id}
      class="select"
      value=${value ?? ""}
      required=${required}
      aria-invalid=${error ? "true" : undefined}
      aria-describedby=${describedBy(id, { hint, error })}
      onChange=${(event) => onChange(event.currentTarget.value)}
    >
      ${any !== undefined ? html`<option value="">${any}</option>` : null}
      ${options.map((option) => html`<option value=${option.value}>${option.label}</option>`)}
    </select>
    <${Notes} id=${id} hint=${hint} error=${error} />
  </div>`;
}

function splitList(text, separator) {
  return [...new Set(text.split(separator).map((part) => part.trim()).filter((part) => part.length > 0))];
}

/** A list typed as text: comma-separated, or one per line with `lines`. */
export function ListInput({ id, label, values, onChange, hint, error, warning, placeholder, lines = false, wide }) {
  const joiner = lines ? "\n" : ", ";
  const [text, setText] = useState((values ?? []).join(joiner));
  const last = useRef(values);
  useEffect(() => {
    // An outside change (a reset or a loaded record) replaces the text; typing does not.
    if (JSON.stringify(values) !== JSON.stringify(last.current)) setText((values ?? []).join(joiner));
    last.current = values;
  }, [values]);
  const update = (next) => {
    setText(next);
    const parsed = splitList(next, lines ? /\n/ : /[,\n]/);
    last.current = parsed;
    onChange(parsed);
  };
  const common = {
    id,
    "aria-invalid": error ? "true" : undefined,
    "aria-describedby": describedBy(id, { hint, error, warning }),
    placeholder,
    onInput: (event) => update(event.currentTarget.value),
  };
  return html`<div class=${`field${wide || lines ? " form-grid--wide" : ""}`}>
    <label class="field__label" for=${id}>${label}</label>
    ${lines ? html`<textarea class="textarea" rows="3" value=${text} ...${common}></textarea>` : html`<input class="input" value=${text} ...${common} />`}
    <${Notes} id=${id} hint=${hint} error=${error} warning=${warning} />
  </div>`;
}

/** Draft state for an editor: `set(key)` returns a setter; `dirty` compares with the last saved copy. */
export function useDraft(initial) {
  const [saved, setSaved] = useState(initial);
  const [draft, setDraft] = useState(initial);
  const set = (key) => (value) => setDraft((previous) => ({ ...previous, [key]: value }));
  const reset = (next = saved) => {
    setSaved(next);
    setDraft(next);
  };
  return { draft, set, setDraft, reset, dirty: JSON.stringify(draft) !== JSON.stringify(saved) };
}

/**
 * While `dirty`, closing the tab warns and the app asks before navigating
 * away. `release()` lifts the guard at once, before a save or a discard
 * closes the editor. `onDirty`, when given, hears every change of state, so
 * a drawer around the form can ask before closing too.
 */
export function useUnsavedGuard(dirty, onDirty) {
  const held = useRef(dirty);
  held.current = dirty;
  useEffect(() => {
    onDirty?.(dirty);
  }, [dirty]);
  useEffect(() => {
    if (!dirty) return undefined;
    const onUnload = (event) => {
      if (!held.current) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onUnload);
    const clear = setLeaveGuard(() => !held.current || window.confirm("You have unsaved changes. Leave and lose them?"));
    return () => {
      window.removeEventListener("beforeunload", onUnload);
      clear();
    };
  }, [dirty]);
  return {
    release: () => {
      held.current = false;
      onDirty?.(false);
    },
  };
}

/** Words in a text, for counters that say how long an answer runs. */
export function wordCount(text) {
  const trimmed = String(text ?? "").trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

/**
 * Runs a save: busy while it runs, the failure kept for the form to show (at
 * the top, and beside each field it names), the result returned on success.
 */
export function useSubmit() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const submit = async (action) => {
    setBusy(true);
    setError(null);
    try {
      return await action();
    } catch (failure) {
      setError(failure);
      return null;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, setError, submit, errors: fieldErrors(error) };
}

/** Codes whose details are shown beside the fields, so the top says what happened in plain words. */
const SUMMARY_BY_CODE = {
  unverified_figures: "A figure is not in your verified facts. The field it appears in says which, and how to fix it.",
};

function summaryOf(error) {
  return SUMMARY_BY_CODE[error.code] ?? error.message;
}

/** The failure, said once at the top of a form; fields repeat their own part beside themselves. */
export function FormError({ error, summary }) {
  if (!error) return null;
  return html`<div class="notice notice--bad" role="alert">
    <p class="notice__title">Not saved</p>
    <p>${summary ?? summaryOf(error)}</p>
  </div>`;
}
