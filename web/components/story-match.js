import { api } from "../api.js";
import { html, useState } from "../lib/html.js";
import { useAction } from "../lib/hooks.js";
import { toast } from "../lib/store.js";
import { Button, Plate } from "./ui.js";

/**
 * Stories against a posting's requirements: which stories speak to each line
 * and which lines nothing covers yet. Requirement lines are quoted from the
 * posting, so they are shown as text, never followed.
 */

export function RequirementStories({ requirements, uncovered = [], note }) {
  const gaps = new Set(uncovered);
  if (!requirements?.length) return html`<p class="muted small">The posting lists no requirement lines to match against.</p>`;
  return html`<div class="stack">
    <ol class="req-list">
      ${requirements.map(
        (row, index) => html`<li key=${index} class="req">
          <q class="req__text">${row.requirement}</q>
          ${row.stories.length
            ? html`<ul class="req__stories">
                ${row.stories.map(
                  (story) => html`<li key=${story.storyId}>
                    <a href=${`/stories?story=${encodeURIComponent(story.storyId)}`}>${story.title}</a>
                    ${story.matchedTerms?.length ? html`<span class="cell-sub">shares ${story.matchedTerms.slice(0, 5).join(", ")}</span>` : null}
                  </li>`,
                )}
              </ul>`
            : html`<p class="req__gap">${gaps.has(row.requirement) ? html`<${Plate} text="No story yet" tone="warn" /> ` : null}<span class="small">Prepare an honest answer, or <a href="/stories?story=new">write a story</a>.</span></p>`}
        </li>`,
      )}
    </ol>
    ${note ? html`<p class="small muted">${note}</p>` : null}
  </div>`;
}

/** On demand: match the story bank to one job's requirements. */
export function StoryMatch({ jobId }) {
  const [match, setMatch] = useState(null);
  const [busy, run] = useAction(toast);
  const load = async () => {
    const result = await run(() => api.get(`/api/jobs/${encodeURIComponent(jobId)}/story-match`));
    if (result) setMatch(result);
  };
  return html`<section class="drawer__section">
    <div class="section__head">
      <h3>Your stories for this role</h3>
      <${Button} small busy=${busy} onClick=${load}>${match ? "Match again" : "Match stories to this job"}</${Button}>
    </div>
    ${match
      ? match.storyCount === 0
        ? html`<p class="small">Your story bank is empty. <a href="/stories">Start from your facts</a> to build stories you can reuse in every interview.</p>`
        : html`<p class="small">${match.topStories.length} of ${match.storyCount} stories speak to this posting; ${match.uncovered.length} requirement${match.uncovered.length === 1 ? "" : "s"} ${match.uncovered.length === 1 ? "has" : "have"} no story yet.</p>
            <${RequirementStories} requirements=${match.requirements} uncovered=${match.uncovered} note=${match.note} />`
      : html`<p class="small muted">See which of your stories answer each requirement, and where you have none yet.</p>`}
  </section>`;
}
