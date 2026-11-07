import { api } from "../api.js";
import { Button, Empty, ErrorNotice, PageHead, Plate, Skeleton } from "../components/ui.js";
import { ago, label, num } from "../lib/format.js";
import { html, useEffect, useState } from "../lib/html.js";
import { useDebounced, useResource, useTitle } from "../lib/hooks.js";
import { setQuery } from "../lib/router.js";
import { StoryEditor } from "./story-editor.js";

/**
 * The story bank: STAR + Reflection stories built from verified facts and
 * reused in every interview. Search and filter, write and edit, start a
 * story from a theme in your facts, and see which competencies have none.
 */

function StoryRow({ story, selected }) {
  return html`<li class=${`story-row${selected ? " is-selected" : ""}`}>
    <a class="story-row__title" href=${`/stories?story=${encodeURIComponent(story.id)}`} aria-current=${selected ? "true" : undefined}>${story.title}</a>
    <p class="story-row__lead">${story.result || story.action}</p>
    <div class="row story-row__meta">
      ${story.tags.map((tag) => html`<${Plate} key=${tag} text=${label(tag)} tone="muted" />`)}
      ${story.skills.map((skill) => html`<${Plate} key=${skill} text=${skill} tone="info" />`)}
      <span class="small muted">${story.factIds.length ? `cites ${story.factIds.length} fact${story.factIds.length === 1 ? "" : "s"}` : "cites no facts"} · updated ${ago(story.updatedAt)}</span>
    </div>
  </li>`;
}

function Coverage({ scaffold, competency }) {
  const competencies = scaffold?.competencies ?? [];
  const covered = competencies.filter((entry) => entry.coveredBy.length > 0).length;
  return html`<section aria-labelledby="coverage-title">
    <div class="section__head">
      <h2 id="coverage-title">Coverage</h2>
      <p class="section__note">${competencies.length ? `${covered} of ${competencies.length} competencies` : ""}</p>
    </div>
    <ul class="rows">
      ${competencies.map(
        (entry) => html`<li key=${entry.id} class="coverage-row">
          <button type="button" class="link-button" aria-pressed=${competency === entry.id ? "true" : "false"} onClick=${() => setQuery({ competency: competency === entry.id ? undefined : entry.id })}>
            ${entry.label}
          </button>
          ${entry.coveredBy.length
            ? html`<${Plate} text=${`${entry.coveredBy.length} ${entry.coveredBy.length === 1 ? "story" : "stories"}`} tone="ok" />`
            : html`<${Plate} text="No story yet" tone="muted" />`}
        </li>`,
      )}
    </ul>
  </section>`;
}

function Themes({ scaffold }) {
  const themes = scaffold?.themes ?? [];
  const uncited = new Set(scaffold?.uncitedFacts ?? []);
  if (themes.length === 0) return null;
  return html`<section class="section" aria-labelledby="themes-title">
    <div class="section__head">
      <h2 id="themes-title">Start from your facts</h2>
      <p class="section__note">${uncited.size} fact${uncited.size === 1 ? "" : "s"} not in any story yet</p>
    </div>
    <ul class="rows">
      ${themes.slice(0, 8).map(
        (theme) => html`<li key=${theme.theme} class="theme">
          <div class="row theme__head">
            <span class="cell-main">${label(theme.theme)}</span>
            <span class="small muted">${theme.facts.length} fact${theme.facts.length === 1 ? "" : "s"}${theme.figureCount ? `, ${theme.figureCount} figure${theme.figureCount === 1 ? "" : "s"}` : ""}</span>
          </div>
          <ul class="plain-list small">${theme.facts.map((fact) => html`<li key=${fact.id}>${fact.statement}${uncited.has(fact.id) ? html` <span class="muted">(unused)</span>` : null}</li>`)}</ul>
          <div><a class="btn btn--small" href=${`/stories?story=new&theme=${encodeURIComponent(theme.theme)}`}>Start a story from these</a></div>
        </li>`,
      )}
    </ul>
  </section>`;
}

