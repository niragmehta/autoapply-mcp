import { api } from "../api.js";
import { RunBoard } from "../components/runboard.js";
import { Button, Empty, ErrorNotice, PageHead } from "../components/ui.js";
import { label } from "../lib/format.js";
import { html } from "../lib/html.js";
import { useResource, useTitle } from "../lib/hooks.js";
import { setQuery } from "../lib/router.js";
import { useMeta } from "../lib/store.js";
import { RunDetail } from "./run-detail.js";
import { DiscoveryForm, PrepareForm, SubmitForm } from "./run-forms.js";
import { AlertsForm, CloseStaleForm, FundedForm, HarvestForm, InboxForm, LivenessForm, ProposeForm } from "./run-forms-more.js";

/** Start any run type, watch runs live, and read their history. */

const RUN_TYPES = [
  {
    group: "Pipeline",
    types: [
      { id: "discovery", label: "Discovery", blurb: "Fetch, gate and score postings", Form: DiscoveryForm },
      { id: "prepare", label: "Prepare", blurb: "Draft applications from the queue", Form: PrepareForm },
      { id: "submit", label: "Submit", blurb: "Approve and send chosen packets", Form: SubmitForm },
    ],
  },
  {
    group: "Hygiene",
    types: [
      { id: "liveness", label: "Liveness", blurb: "Confirm postings are still open", Form: LivenessForm },
      { id: "close-stale", label: "Close stale", blurb: "Ghosted after long silence; dry run first", Form: CloseStaleForm },
    ],
  },
  {
    group: "After applying",
    types: [{ id: "inbox", label: "Inbox scan", blurb: "Read employer replies", Form: InboxForm }],
  },
  {
    group: "Sources",
    types: [
      { id: "alerts", label: "Job alerts", blurb: "Import LinkedIn alerts as leads", Form: AlertsForm },
      { id: "funded", label: "Funded companies", blurb: "Funding news as leads", Form: FundedForm },
      { id: "propose", label: "Propose boards", blurb: "Verify boards for lead companies", Form: ProposeForm },
      { id: "harvest", label: "Harvest boards", blurb: "Find boards in Common Crawl", Form: HarvestForm },
    ],
  },
];

const ALL_TYPES = RUN_TYPES.flatMap((group) => group.types);

const STATUS_FILTERS = ["", "running", "queued", "succeeded", "failed", "cancelled", "interrupted"];

function TypePicker({ current, available, onPick }) {
  return html`<div>
    <div class="field runtype-select">
      <label class="field__label" for="run-type-select">Run type</label>
      <select id="run-type-select" class="select" value=${current} onChange=${(event) => onPick(event.currentTarget.value)}>
        ${RUN_TYPES.map((group) => {
          const types = group.types.filter((type) => available(type.id));
          return types.length ? html`<optgroup label=${group.group}>${types.map((type) => html`<option value=${type.id}>${type.label}: ${type.blurb}</option>`)}</optgroup>` : null;
        })}
      </select>
    </div>
    <fieldset class="runtypes">
      <legend class="sr-only">Run type</legend>
      ${RUN_TYPES.map((group) => {
        const types = group.types.filter((type) => available(type.id));
        if (types.length === 0) return null;
        return html`<div class="runtypes__group" key=${group.group}>
          <p class="runtypes__label" aria-hidden="true">${group.group}</p>
          ${types.map(
            (type) => html`<label class=${`runtype${type.id === current ? " is-current" : ""}`} key=${type.id}>
              <input type="radio" name="run-type" value=${type.id} checked=${type.id === current} onChange=${() => onPick(type.id)} />
              <span class="runtype__name">${type.label}</span>
              <span class="runtype__blurb">${type.blurb}</span>
            </label>`,
          )}
        </div>`;
      })}
    </fieldset>
  </div>`;
}

export default function Runs({ query }) {
  useTitle("Runs");
  const openRun = query.get("run");
  const statusFilter = query.get("status") ?? "";
  const meta = useMeta().data;
  const registered = new Set((meta?.runTypes ?? []).map((type) => type.type));
  // Before /api/meta answers, offer every known type; afterwards only the ones this host registered.
  const available = (id) => !meta || registered.has(id);
  const requested = query.get("start");
  const current = ALL_TYPES.find((type) => type.id === requested && available(type.id)) ?? ALL_TYPES.find((type) => available(type.id)) ?? ALL_TYPES[0];
  const history = useResource(() => api.get("/api/runs", { status: statusFilter, limit: 100 }), [statusFilter], { interval: 5000 });
  const extraTypes = (meta?.runTypes ?? []).filter((type) => !ALL_TYPES.some((known) => known.id === type.type));
  const Form = current.Form;

  return html`<div>
    <${PageHead} title="Runs" sub="Long operations run here in the dashboard's process and keep going while this page is closed." />
    <section class="panel runner" aria-labelledby="start-title">
      <div class="runner__types">
        <h2 id="start-title" class="runner__title">Start a run</h2>
        <${TypePicker} current=${current.id} available=${available} onPick=${(id) => setQuery({ start: id })} />
      </div>
      <div class="runner__form" aria-labelledby="run-form-title">
        <h3 id="run-form-title" class="runner__form-title">${current.label}</h3>
        <${Form} key=${current.id} onStarted=${() => history.reload({ quiet: true })} />
        ${extraTypes.length
          ? html`<p class="small muted" style=${{ marginTop: "1rem" }}>Also registered, startable through the API: ${extraTypes.map((type) => label(type.type)).join(", ")}.</p>`
          : null}
      </div>
    </section>
    <section class="section" aria-labelledby="history-title">
      <div class="section__head">
        <h2 id="history-title">History</h2>
        <div class="field" style=${{ flexDirection: "row" }}>
          <label class="field__label sr-only" for="run-status">Status</label>
          <select id="run-status" class="select" value=${statusFilter} onChange=${(event) => setQuery({ status: event.currentTarget.value })}>
            ${STATUS_FILTERS.map((value) => html`<option value=${value}>${value ? label(value) : "All statuses"}</option>`)}
          </select>
        </div>
      </div>
      ${history.error ? html`<${ErrorNotice} error=${history.error} onRetry=${history.reload} />` : null}
      <${RunBoard}
        runs=${history.data?.runs}
        caption="Run history"
        loading=${history.loading}
        selectedKey=${openRun}
        onOpen=${(run) => setQuery({ run: run.id }, { replace: false })}
        empty=${statusFilter
          ? html`<${Empty} title=${`No ${label(statusFilter).toLowerCase()} runs`} action=${html`<${Button} small onClick=${() => setQuery({ status: undefined })}>Show all runs</${Button}>`} />`
          : html`<${Empty} title="No runs yet">Start one above. A discovery run is the usual first step.</${Empty}>`}
      />
    </section>
    ${openRun ? html`<${RunDetail} key=${openRun} runId=${openRun} onClose=${() => setQuery({ run: undefined })} onChanged=${() => history.reload({ quiet: true })} />` : null}
  </div>`;
}
