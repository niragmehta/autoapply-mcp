import { api } from "../api.js";
import { Button, Check, Empty, ErrorNotice, Plate, Skeleton, Toggles } from "../components/ui.js";
import { label, num, plural } from "../lib/format.js";
import { html, useState } from "../lib/html.js";
import { useAction, useResource } from "../lib/hooks.js";
import { setQuery } from "../lib/router.js";
import { toast, useMeta } from "../lib/store.js";

/** The three start forms. Each posts { type, params } to /api/runs; the server validates the params. */

function useStart(onStarted) {
  const [busy, run] = useAction(toast);
  const start = async (type, params) => {
    const result = await run(() => api.post("/api/runs", { type, params }), { success: `${label(type)} run started.` });
    if (result) {
      onStarted();
      setQuery({ run: result.runId }, { replace: false });
    }
  };
  return [busy, start];
}

function splitNames(text) {
  return text
    .split(/[\n,]+/)
    .map((name) => name.trim())
    .filter(Boolean);
}

export function DiscoveryForm({ onStarted }) {
  const meta = useMeta().data;
  const [companies, setCompanies] = useState("");
  const [chunkSize, setChunkSize] = useState("10");
  const [busy, start] = useStart(onStarted);
  const names = splitNames(companies);
  const submit = (event) => {
    event.preventDefault();
    void start("discovery", { ...(names.length ? { companies: names } : {}), chunkSize: Number(chunkSize) || 10 });
  };
  return html`<form class="run-form" onSubmit=${submit}>
    <p class="run-form__intro">Fetches postings, gates and scores them, and stores each board as soon as it arrives. Nothing is sent to employers.</p>
    <div class="form-grid">
      <div class="field form-grid--wide">
        <label class="field__label" for="discovery-companies">Companies</label>
        <textarea id="discovery-companies" class="textarea" rows="2" placeholder="Leave empty for every active board" value=${companies} onInput=${(event) => setCompanies(event.currentTarget.value)}></textarea>
        <span class="field__hint">${names.length ? `${plural(names.length, "company", "companies")} named.` : `Every active board${meta ? ` (${num(meta.companies.length)} configured)` : ""}.`} Separate names with commas or new lines.</span>
      </div>
      <div class="field">
        <label class="field__label" for="discovery-chunk">Boards per chunk</label>
        <input id="discovery-chunk" class="input" type="number" min="1" max="200" value=${chunkSize} onInput=${(event) => setChunkSize(event.currentTarget.value)} />
        <span class="field__hint">Cancel and config edits apply between chunks.</span>
      </div>
    </div>
    <div class="form-actions"><${Button} type="submit" kind="primary" busy=${busy}>Start discovery</${Button}></div>
  </form>`;
}

export function PrepareForm({ onStarted }) {
  const meta = useMeta().data;
  const [tiers, setTiers] = useState(["A", "B"]);
  const [tracks, setTracks] = useState([]);
  const [locations, setLocations] = useState([]);
  const [minScore, setMinScore] = useState("");
  const [minCompensation, setMinCompensation] = useState("");
  const [limit, setLimit] = useState("");
  const [force, setForce] = useState(false);
  const [busy, start] = useStart(onStarted);
  const ceiling = meta?.submission?.maxBatchSize;
  const submit = (event) => {
    event.preventDefault();
    const filter = {
      ...(tiers.length ? { tiers } : {}),
      ...(tracks.length ? { tracks } : {}),
      ...(locations.length ? { locationClasses: locations } : {}),
      ...(minScore !== "" ? { minScore: Number(minScore) } : {}),
      ...(minCompensation !== "" ? { minCompensation: Number(minCompensation) } : {}),
      ...(limit !== "" ? { limit: Number(limit) } : {}),
    };
    void start("prepare", { filter, ...(force ? { force: true } : {}) });
  };
  return html`<form class="run-form" onSubmit=${submit}>
    <p class="run-form__intro">Drafts applications for the best queued jobs, as prepare_batch does. Nothing is approved or sent.</p>
    <div class="form-grid">
      <${Toggles} legend="Tiers" value=${tiers} onChange=${setTiers} options=${["A", "B", "C"].map((value) => ({ value, label: value }))} />
      ${meta?.tracks?.length
        ? html`<${Toggles} legend="Tracks" value=${tracks} onChange=${setTracks} options=${meta.tracks.map((track) => ({ value: track.id, label: track.label }))} />`
        : null}
      <div class="field">
        <label class="field__label" for="prepare-location">Location</label>
        <select id="prepare-location" class="select" value=${locations[0] ?? ""} onChange=${(event) => setLocations(event.currentTarget.value ? [event.currentTarget.value] : [])}>
          <option value="">Any</option>
          ${(meta?.locationClasses ?? []).map((value) => html`<option value=${value}>${label(value)}</option>`)}
        </select>
      </div>
      <div class="field">
        <label class="field__label" for="prepare-score">Min score</label>
        <input id="prepare-score" class="input" type="number" min="0" max="100" value=${minScore} onInput=${(event) => setMinScore(event.currentTarget.value)} />
      </div>
      <div class="field">
        <label class="field__label" for="prepare-pay">Min pay (annual, campaign currency)</label>
        <input id="prepare-pay" class="input" type="number" min="0" step="1000" value=${minCompensation} onInput=${(event) => setMinCompensation(event.currentTarget.value)} />
      </div>
      <div class="field">
        <label class="field__label" for="prepare-limit">How many</label>
        <input id="prepare-limit" class="input" type="number" min="1" max="500" placeholder=${ceiling ? String(ceiling) : ""} value=${limit} onInput=${(event) => setLimit(event.currentTarget.value)} />
        <span class="field__hint">${ceiling ? `At most ${ceiling} (submission.maxBatchSize).` : ""}</span>
      </div>
    </div>
    <div class="form-actions">
      <${Button} type="submit" kind="primary" busy=${busy}>Start preparing</${Button}>
      <${Check} checked=${force} onChange=${setForce}>Include jobs that were not accepted</${Check}>
    </div>
  </form>`;
}

