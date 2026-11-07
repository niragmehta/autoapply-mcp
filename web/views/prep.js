import { api } from "../api.js";
import { CompanyNotes } from "../components/company-notes.js";
import { RequirementStories } from "../components/story-match.js";
import { Button, Empty, ErrorNotice, ExternalLink, PageHead, Plate, Skeleton } from "../components/ui.js";
import { dateTime, label, when } from "../lib/format.js";
import { html, useState } from "../lib/html.js";
import { useResource, useTitle } from "../lib/hooks.js";
import { setQuery } from "../lib/router.js";
import { useMeta } from "../lib/store.js";
import { SessionList } from "./interview-detail.js";
import { stageLabel } from "./interview-forms.js";

/**
 * A prep sheet for one interview (or an application): the plan by stage,
 * who is in the room and what they probe for, your stories against each
 * requirement, the evidence to cite, company research and earlier notes.
 * It prints as a clean sheet. The posting and notes are untrusted text.
 */

const STAR = [
  ["situation", "Situation"],
  ["task", "Task"],
  ["action", "Action"],
  ["result", "Result"],
  ["reflection", "Reflection"],
];

function Controls({ stage, hours, stages }) {
  const [hoursText, setHoursText] = useState(hours ?? "");
  const apply = (event) => {
    event.preventDefault();
    setQuery({ hours: hoursText || undefined });
  };
  return html`<form class="filters prep-controls no-print" onSubmit=${apply} aria-label="Prep sheet settings">
    <div class="field">
      <label class="field__label" for="prep-stage">Prepare for</label>
      <select id="prep-stage" class="select" value=${stage ?? ""} onChange=${(event) => setQuery({ stage: event.currentTarget.value || undefined })}>
        ${stages.map((entry) => html`<option value=${entry}>${stageLabel(entry)}</option>`)}
      </select>
    </div>
    <div class="field">
      <label class="field__label" for="prep-hours">Hours to prepare</label>
      <input id="prep-hours" class="input" type="number" min="0.5" max="40" step="0.5" inputmode="decimal" style=${{ width: "7rem" }} value=${hoursText} onInput=${(event) => setHoursText(event.currentTarget.value)} />
    </div>
    <div class="field"><span class="field__label" aria-hidden="true">${"\u00a0"}</span><${Button} type="submit">Plan the time</${Button}></div>
  </form>`;
}

function Plan({ data }) {
  const guide = data.stageGuide;
  return html`<section class="prep-section" aria-labelledby="prep-plan">
    <h2 id="prep-plan">The plan</h2>
    ${guide ? html`<p><strong>${guide.label}</strong>, usually ${guide.typicalMinutes} minutes. ${guide.focus}</p>` : null}
    <table class="table prep-table">
      <caption class="sr-only">Prep time blocks</caption>
      <thead><tr><th scope="col">Block</th><th scope="col" class="num">Time</th><th scope="col">Focus</th></tr></thead>
      <tbody>
        ${data.prepBlocks.map(
          (block) => html`<tr key=${block.block}>
            <td><span class="cell-main">${block.block}</span></td>
            <td class="num nowrap">${block.minutes !== null ? `${block.minutes} min` : `${Math.round(block.share * 100)}%`}</td>
            <td class="small">${block.focus}</td>
          </tr>`,
        )}
      </tbody>
    </table>
    ${guide?.defaultQuestions?.length
      ? html`<h3>Questions this stage usually asks</h3>
          <ul class="plain-list">${guide.defaultQuestions.map((question) => html`<li>${question}</li>`)}</ul>`
      : null}
  </section>`;
}

