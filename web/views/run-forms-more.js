import { api } from "../api.js";
import { Button, Check, Empty, Toggles } from "../components/ui.js";
import { label, plural } from "../lib/format.js";
import { html, useState } from "../lib/html.js";
import { useAction } from "../lib/hooks.js";
import { setQuery } from "../lib/router.js";
import { toast, useMeta } from "../lib/store.js";

/**
 * Start forms for the hygiene, inbox and sourcing run types. Each posts
 * { type, params } to /api/runs and leaves out anything at its default, so
 * the server's own defaults apply.
 */

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

function NumberField({ id, label: text, value, onInput, min, max, placeholder, hint }) {
  return html`<div class="field">
    <label class="field__label" for=${id}>${text}</label>
    <input id=${id} class="input" type="number" inputmode="numeric" min=${min} max=${max} placeholder=${placeholder} value=${value} onInput=${(event) => onInput(event.currentTarget.value)} aria-describedby=${hint ? `${id}-hint` : undefined} />
    ${hint ? html`<span class="field__hint" id=${`${id}-hint`}>${hint}</span>` : null}
  </div>`;
}

/** Only numbers the person typed are sent; a blank field keeps the server's default. */
function numbers(entries) {
  return Object.fromEntries(entries.filter(([, value]) => value !== "" && value !== null && value !== undefined).map(([key, value]) => [key, Number(value)]));
}

const APPLICATION_STATES = ["awaiting_approval", "approved", "needs_human", "drafted"];

export function LivenessForm({ onStarted }) {
  const [states, setStates] = useState(["awaiting_approval", "approved", "needs_human"]);
  const [includeQueue, setIncludeQueue] = useState(false);
  const [jobIds, setJobIds] = useState("");
  const [limit, setLimit] = useState("");
  const [force, setForce] = useState(false);
  const [busy, start] = useStart(onStarted);
  const ids = jobIds.split(/[\s,]+/).map((id) => id.trim()).filter(Boolean);
  const submit = (event) => {
    event.preventDefault();
    void start("liveness", {
      ...(ids.length ? { jobIds: ids } : { applicationStatuses: states, ...(includeQueue ? { includeQueue: true } : {}) }),
      ...numbers([["limit", limit]]),
      ...(force ? { force: true } : {}),
    });
  };
  return html`<form class="run-form" onSubmit=${submit}>
    <p class="run-form__intro">Asks each posting's board, then its page, whether it still takes applications. Only a confirmed closure stops a submission; an unconfirmed check never does.</p>
    <div class="form-grid">
      <${Toggles}
        legend="Postings of applications that are"
        value=${ids.length ? [] : states}
        onChange=${setStates}
        options=${APPLICATION_STATES.map((value) => ({ value, label: label(value) }))}
      />
      <div class="field form-grid--wide">
        <label class="field__label" for="liveness-jobs">Or these job ids</label>
        <textarea id="liveness-jobs" class="textarea mono" rows="2" placeholder="job_..." value=${jobIds} onInput=${(event) => setJobIds(event.currentTarget.value)}></textarea>
        <span class="field__hint">${ids.length ? `${plural(ids.length, "job")} named; the states above are ignored.` : "Separate ids with spaces, commas or new lines."}</span>
      </div>
      <${NumberField} id="liveness-limit" label="At most" value=${limit} onInput=${setLimit} min="1" max="2000" placeholder="200" />
    </div>
    <div class="form-actions">
      <${Button} type="submit" kind="primary" busy=${busy} disabled=${!ids.length && states.length === 0 && !includeQueue}>Check postings</${Button}>
      ${ids.length ? null : html`<${Check} checked=${includeQueue} onChange=${setIncludeQueue}>Also the top of the unapplied queue</${Check}>`}
      <${Check} checked=${force} onChange=${setForce}>Re-check fresh verdicts too</${Check}>
    </div>
  </form>`;
}

