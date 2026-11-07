import { api } from "../api.js";
import { CompanyNotes } from "../components/company-notes.js";
import { Empty, Plate } from "../components/ui.js";
import { inDays, label, money, when } from "../lib/format.js";
import { html } from "../lib/html.js";
import { useResource } from "../lib/hooks.js";
import { KIND_TEXT } from "./contact-editor.js";
import { SessionList } from "./interview-detail.js";
import { stageLabel } from "./interview-forms.js";
import { DraftList } from "./outreach.js";

/** Everything after applying, for one application: interviews and debriefs, offers, the people there, drafts to them, and research. */

export function ApplicationCareer({ detail }) {
  const { application, job } = detail;
  const id = encodeURIComponent(application.id);
  const sessions = useResource(() => api.get("/api/interview-sessions", { applicationId: application.id, limit: 50 }), [application.id]);
  const contacts = useResource(() => api.get("/api/contacts", { applicationId: application.id }), [application.id]);
  const drafts = useResource(() => api.get("/api/outreach", { applicationId: application.id, limit: 50 }), [application.id]);
  const interviews = detail.interviews ?? [];
  const offers = detail.offers ?? [];
  const people = contacts.data?.contacts ?? [];
  return html`<div>
    <section class="drawer__section">
      <div class="section__head">
        <h3>Interviews</h3>
        <span class="row">
          <a class="btn btn--small" href=${`/prep?app=${id}`}>Prep sheet</a>
          <a class="btn btn--small" href=${`/interviews?schedule=${id}`}>Schedule interview</a>
        </span>
      </div>
      ${interviews.length
        ? html`<ul class="plain-list">
            ${interviews.map(
              (interview) => html`<li key=${interview.id}>
                <a href=${`/interviews?interview=${encodeURIComponent(interview.id)}`}>${stageLabel(interview.stage)}</a> <${Plate} value=${interview.status} />
                <span class="cell-sub">${interview.scheduledAt ? `${when(interview.scheduledAt)} (${inDays(interview.daysUntil)})` : "Not booked yet"} · <a href=${`/prep?interview=${encodeURIComponent(interview.id)}`}>prep sheet</a></span>
              </li>`,
            )}
          </ul>`
        : html`<p class="small muted">None yet. When ${job.company} books a call, schedule it here.</p>`}
      ${sessions.data?.sessions.length ? html`<h4 class="subhead">Debriefs and prep notes</h4><${SessionList} sessions=${sessions.data.sessions} />` : null}
    </section>
    <section class="drawer__section">
      <div class="section__head">
        <h3>Offers</h3>
        <a class="btn btn--small" href=${`/offers?offer=new&app=${id}`}>Record an offer</a>
      </div>
      ${offers.length
        ? html`<ul class="plain-list">
            ${offers.map(
              (offer) => html`<li key=${offer.id}>
                <a href=${`/offers?offer=${encodeURIComponent(offer.id)}`}>Offer${offer.level ? `, ${offer.level}` : ""}: ${money(offer.base, offer.currency)} base</a> <${Plate} value=${offer.status} />
                ${offer.deadline ? html`<span class="cell-sub">Decide by ${offer.deadline.slice(0, 10)} (${inDays(offer.daysToDeadline)})</span>` : null}
              </li>`,
            )}
          </ul>`
        : html`<p class="small muted">No offer recorded.</p>`}
    </section>
    <section class="drawer__section">
      <div class="section__head">
        <h3>People at ${job.company}</h3>
        <span class="row">
          <a class="btn btn--small" href=${`/contacts?contact=new&for=${encodeURIComponent(job.company)}`}>Add a contact</a>
          <a class="btn btn--small" href=${`/contacts?compose=1&app=${id}`}>Write a draft</a>
        </span>
      </div>
      ${people.length
        ? html`<ul class="plain-list">${people.map((person) => html`<li key=${person.id}><a href=${`/contacts?contact=${encodeURIComponent(person.id)}`}>${person.name}</a>${person.role ? `, ${person.role}` : ""} <span class="small muted">(${(KIND_TEXT[person.kind] ?? label(person.kind)).replace(/ \(.*\)$/, "").toLowerCase()})</span></li>`)}</ul>`
        : contacts.data
          ? html`<p class="small muted">No one saved at ${job.company} yet.</p>`
          : null}
      ${drafts.data?.drafts.length
        ? html`<h4 class="subhead">Drafts about this application</h4><${DraftList} drafts=${drafts.data.drafts} contacts=${people} onChanged=${() => drafts.reload({ quiet: true })} />`
        : null}
    </section>
    <${CompanyNotes} company=${job.company} />
    ${!interviews.length && !offers.length && !people.length && drafts.data && !drafts.data.drafts.length
      ? html`<div class="drawer__section"><${Empty} title="Nothing after applying yet">Interviews, offers, contacts and drafts for ${job.company} gather here as they happen.</${Empty}></div>`
      : null}
  </div>`;
}
