import { api } from "../api.js";
import { FormError, useDraft, useSubmit, useUnsavedGuard } from "../components/form.js";
import { Button, Check, ErrorNotice, Plate, Skeleton } from "../components/ui.js";
import { label, money, num } from "../lib/format.js";
import { html, useState } from "../lib/html.js";
import { useResource } from "../lib/hooks.js";
import { toast, useMeta } from "../lib/store.js";
import { SavedNotice } from "./settings-answers.js";

/**
 * Read-only summaries of campaign.json and profile.json. Of the campaign,
 * only the three documents settings can change here; everything else is
 * edited in the file, which the dashboard reads again on the next request.
 */

const pct = (value) => `${Math.round(value * 100)}%`;
const list = (values, empty = "None") => (values?.length ? values.join(", ") : html`<span class="muted">${empty}</span>`);

function Block({ id, title, children, note }) {
  return html`<section class="panel panel--pad stack settings-block" aria-labelledby=${id}>
    <h3 id=${id}>${title}</h3>
    ${children}
    ${note ? html`<p class="small muted">${note}</p>` : null}
  </section>`;
}

function DocumentsForm({ documents, onSaved }) {
  const initial = { tailorResume: documents.tailorResume, maxSwaps: String(documents.maxSwaps), maxAddedSkills: String(documents.maxAddedSkills) };
  const { draft, set, dirty, reset } = useDraft(initial);
  const guard = useUnsavedGuard(dirty);
  const { busy, error, submit } = useSubmit();
  const save = async (event) => {
    event.preventDefault();
    const body = {};
    if (draft.tailorResume !== initial.tailorResume) body.tailorResume = draft.tailorResume;
    if (draft.maxSwaps !== initial.maxSwaps) body.maxSwaps = Number(draft.maxSwaps);
    if (draft.maxAddedSkills !== initial.maxAddedSkills) body.maxAddedSkills = Number(draft.maxAddedSkills);
    const result = await submit(() => api.patch("/api/settings/documents", body));
    if (!result) return;
    guard.release();
    reset({ tailorResume: result.documents.tailorResume, maxSwaps: String(result.documents.maxSwaps), maxAddedSkills: String(result.documents.maxAddedSkills) });
    toast("Saved to campaign.json.");
    onSaved(result);
  };
  const limit = (id, text, key, hint) => html`<div class="field">
    <label class="field__label" for=${id}>${text}</label>
    <input id=${id} class="input input--short" type="number" min="0" max="10" step="1" inputmode="numeric" value=${draft[key]} aria-describedby=${`${id}-hint`} onInput=${(event) => set(key)(event.currentTarget.value)} />
    <span class="field__hint" id=${`${id}-hint`}>${hint}</span>
  </div>`;
  return html`<form class="stack" onSubmit=${save} noValidate>
    <${FormError} error=${error} />
    <${Check} checked=${draft.tailorResume} onChange=${set("tailorResume")}>
      <strong>Tailor every resume to its posting</strong>${" "}
      <span class="muted">when an application is prepared. Off: each track's fixed variant is uploaded, and you tailor one application at a time from its Resume tab.</span>
    </${Check}>
    <div class="settings-limits">
      ${limit("documents-maxSwaps", "Reserve bullets swapped in, at most", "maxSwaps", "0 to 10. Upgrades of the same work do not count.")}
      ${limit("documents-maxAddedSkills", "Reserve skills added, at most", "maxAddedSkills", "0 to 10, only skills the posting names.")}
    </div>
    <div class="form-actions">
      <${Button} type="submit" kind="primary" busy=${busy} disabled=${!dirty}>Save documents settings</${Button}>
      ${dirty ? html`<${Button} kind="ghost" onClick=${() => reset(initial)}>Undo changes</${Button}>` : null}
    </div>
  </form>`;
}