export function CloseStaleForm({ onStarted }) {
  const meta = useMeta().data;
  const [dryRun, setDryRun] = useState(true);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, start] = useStart(onStarted);
  const days = meta?.followUps?.ghostAfterDays;
  const submit = (event) => {
    event.preventDefault();
    void start("close-stale", { dryRun });
  };
  return html`<form class="run-form" onSubmit=${submit}>
    <p class="run-form__intro">
      <strong>Dry run by default: it records nothing.</strong> It lists submitted applications with no reply beyond an acknowledgement ${days ? `after ${days} days` : "past campaign.followUps.ghostAfterDays"}, and at least a week after your last follow-up.
    </p>
    <div class="form-actions" style=${{ marginTop: 0 }}>
      <${Check} checked=${dryRun} onChange=${(value) => { setDryRun(value); setConfirmed(false); }}>Dry run: list them and record nothing</${Check}>
    </div>
    ${dryRun
      ? null
      : html`<div class="notice notice--held" style=${{ marginTop: "1rem" }}>
          <p class="notice__title">This records "ghosted" on every application it lists.</p>
          <p>A later reply from the employer reopens the application. Run the dry run first to see the list.</p>
          <${Check} checked=${confirmed} onChange=${setConfirmed}>Record them as ghosted</${Check}>
        </div>`}
    <div class="form-actions">
      <${Button} type="submit" kind=${dryRun ? "primary" : "danger"} busy=${busy} disabled=${!dryRun && !confirmed}>${dryRun ? "Preview (dry run)" : "Close as ghosted"}</${Button}>
    </div>
  </form>`;
}

export function InboxForm({ onStarted }) {
  const meta = useMeta().data;
  const [lookbackDays, setLookbackDays] = useState("");
  const [dryRun, setDryRun] = useState(false);
  const [busy, start] = useStart(onStarted);
  if (meta && !meta.inbox?.enabled) {
    return html`<${Empty} title="Reply reading is off" action=${html`<a class="btn" href="/inbox">Paste a reply instead</a>`}>
      Set <code>campaign.inbox.enabled</code> to true and name a mailbox with <code>AUTOAPPLY_INBOX_IMAP_*</code> (or reuse <code>AUTOAPPLY_OTP_IMAP_*</code>) in the secrets file. Health shows whether one is configured.
    </${Empty}>`;
  }
  const automatic = meta?.inbox?.autoRecord ?? [];
  const submit = (event) => {
    event.preventDefault();
    void start("inbox", { ...numbers([["lookbackDays", lookbackDays]]), ...(dryRun ? { dryRun: true } : {}) });
  };
  return html`<form class="run-form" onSubmit=${submit}>
    <p class="run-form__intro">
      Reads replies to submitted applications, read-only: nothing is marked read, moved or deleted.
      ${automatic.length
        ? html` Replies read with high confidence as <strong>${automatic.map((kind) => label(kind).toLowerCase()).join(" or ")}</strong> are recorded without review (<code>campaign.inbox.autoRecord</code>); everything else waits for you in the Inbox.`
        : " Every reply waits for you in the Inbox; nothing is recorded without you."}
    </p>
    <div class="form-grid">
      <${NumberField} id="inbox-lookback" label="Days to read back" value=${lookbackDays} onInput=${setLookbackDays} min="1" max="365" placeholder="Since the last scan" hint="Only the first scan of a folder needs this." />
    </div>
    <div class="form-actions">
      <${Button} type="submit" kind="primary" busy=${busy}>Scan the mailbox</${Button}>
      <${Check} checked=${dryRun} onChange=${setDryRun}>Dry run: store nothing</${Check}>
    </div>
  </form>`;
}

export function AlertsForm({ onStarted }) {
  const [lookbackDays, setLookbackDays] = useState("");
  const [busy, start] = useStart(onStarted);
  const submit = (event) => {
    event.preventDefault();
    void start("alerts", numbers([["lookbackDays", lookbackDays]]));
  };
  return html`<form class="run-form" onSubmit=${submit}>
    <p class="run-form__intro">Reads LinkedIn job-alert emails from the verification mailbox, read-only, and stores each posting as a lead. Nothing visits LinkedIn. Forward your alerts to that mailbox to use this.</p>
    <div class="form-grid">
      <${NumberField} id="alerts-lookback" label="Days to read back" value=${lookbackDays} onInput=${setLookbackDays} min="1" max="90" placeholder="14" />
    </div>
    <div class="form-actions"><${Button} type="submit" kind="primary" busy=${busy}>Import alerts</${Button}></div>
  </form>`;
}