export function SubmitForm({ onStarted }) {
  const meta = useMeta().data;
  const candidates = useResource(() => api.get("/api/applications", { status: "approved,awaiting_approval", pageSize: 200, sort: "score" }), []);
  const [selected, setSelected] = useState(null);
  const [mode, setMode] = useState("auto");
  const [headed, setHeaded] = useState(false);
  const [pace, setPace] = useState("");
  const [confirmed, setConfirmed] = useState(false);
  const [busy, start] = useStart(onStarted);
  const rows = (candidates.data?.rows ?? []).filter((row) => row.unresolved === 0);
  const chosen = selected ?? new Set(rows.filter((row) => row.status === "approved").map((row) => row.id));
  const campaignMode = meta?.submission?.mode ?? "manual";
  const modes = ["auto", "assisted"].filter((option) => (option === "auto" ? campaignMode === "auto" : campaignMode !== "manual"));
  const effectiveMode = modes.includes(mode) ? mode : modes[0];

  const toggle = (id, on) => {
    const next = new Set(chosen);
    if (on) next.add(id);
    else next.delete(id);
    setSelected(next);
    setConfirmed(false);
  };
  const submit = (event) => {
    event.preventDefault();
    const picked = rows.filter((row) => chosen.has(row.id));
    void start("submit", {
      applicationIds: picked.map((row) => row.id),
      mode: effectiveMode,
      ...(headed ? { headed: true } : {}),
      ...(pace !== "" ? { paceSeconds: Number(pace) } : {}),
      packetHashes: Object.fromEntries(picked.map((row) => [row.id, row.packetHash])),
    });
  };

  if (modes.length === 0) {
    return html`<${Empty} title="Browser submission is off">
      The campaign's submission mode is manual. Send packets by hand from each application, or set <code>submission.mode</code> to assisted or auto.
    </${Empty}>`;
  }
  if (candidates.error) return html`<${ErrorNotice} error=${candidates.error} onRetry=${candidates.reload} />`;
  if (candidates.loading && !candidates.data) return html`<${Skeleton} lines=${4} />`;
  if (rows.length === 0) {
    return html`<${Empty} title="Nothing is ready to submit" action=${html`<a class="btn" href="/applications?status=awaiting_approval">Review prepared applications</a>`}>
      Applications appear here once every required question is answered.
    </${Empty}>`;
  }
  return html`<form class="run-form" onSubmit=${submit}>
    <fieldset>
      <legend>Applications to submit (${chosen.size} of ${rows.length})</legend>
      <div class="table-wrap pick-list">
        <table class="table">
          <caption class="sr-only">Applications ready to submit</caption>
          <thead><tr><th scope="col"><span class="sr-only">Include</span></th><th scope="col">Company and role</th><th scope="col">Status</th></tr></thead>
          <tbody>
            ${rows.map(
              (row) => html`<tr key=${row.id}>
                <td><input type="checkbox" aria-label=${`Include ${row.company}: ${row.title}`} checked=${chosen.has(row.id)} onChange=${(event) => toggle(row.id, event.currentTarget.checked)} /></td>
                <td><span class="cell-main">${row.company}</span><span class="cell-sub">${row.title}</span></td>
                <td><${Plate} value=${row.status} /></td>
              </tr>`,
            )}
          </tbody>
        </table>
      </div>
    </fieldset>
    <div class="form-grid" style=${{ marginTop: "1rem" }}>
      <div class="field">
        <label class="field__label" for="submit-run-mode">Mode</label>
        <select id="submit-run-mode" class="select" value=${effectiveMode} onChange=${(event) => setMode(event.currentTarget.value)}>
          ${modes.map((option) => html`<option value=${option}>${option === "auto" ? "Auto: fill and submit" : "Assisted: fill, you submit"}</option>`)}
        </select>
      </div>
      <div class="field">
        <label class="field__label" for="submit-run-pace">Seconds between applications</label>
        <input id="submit-run-pace" class="input" type="number" min="0" max="3600" placeholder=${String(meta?.runner?.paceSeconds ?? 90)} value=${pace} onInput=${(event) => setPace(event.currentTarget.value)} />
      </div>
      <div class="field" style=${{ alignSelf: "end" }}>
        <${Check} checked=${headed} onChange=${setHeaded}>Show the browser window</${Check}>
      </div>
    </div>
    <div class="notice notice--held" style=${{ marginTop: "1rem" }}>
      <p class="notice__title">Starting this run approves ${plural(chosen.size, "packet")} exactly as stored and submits them.</p>
      <p>Each still passes every guard: daily limit, pacing, per-company caps and the allowlist. A packet edited after this list loaded is skipped, not approved, and a posting confirmed closed is skipped and marked "Posting closed".</p>
      <${Check} checked=${confirmed} onChange=${setConfirmed}>I reviewed these ${plural(chosen.size, "application")}</${Check}>
    </div>
    <div class="form-actions">
      <${Button} type="submit" kind="primary" busy=${busy} disabled=${!confirmed || chosen.size === 0}>Approve and submit ${chosen.size}</${Button}>
    </div>
  </form>`;
}
