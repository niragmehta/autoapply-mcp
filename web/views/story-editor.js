import { api } from "../api.js";
import { DeleteAction, EditorDrawer } from "../components/confirm.js";
import { FormError, ListInput, TextArea, TextField, useDraft, useSubmit, useUnsavedGuard, wordCount } from "../components/form.js";
import { Button, ErrorNotice, Skeleton } from "../components/ui.js";
import { ago } from "../lib/format.js";
import { html, useEffect, useState } from "../lib/html.js";
import { useAction, useResource } from "../lib/hooks.js";
import { toast } from "../lib/store.js";

/**
 * One story, written in the STAR + Reflection shape from facts the profile
 * already holds. saveStory refuses a figure the profile does not have and
 * points softer problems at the field they are about.
 */

const SPOKEN_WORDS = 320;

const STAR_FIELDS = [
  ["situation", "Situation", 3],
  ["task", "Task", 2],
  ["action", "Action", 5],
  ["result", "Result", 3],
  ["reflection", "Reflection", 3],
];

const EMPTY = { title: "", situation: "", task: "", action: "", result: "", reflection: "", skills: [], factIds: [], tags: [] };

function storyBody(story) {
  return Object.fromEntries(Object.keys(EMPTY).map((key) => [key, story?.[key] ?? EMPTY[key]]));
}

function FactPicker({ facts, value, onChange, error, warning }) {
  const chosen = new Set(value);
  const flip = (id, on) => onChange(on ? [...value, id] : value.filter((entry) => entry !== id));
  return html`<fieldset class="field form-grid--wide fact-picker" aria-describedby=${[error ? "story-facts-error" : null, warning ? "story-facts-warn" : null].filter(Boolean).join(" ") || undefined}>
    <legend>Built from these facts</legend>
    ${facts.length
      ? html`<ul class="fact-picker__list">
          ${facts.map(
            (fact) => html`<li key=${fact.id}>
              <label class="check check--top">
                <input type="checkbox" checked=${chosen.has(fact.id)} onChange=${(event) => flip(fact.id, event.currentTarget.checked)} />
                <span><span class="mono small">${fact.id}</span> ${fact.statement}</span>
              </label>
            </li>`,
          )}
        </ul>`
      : html`<p class="small muted">Your profile has no facts yet. Add verified facts to profile.json, then build stories from them.</p>`}
    ${error ? html`<span class="field__error" id="story-facts-error">${error}</span>` : null}
    ${warning ? html`<span class="field__warn" id="story-facts-warn">${warning}</span>` : null}
  </fieldset>`;
}

function warningsByField(warnings) {
  const byField = {};
  for (const warning of warnings ?? []) {
    const key = warning.field ?? "story";
    byField[key] = byField[key] ? `${byField[key]} ${warning.message}` : warning.message;
  }
  return byField;
}