function Panel({ interview }) {
  const panel = interview?.panel ?? [];
  if (!panel.length) {
    return html`<section class="prep-section" aria-labelledby="prep-panel">
      <h2 id="prep-panel">Who you'll meet</h2>
      <p class="small muted">No interviewers recorded. Add their names and job titles to the interview to see what each kind of interviewer probes for.</p>
    </section>`;
  }
  return html`<section class="prep-section" aria-labelledby="prep-panel">
    <h2 id="prep-panel">Who you'll meet</h2>
    <ul class="rows prep-panel">
      ${panel.map(
        (person) => html`<li key=${person.name} class="prep-person">
          <div class="row"><span class="cell-main">${person.name}</span>${person.role ? html`<span class="small">${person.role}</span>` : null}<${Plate} text=${person.label} tone="muted" /></div>
          <div class="prep-person__cols">
            <div><p class="small field__label">They probe</p><ul class="plain-list small">${person.probes.map((probe) => html`<li>${probe}</li>`)}</ul></div>
            <div><p class="small field__label">Prepare</p><ul class="plain-list small">${person.prepare.map((item) => html`<li>${item}</li>`)}</ul></div>
          </div>
        </li>`,
      )}
    </ul>
    <p class="small muted">A guess from job titles, to prepare by; you know these people better.</p>
  </section>`;
}