export function FundedForm({ onStarted }) {
  const [months, setMonths] = useState("");
  const [limit, setLimit] = useState("");
  const [busy, start] = useStart(onStarted);
  const submit = (event) => {
    event.preventDefault();
    void start("funded", numbers([["months", months], ["limit", limit]]));
  };
  return html`<form class="run-form" onSubmit=${submit}>
    <p class="run-form__intro">Reads public funding-news feeds (no login, no scraping) and stores recently funded companies as leads. A funding round hints at hiring; it is not a job.</p>
    <div class="form-grid">
      <${NumberField} id="funded-months" label="Announced within (months)" value=${months} onInput=${setMonths} min="1" max="24" placeholder="3" />
      <${NumberField} id="funded-limit" label="At most (companies)" value=${limit} onInput=${setLimit} min="1" max="200" placeholder="50" />
    </div>
    <div class="form-actions"><${Button} type="submit" kind="primary" busy=${busy}>Read funding news</${Button}></div>
  </form>`;
}

export function ProposeForm({ onStarted }) {
  const [limit, setLimit] = useState("");
  const [busy, start] = useStart(onStarted);
  const submit = (event) => {
    event.preventDefault();
    void start("propose", numbers([["limit", limit]]));
  };
  return html`<form class="run-form" onSubmit=${submit}>
    <p class="run-form__intro">Finds and verifies a public ATS board for companies named in new leads. It writes nothing to companies.json: you accept each board on the Leads page. Each company can take dozens of probe requests, so keep this small.</p>
    <div class="form-grid">
      <${NumberField} id="propose-limit" label="Companies to resolve" value=${limit} onInput=${setLimit} min="1" max="25" placeholder="5" />
    </div>
    <div class="form-actions"><${Button} type="submit" kind="primary" busy=${busy}>Propose boards</${Button}></div>
  </form>`;
}

const HARVEST_ATS = ["greenhouse", "ashby", "lever", "workday"];

export function HarvestForm({ onStarted }) {
  const [ats, setAts] = useState([]);
  const [indexes, setIndexes] = useState("");
  const [maxPages, setMaxPages] = useState("");
  const [scan, setScan] = useState(true);
  const [scanLimit, setScanLimit] = useState("");
  const [busy, start] = useStart(onStarted);
  const submit = (event) => {
    event.preventDefault();
    void start("harvest", {
      ...(ats.length ? { ats } : {}),
      ...numbers([["indexes", indexes], ["maxPages", maxPages], ...(scan ? [["scanLimit", scanLimit]] : [])]),
      ...(scan ? {} : { scan: false }),
    });
  };
  return html`<form class="run-form" onSubmit=${submit}>
    <p class="run-form__intro">Reads the Common Crawl URL index for public ATS boards, then scans the untracked ones for roles that pass your gates. It can take an hour and keeps going while this page is closed.</p>
    <div class="form-grid">
      <${Toggles} legend="Board types (none picked: all four)" value=${ats} onChange=${setAts} options=${HARVEST_ATS.map((value) => ({ value, label: label(value) }))} />
      <${NumberField} id="harvest-indexes" label="Crawl indexes" value=${indexes} onInput=${setIndexes} min="1" max="12" placeholder="1" hint="The most recent first." />
      <${NumberField} id="harvest-pages" label="Index pages, at most" value=${maxPages} onInput=${setMaxPages} min="1" max="500" placeholder="All" />
      ${scan ? html`<${NumberField} id="harvest-scan-limit" label="Boards to scan" value=${scanLimit} onInput=${setScanLimit} min="1" max="5000" placeholder="200" />` : null}
    </div>
    <div class="form-actions">
      <${Button} type="submit" kind="primary" busy=${busy}>Start harvesting</${Button}>
      <${Check} checked=${scan} onChange=${setScan}>Scan untracked boards afterwards</${Check}>
    </div>
  </form>`;
}