export default function Stories({ query }) {
  useTitle("Story bank");
  const [search, setSearch] = useState(query.get("q") ?? "");
  const settled = useDebounced(search.trim(), 250);
  useEffect(() => {
    if (settled !== (query.get("q") ?? "")) setQuery({ q: settled });
  }, [settled]);
  const tag = query.get("tag") ?? "";
  const competency = query.get("competency") ?? "";
  const openStory = query.get("story");
  const stories = useResource(() => api.get("/api/stories", { q: settled, tag, competency }), [settled, tag, competency]);
  const scaffold = useResource(() => api.get("/api/stories/scaffold"), []);
  const target = scaffold.data?.targetStoryCount;
  const theme = query.get("theme");
  const preset = theme
    ? (() => {
        const found = scaffold.data?.themes?.find((entry) => entry.theme === theme);
        return found ? { factIds: found.facts.map((fact) => fact.id), tags: [] } : undefined;
      })()
    : undefined;
  const reloadAll = () => {
    stories.reload({ quiet: true });
    scaffold.reload({ quiet: true });
  };
  const filtered = Boolean(settled || tag || competency);
  const data = stories.data;

  return html`<div>
    <${PageHead}
      title="Story bank"
      sub=${`STAR stories built from your verified facts, told in about two minutes and reused across interviews${target ? `. Aim for ${target.min} to ${target.max}.` : "."}`}
      actions=${html`<a class="btn btn--primary" href="/stories?story=new">New story</a>`}
    />
    <div class="filters" role="search" aria-label="Find stories">
      <div class="field">
        <label class="field__label" for="stories-q">Search</label>
        <input id="stories-q" class="input input--search" type="search" placeholder="Words in a story" data-search value=${search} onInput=${(event) => setSearch(event.currentTarget.value)} />
      </div>
      <div class="field">
        <label class="field__label" for="stories-tag">Tag</label>
        <select id="stories-tag" class="select" value=${tag} onChange=${(event) => setQuery({ tag: event.currentTarget.value })}>
          <option value="">Any</option>
          ${(data?.tags ?? []).map((entry) => html`<option value=${entry.tag}>${label(entry.tag)} (${num(entry.count)})</option>`)}
        </select>
      </div>
      <div class="field">
        <label class="field__label" for="stories-competency">Competency</label>
        <select id="stories-competency" class="select" value=${competency} onChange=${(event) => setQuery({ competency: event.currentTarget.value })}>
          <option value="">Any</option>
          ${(scaffold.data?.competencies ?? []).map((entry) => html`<option value=${entry.id}>${entry.label}</option>`)}
        </select>
      </div>
      ${filtered
        ? html`<div class="filters__end"><${Button} kind="ghost" small onClick=${() => {
            setSearch("");
            setQuery({ q: undefined, tag: undefined, competency: undefined });
          }}>Clear filters</${Button}></div>`
        : null}
    </div>
    <div class="split split--top">
      <section aria-labelledby="stories-title">
        <div class="section__head">
          <h2 id="stories-title">Stories</h2>
          <p class="section__note">${data ? (filtered ? `${num(data.count)} of ${num(data.total)}` : `${num(data.total)}${target ? ` of ${target.min} to ${target.max}` : ""}`) : ""}</p>
        </div>
        ${stories.error ? html`<${ErrorNotice} error=${stories.error} onRetry=${stories.reload} />` : null}
        ${stories.loading && !data ? html`<div class="panel panel--pad"><${Skeleton} lines=${5} /></div>` : null}
        ${data && data.count === 0
          ? html`<div class="panel">
              ${filtered
                ? html`<${Empty} title="No story matches">Try another word, tag or competency.</${Empty}>`
                : html`<${Empty} title="No stories yet" action=${html`<a class="btn btn--primary" href="/stories?story=new">Write your first story</a>`}>
                    A story bank of five to ten STAR stories answers most behavioral questions. Start from a theme in your facts, alongside.
                  </${Empty}>`}
            </div>`
          : null}
        ${data?.count ? html`<ul class="rows stories">${data.stories.map((story) => html`<${StoryRow} key=${story.id} story=${story} selected=${story.id === openStory} />`)}</ul>` : null}
      </section>
      <div>
        ${scaffold.error ? html`<${ErrorNotice} error=${scaffold.error} onRetry=${scaffold.reload} />` : null}
        ${scaffold.loading && !scaffold.data ? html`<div class="panel panel--pad"><${Skeleton} lines=${6} /></div>` : null}
        ${scaffold.data ? html`<${Coverage} scaffold=${scaffold.data} competency=${competency} /><${Themes} scaffold=${scaffold.data} />` : null}
      </div>
    </div>
    ${openStory && (scaffold.data || scaffold.error)
      ? html`<${StoryEditor}
          storyId=${openStory}
          scaffold=${scaffold.data}
          preset=${preset}
          onSaved=${(saved) => {
            reloadAll();
            if (openStory === "new") setQuery({ story: saved.id, theme: undefined });
          }}
          onDeleted=${() => {
            reloadAll();
            setQuery({ story: undefined });
          }}
          onClose=${() => setQuery({ story: undefined, theme: undefined })}
        />`
      : null}
  </div>`;
}