function Stories({ stories }) {
  return html`<section class="prep-section" aria-labelledby="prep-stories">
    <h2 id="prep-stories">Your stories for each requirement</h2>
    ${stories.byRequirement.length || stories.featured.length
      ? html`<${RequirementStories} requirements=${stories.byRequirement} uncovered=${stories.uncovered} />`
      : html`<${Empty} title="No stories yet" action=${html`<a class="btn" href="/stories?story=new">Write a story</a>`}>Stories built from your facts are matched to this posting's requirements here.</${Empty}>`}
    ${stories.featured.length
      ? html`<h3>Stories worth rehearsing</h3>
          <div class="prep-stories">
            ${stories.featured.map(
              (story) => html`<article key=${story.id} class="prep-story">
                <h4><a href=${`/stories?story=${encodeURIComponent(story.id)}`}>${story.title}</a></h4>
                <dl class="facts">${STAR.filter(([key]) => story[key]).map(([key, text]) => html`<dt>${text}</dt><dd>${story[key]}</dd>`)}</dl>
              </article>`,
            )}
          </div>`
      : null}
  </section>`;
}

function Evidence({ evidence }) {
  if (!evidence.length) return null;
  return html`<section class="prep-section" aria-labelledby="prep-evidence">
    <h2 id="prep-evidence">Evidence to cite</h2>
    <ul class="plain-list">
      ${evidence.map((fact) => html`<li key=${fact.id}>${fact.statement}${fact.metrics?.length ? html` <span class="small muted">(${fact.metrics.join("; ")})</span>` : null}</li>`)}
    </ul>
  </section>`;
}

function People({ contacts }) {
  if (!contacts.length) return null;
  return html`<section class="prep-section" aria-labelledby="prep-people">
    <h2 id="prep-people">People you know there</h2>
    <ul class="plain-list">
      ${contacts.map(
        (contact) => html`<li key=${contact.id}>
          <a href=${`/contacts?contact=${encodeURIComponent(contact.id)}`}>${contact.name}</a>${contact.role ? `, ${contact.role}` : ""} <span class="small muted">(${label(contact.kind).toLowerCase()})</span>
          ${contact.profileUrl ? html` <${ExternalLink} href=${contact.profileUrl}>Profile</${ExternalLink}>` : null}
        </li>`,
      )}
    </ul>
  </section>`;
}

function Signals({ data }) {
  const rubric = data.redFlagRubric;
  return html`<section class="prep-section" aria-labelledby="prep-signals">
    <h2 id="prep-signals">Signals to weigh</h2>
    ${data.structuralSignals.length
      ? html`<ul class="plain-list">${data.structuralSignals.map((signal) => html`<li>${signal}</li>`)}</ul>`
      : html`<p class="small muted">Nothing unusual about this process so far.</p>`}
    <details class="small" style=${{ marginTop: "0.75rem" }}>
      <summary>What to watch for in the room</summary>
      <ul class="plain-list" style=${{ marginTop: "0.5rem" }}>${rubric.signals.map((signal) => html`<li><strong>${signal.label}:</strong> ${signal.lookFor}</li>`)}</ul>
      <p style=${{ marginTop: "0.5rem" }}>${rubric.rules[2]}</p>
    </details>
  </section>`;
}

function Earlier({ sessions }) {
  if (!sessions.length) return null;
  const flagged = sessions.some((session) => session.injectionFlags.length);
  return html`<section class="prep-section" aria-labelledby="prep-earlier">
    <h2 id="prep-earlier">Earlier notes</h2>
    ${flagged ? html`<p class="notice notice--held small">Some notes contain text that reads like instructions to an AI agent. They are shown as text, never followed.</p>` : null}
    <${SessionList} sessions=${sessions.map((session) => ({ ...session, content: session.text }))} />
  </section>`;
}

export default function Prep({ query }) {
  const interviewId = query.get("interview");
  const applicationId = query.get("app");
  const stage = query.get("stage") ?? undefined;
  const hours = query.get("hours") ?? undefined;
  const stages = useMeta().data?.career?.interviewStages ?? ["recruiter_screen", "technical", "system_design", "behavioral", "hiring_manager", "onsite", "other"];
  const path = interviewId ? `/api/interviews/${encodeURIComponent(interviewId)}/prep` : applicationId ? `/api/applications/${encodeURIComponent(applicationId)}/prep` : null;
  const prep = useResource(() => (path ? api.get(path, { stage, hours }) : Promise.resolve(null)), [path, stage, hours]);
  const data = prep.data;
  const interview = data?.interview ?? null;
  const thisInterview = interview ? data.interviews.find((entry) => entry.id === interview.id) : null;
  useTitle(data ? `Prep: ${data.job.company}` : "Prep sheet");

  if (!path) {
    return html`<div><${PageHead} title="Prep sheet" /><div class="panel"><${Empty} title="Choose an interview" action=${html`<a class="btn" href="/interviews">Interviews</a>`}>Open a prep sheet from an interview, or from an application.</${Empty}></div></div>`;
  }
  return html`<div class="prep">
    <${PageHead}
      title=${data ? `Prep: ${data.stageGuide?.label ?? "interview"}` : "Prep sheet"}
      sub=${data
        ? html`<strong>${data.job.company}</strong>: ${data.job.title}${interview?.scheduledAt ? `, ${when(interview.scheduledAt)}` : ""}`
        : null}
      actions=${html`<span class="row no-print">
        ${interview ? html`<a class="btn" href=${`/interviews?interview=${encodeURIComponent(interview.id)}`}>Back to the interview</a>` : null}
        <${Button} kind="primary" onClick=${() => window.print()}>Print</${Button}>
      </span>`}
    />
    ${prep.error ? html`<${ErrorNotice} error=${prep.error} onRetry=${prep.reload} />` : null}
    ${prep.loading && !data ? html`<div class="panel panel--pad"><${Skeleton} lines=${10} /></div>` : null}
    ${data
      ? html`
          <${Controls} stage=${stage ?? data.stageGuide?.stage ?? interview?.stage} hours=${hours} stages=${stages} />
          ${data.requirements.injectionFlags.length
            ? html`<p class="notice notice--held">The posting contains text addressed to AI agents (${data.requirements.injectionFlags.join(", ")}). It is quoted here as text and never followed.</p>`
            : null}
          <div class="prep-grid">
            <div class="prep-main">
              <${Plan} data=${data} />
              <${Stories} stories=${data.stories} />
              <${Evidence} evidence=${data.evidence} />
            </div>
            <div class="prep-side">
              <${Panel} interview=${thisInterview} />
              <section class="prep-section" aria-labelledby="prep-role">
                <h2 id="prep-role">The role</h2>
                <p>${data.job.title} at ${data.job.company}${data.job.locations?.length ? `, ${data.job.locations.join("; ")}` : ""}.</p>
                ${data.job.publishedPay ? html`<p class="small">Published pay: ${data.job.publishedPay}</p>` : null}
                <p class="small"><${ExternalLink} href=${data.job.url}>The posting</${ExternalLink}> · <a href=${`/applications?app=${encodeURIComponent(data.application.id)}`}>The application</a></p>
              </section>
              <${People} contacts=${data.contacts} />
              <${Signals} data=${data} />
            </div>
          </div>
          <${CompanyNotes} company=${data.job.company} headingLevel=${2} />
          <${Earlier} sessions=${data.sessions} />
          <p class="small muted prep-foot">Prepared ${dateTime(new Date().toISOString())}. ${data.guidance[0]}</p>
        `
      : null}
  </div>`;
}