export function CampaignSettings() {
  const campaign = useResource(() => api.get("/api/settings/campaign"), []);
  const meta = useMeta();
  const [saved, setSaved] = useState(null);
  if (campaign.error) return html`<${ErrorNotice} error=${campaign.error} onRetry=${campaign.reload} />`;
  if (!campaign.data) return html`<div class="panel panel--pad"><${Skeleton} lines=${8} /></div>`;
  const data = campaign.data;
  const currency = data.compensation.currency;
  return html`<div class="stack">
    <${SavedNotice} saved=${saved} onDismiss=${() => setSaved(null)} />
    <p class="small muted">From <span class="mono">${data.file}</span>. Only the documents settings change here; edit the rest in the file and the dashboard reads it again on the next request.</p>
    <div class="settings-grid">
      <${Block} id="set-documents" title="Documents">
        <${DocumentsForm}
          key=${JSON.stringify(data.documents)}
          documents=${data.documents}
          onSaved=${(result) => {
            setSaved(result.saved);
            campaign.reload({ quiet: true });
            meta.reload?.({ quiet: true });
          }}
        />
      </${Block}>
      <${Block} id="set-limits" title="Limits">
        <dl class="facts">
          <dt>Submission</dt><dd>${label(data.submission.mode)} mode</dd>
          <dt>Per day</dt><dd>${data.submission.dailyLimit === null ? "No daily limit" : `${num(data.submission.dailyLimit)} submissions`}</dd>
          <dt>Per batch</dt><dd>${num(data.submission.maxBatchSize)} applications</dd>
          <dt>Per company</dt><dd>${num(data.submission.maxPerCompany)} applications</dd>
          <dt>This round</dt><dd>${data.runner.roundCap ? `${num(data.runner.roundCap.max)} per company since ${data.runner.roundCap.since.slice(0, 10)}` : "No round cap"}</dd>
          <dt>Pacing</dt><dd>${num(data.submission.minDelaySeconds)} s between submissions, plus ${num(data.runner.paceSeconds)} s in runs</dd>
          <dt>Allowed companies</dt><dd>${data.submission.allowedCompanies.length ? `${num(data.submission.allowedCompanies.length)} listed` : html`<span class="muted">None listed</span>`}${data.runner.autoAllowlist ? "; runs add companies as they submit" : ""}</dd>
          <dt>Always asks you</dt><dd>${list(data.submission.blockedQuestionCategories.map(label))}</dd>
        </dl>
      </${Block}>
      <${Block} id="set-tiers" title="Tiers and scoring">
        <p><${Plate} text="A" tone="ok" /> from ${data.tiers.A}${" "}<${Plate} text="B" tone="info" /> from ${data.tiers.B}${" "}<${Plate} text="C" tone="muted" /> from ${data.tiers.C}</p>
        <dl class="facts">
          ${Object.entries(data.weights).map(([key, value]) => html`<dt key=${key}>${label(key)}</dt><dd>${num(value)} points</dd>`)}
          <dt>Fresh for</dt><dd>${num(data.freshnessDays)} days</dd>
        </dl>
      </${Block}>
      <${Block} id="set-where" title="Where and pay">
        <dl class="facts">
          <dt>Locations</dt><dd>${list(data.locations.map(label))}</dd>
          <dt>Workplaces</dt><dd>${list(data.workplaceTypes.map(label))}</dd>
          <dt>Seniority</dt><dd>${list(data.seniority.allow.map(label))}</dd>
          ${Object.entries(data.compensation.floors).map(([country, floor]) => html`<dt key=${country}>Floor, ${country}</dt><dd>${money(floor, currency)}</dd>`)}
          <dt>No pay listed</dt><dd>${data.compensation.allowUnknown ? "Kept" : "Rejected"}</dd>
        </dl>
      </${Block}>
    </div>
    <section class="panel" aria-labelledby="set-tracks">
      <div class="panel__head"><h3 id="set-tracks">Tracks</h3><span class="small muted">${data.name}, aiming for ${num(data.targetApplications)} applications</span></div>
      <div class="table-wrap">
        <table class="table">
          <caption class="sr-only">Tracks</caption>
          <thead><tr><th scope="col">Track</th><th scope="col" class="num">Share</th><th scope="col">Resume</th><th scope="col">Titles include</th><th scope="col">Keywords</th></tr></thead>
          <tbody>
            ${data.tracks.map(
              (track) => html`<tr key=${track.id}>
                <td><span class="cell-main">${track.label}</span><span class="cell-sub mono">${track.id}</span></td>
                <td class="num">${pct(track.allocation)}</td>
                <td class="mono small">${track.resumeId}</td>
                <td class="small">${list(track.titleIncludes, "Any title")}</td>
                <td class="small">${track.keywords.length ? `${track.keywords.slice(0, 8).join(", ")}${track.keywords.length > 8 ? ` and ${track.keywords.length - 8} more` : ""}` : html`<span class="muted">None</span>`}</td>
              </tr>`,
            )}
          </tbody>
        </table>
      </div>
    </section>
  </div>`;
}