function Editor({ story, scaffold, preset, warnings, setWarnings, onSaved, onDeleted, onClose }) {
  const initial = story ? storyBody(story) : { ...EMPTY, ...preset };
  const { draft, set, dirty, reset } = useDraft(initial);
  const guard = useUnsavedGuard(dirty);
  const { busy, error, errors, submit } = useSubmit();
  const [deleting, remove] = useAction(toast);
  const facts = (scaffold?.themes ?? []).flatMap((theme) => theme.facts);
  const format = scaffold?.format ?? {};
  const byField = warningsByField(warnings);
  const words = wordCount([draft.situation, draft.task, draft.action, draft.result].join(" "));

  const save = async (event) => {
    event.preventDefault();
    const result = await submit(() =>
      story ? api.patch(`/api/stories/${encodeURIComponent(story.id)}`, draft) : api.post("/api/stories", draft),
    );
    if (!result) return;
    guard.release();
    reset(storyBody(result.story));
    setWarnings(result.story.id, result.fieldWarnings ?? []);
    toast(result.fieldWarnings?.length ? `Saved. ${result.fieldWarnings.length} thing${result.fieldWarnings.length === 1 ? "" : "s"} to look at, shown beside each field.` : "Story saved.");
    onSaved(result.story);
  };

  const destroy = async () => {
    const result = await remove(() => api.del(`/api/stories/${encodeURIComponent(story.id)}`), { success: "Story deleted." });
    if (!result) return;
    guard.release();
    onDeleted();
  };

  return html`<${EditorDrawer}
    wide
    dirty=${dirty}
    onDiscard=${() => guard.release()}
    title=${story ? story.title : "New story"}
    sub=${story ? `Updated ${ago(story.updatedAt)}` : "Situation, task, action, result and what you learned"}
    onClose=${onClose}
  >
    <form class="drawer__section stack" onSubmit=${save} noValidate>
      <${FormError} error=${error} />
      ${byField.story ? html`<p class="notice notice--held">${byField.story}</p>` : null}
      <div class="form-grid">
        <${TextField} id="story-title" label="Title" required wide value=${draft.title} onInput=${set("title")} error=${errors.title} maxlength="160" placeholder="Containing a credential leak" />
        <${FactPicker} facts=${facts} value=${draft.factIds} onChange=${set("factIds")} error=${errors.factIds} warning=${byField.factIds} />
        ${STAR_FIELDS.map(
          ([key, text, rows]) => html`<${TextArea}
            key=${key}
            id=${`story-${key}`}
            label=${text}
            required=${key === "action"}
            rows=${rows}
            value=${draft[key]}
            onInput=${set(key)}
            hint=${format[key]}
            error=${errors[key]}
            warning=${byField[key]}
            counter=${`${wordCount(draft[key])} words`}
          />`,
        )}
        <${ListInput} id="story-skills" label="Skills" values=${draft.skills} onChange=${set("skills")} hint="Comma-separated, as named in your profile's skills." error=${errors.skills} warning=${byField.skills} />
        <${ListInput}
          id="story-tags"
          label="Tags"
          values=${draft.tags}
          onChange=${set("tags")}
          hint=${`Comma-separated. Competency tags count toward coverage: ${(scaffold?.competencies ?? []).map((entry) => entry.id).join(", ")}.`}
          error=${errors.tags}
        />
      </div>
      <p class=${`small${words > SPOKEN_WORDS ? " text-warn" : " muted"}`}>
        About ${words} words across situation, task, action and result${words > SPOKEN_WORDS ? ": longer than a two-minute answer." : "; aim to stay under " + SPOKEN_WORDS + "."}
      </p>
      <div class="form-actions">
        <${Button} type="submit" kind="primary" busy=${busy}>${story ? "Save story" : "Add story"}</${Button}>
        ${story ? html`<${DeleteAction} what="this story" consequence="The story leaves your bank and its matches; the facts it cites stay in your profile." busy=${deleting} onDelete=${destroy} />` : null}
      </div>
    </form>
  </${EditorDrawer}>`;
}

/** `storyId` is a story's id, or "new" (optionally with `preset` fields from a theme). */
export function StoryEditor({ storyId, scaffold, preset, onSaved, onDeleted, onClose }) {
  const isNew = storyId === "new";
  const loaded = useResource(() => (isNew ? Promise.resolve(null) : api.get(`/api/stories/${encodeURIComponent(storyId)}`)), [storyId]);
  const [current, setCurrent] = useState(null);
  // Kept here, by story id, so they survive the editor re-opening under the new story's id after its first save.
  const [warnings, setWarningsFor] = useState({ id: null, list: [] });
  useEffect(() => {
    if (loaded.data?.story) setCurrent(loaded.data.story);
  }, [loaded.data]);
  if (!isNew && loaded.error) {
    return html`<${EditorDrawer} title="Story" onClose=${onClose}><div class="drawer__section"><${ErrorNotice} error=${loaded.error} onRetry=${loaded.reload} /></div></${EditorDrawer}>`;
  }
  if (!isNew && current?.id !== storyId) {
    return html`<${EditorDrawer} title="Story" onClose=${onClose}><div class="drawer__section"><${Skeleton} lines=${8} /></div></${EditorDrawer}>`;
  }
  return html`<${Editor}
    key=${isNew ? "new" : current.id}
    story=${isNew ? null : current}
    scaffold=${scaffold}
    preset=${preset}
    warnings=${warnings.id !== null && warnings.id === (isNew ? null : current.id) ? warnings.list : []}
    setWarnings=${(id, list) => setWarningsFor({ id, list })}
    onSaved=${(saved) => {
      setCurrent(saved);
      onSaved(saved);
    }}
    onDeleted=${onDeleted}
    onClose=${onClose}
  />`;
}