export function ProfileSettings() {
  const profile = useResource(() => api.get("/api/settings/profile"), []);
  if (profile.error) return html`<${ErrorNotice} error=${profile.error} onRetry=${profile.reload} />`;
  if (!profile.data) return html`<div class="panel panel--pad"><${Skeleton} lines=${8} /></div>`;
  const data = profile.data;
  const { identity, workAuthorization: auth, compensation, counts } = data;
  const place = [identity.location.city, identity.location.region, identity.location.country].filter(Boolean).join(", ");
  return html`<div class="stack">
    <p class="small muted">From <span class="mono">${data.file}</span>. Edit it by hand or through the MCP tools; answers are edited on the Answers tab.</p>
    <div class="settings-grid">
      <${Block} id="set-identity" title=${identity.fullName}>
        <dl class="facts">
          <dt>Headline</dt><dd>${identity.headline || html`<span class="muted">None</span>`}</dd>
          <dt>Based in</dt><dd>${place || html`<span class="muted">Not set</span>`}</dd>
          <dt>Links</dt><dd>${list(identity.links.map(label))}</dd>
          <dt>Notice period</dt><dd>${data.preferences.noticePeriod || html`<span class="muted">Not set</span>`}</dd>
          <dt>Relocation</dt><dd>${data.preferences.willingToRelocate ? `Willing${data.preferences.relocationTargets.length ? `: ${data.preferences.relocationTargets.join(", ")}` : ""}` : "Not willing"}</dd>
        </dl>
      </${Block}>
      <${Block} id="set-auth" title="Work authorization" note=${auth.alwaysReviewManually ? "Authorization questions always stop for you." : "Authorization answers may fill in where you allowed it."}>
        <dl class="facts">
          <dt>Citizenship</dt><dd>${list(auth.citizenships)}</dd>
          <dt>Authorized in</dt><dd>${list(auth.authorizedIn)}</dd>
          <dt>No sponsorship needed</dt><dd>${list(auth.noSponsorshipRequiredIn)}</dd>
          <dt>Needs sponsorship</dt><dd>${list(auth.requiresSponsorshipIn)}</dd>
        </dl>
      </${Block}>
      <${Block} id="set-pay" title="Pay">
        <dl class="facts">
          <dt>Target</dt><dd>${money(compensation.targetTotal, compensation.currency)} a year</dd>
          <dt>Minimum</dt><dd>${money(compensation.minimumTotal, compensation.currency)} a year</dd>
          <dt>When asked</dt><dd>${{ decline: "Decline to state", range: "Give a range", exact: "Give a number" }[compensation.disclosurePolicy] ?? label(compensation.disclosurePolicy)}</dd>
        </dl>
      </${Block}>
      <${Block} id="set-library" title="What the profile holds">
        <dl class="facts">
          <dt>Facts</dt><dd>${num(counts.facts)} <a class="small" href="/stories">build stories from them</a></dd>
          <dt>Skills</dt><dd>${num(counts.skills)}</dd>
          <dt>Roles</dt><dd>${num(counts.experience)}</dd>
          <dt>Education</dt><dd>${num(counts.education)}</dd>
          <dt>Answers</dt><dd>${num(counts.answers)} <a class="small" href="/settings">open the library</a></dd>
          <dt>Templates</dt><dd>${num(counts.narratives)}</dd>
        </dl>
      </${Block}>
    </div>
    <section class="panel" aria-labelledby="set-resumes">
      <div class="panel__head"><h3 id="set-resumes">Resumes</h3></div>
      <div class="table-wrap">
        <table class="table">
          <caption class="sr-only">Resume variants</caption>
          <thead><tr><th scope="col">Variant</th><th scope="col">Tracks</th><th scope="col">File</th></tr></thead>
          <tbody>
            ${data.resumes.map(
              (resume) => html`<tr key=${resume.id}>
                <td><span class="cell-main">${resume.label}${resume.isDefault ? html` <${Plate} text="Default" tone="muted" />` : null}</span><span class="cell-sub mono">${resume.id}</span></td>
                <td class="small">${list(resume.tracks)}</td>
                <td class="small"><span class="mono">${resume.file}</span>${resume.exists ? null : html` <${Plate} text="Missing" tone="bad" />`}</td>
              </tr>`,
            )}
          </tbody>
        </table>
      </div>
    </section>
    ${data.experience.length
      ? html`<section class="panel panel--pad" aria-labelledby="set-roles">
          <h3 id="set-roles">Roles</h3>
          <ul class="plain-list">
            ${data.experience.map((role, index) => html`<li key=${index}><strong>${role.title}</strong>, ${role.company} <span class="small muted">${role.start} to ${role.end}</span></li>`)}
          </ul>
        </section>`
      : null}
  </div>`;
}
