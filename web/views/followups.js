import { api } from "../api.js";
import { DataTable } from "../components/table.js";
import { Button, CopyButton, Empty, ErrorNotice, PageHead, Plate, Skeleton } from "../components/ui.js";
import { ago, dateTime, label, num, plural } from "../lib/format.js";
import { html } from "../lib/html.js";
import { useAction, useResource, useTitle } from "../lib/hooks.js";
import { navigate, setQuery } from "../lib/router.js";
import { toast, useStatus } from "../lib/store.js";

/**
 * Follow-ups that are due, each with a draft to copy and send yourself.
 * "I sent it" records that you sent it, which counts as contact. "Skip"
 * resolves the reminder without sending: it is not counted as contact, so
 * the next reminder and the ghost-close date keep their dates. Snoozing asks
 * again later. Nothing is sent from here.
 */

const KIND_TEXT = { first: "First follow-up", second: "Second follow-up", close: "Close as ghosted" };
const HORIZONS = [7, 14, 30];
const SKIP_TITLE = "Resolve this reminder without sending. It does not count as contact, so the next reminder and the ghost-close date keep their dates.";

function overdueText(days) {
  if (days <= 0) return "due today";
  return `${plural(days, "day")} overdue`;
}

function useStartPreview() {
  const [busy, run] = useAction(toast);
  const preview = async () => {
    const result = await run(() => api.post("/api/runs", { type: "close-stale", params: { dryRun: true } }), {
      success: "Dry run started: it lists what would close and records nothing.",
    });
    if (result) navigate(`/runs?start=close-stale&run=${encodeURIComponent(result.runId)}`);
  };
  return [busy, preview];
}

function Due({ item, onDone }) {
  const [busy, run] = useAction(toast);
  const [previewBusy, preview] = useStartPreview();
  const status = useStatus();
  const mark = async (action, success) => {
    const result = await run(
      () => api.post("/api/follow-ups/mark", { applicationId: item.applicationId, kind: item.kind, action, ...(action === "snooze" ? { days: 3 } : {}) }),
      { success },
    );
    if (result) {
      status.reload({ quiet: true });
      onDone();
    }
  };
  const contact = item.channel.channel === "none" ? null : item.channel;
  return html`<li class="followup">
    <div class="followup__head">
      <span>
        <a class="cell-main" href=${`/applications?app=${encodeURIComponent(item.applicationId)}`}>${item.company}</a>
        <span class="cell-sub">${item.title}</span>
      </span>
      <span class="row">
        <${Plate} value=${item.kind} text=${KIND_TEXT[item.kind] ?? label(item.kind)} />
        <span class=${`small${item.overdueDays > 0 ? " text-warn" : " muted"}`}>${overdueText(item.overdueDays)}</span>
      </span>
    </div>
    <p class="small muted">Submitted ${plural(item.daysSinceSubmission, "day")} ago.${item.kind === "close" ? null : contact ? html` Send via <strong>${label(contact.channel)}</strong>: ${contact.detail}.` : " No contact on file: reply to the application's confirmation email, or find the recruiter first."}</p>
    ${item.kind === "close"
      ? html`<p class="small">${item.suggestion}</p>`
      : html`<pre class="draft__text" tabindex="0" aria-label=${`Draft follow-up to ${item.company}`}>${item.draft}</pre>`}
    ${item.note ? html`<p class="small muted">Your note: ${item.note}</p>` : null}
    <div class="followup__actions">
      ${item.kind === "close"
        ? html`<${Button} busy=${previewBusy} onClick=${preview}>Preview closing (dry run)</${Button}>`
        : html`<${CopyButton} text=${item.draft} label="Copy draft" small=${false} />
            <${Button} kind="primary" busy=${busy} onClick=${() => mark("done", "Recorded as sent by you.")}>I sent it</${Button}>
            <${Button} busy=${busy} title=${SKIP_TITLE} onClick=${() => mark("skip", "Skipped. Not counted as contact, so the next reminder keeps its date.")}>Skip this one</${Button}>`}
      <${Button} kind="ghost" busy=${busy} onClick=${() => mark("snooze", "Snoozed for 3 days.")}>Snooze 3 days</${Button}>
    </div>
  </li>`;
}

/** Sent and skipped follow-ups from the last 30 days, so a skip never reads as contact. */
function Handled({ handled }) {
  return html`<section class="section" aria-labelledby="handled-title">
    <div class="section__head">
      <h2 id="handled-title">Recently handled</h2>
      <p class="small muted">Last 30 days. Skipped ones were not sent and do not count as contact.</p>
    </div>
    <${DataTable}
      caption="Follow-ups handled in the last 30 days"
      columns=${[
        { key: "when", label: "Handled", render: (row) => html`<span class="nowrap" title=${dateTime(row.handledAt)}>${ago(row.handledAt)}</span>` },
        { key: "role", label: "Application", render: (row) => html`<a class="cell-main" href=${`/applications?app=${encodeURIComponent(row.applicationId)}`}>${row.company}</a><span class="cell-sub">${row.title}</span>` },
        { key: "kind", label: "Step", render: (row) => html`<span class="small">${KIND_TEXT[row.kind] ?? label(row.kind)}</span>` },
        {
          key: "outcome",
          label: "Outcome",
          render: (row) => html`${row.skipped ? html`<${Plate} tone="muted" text="Skipped" />` : html`<${Plate} tone="ok" text="Sent" />`}${row.note ? html`<span class="cell-sub">${row.note}</span>` : null}`,
        },
      ]}
      rows=${handled ?? []}
      rowKey=${(row) => `${row.applicationId}-${row.kind}`}
      empty=${html`<${Empty} title="Nothing handled in the last 30 days" />`}
    />
  </section>`;
}

function Excluded({ excluded }) {
  const entries = Object.entries(excluded ?? {});
  if (entries.length === 0) return null;
  return html`<p class="small muted">Not followed up: ${entries.map(([reason, count]) => `${reason} (${num(count)})`).join(" · ")}.</p>`;
}

export default function FollowUps({ query }) {
  useTitle("Follow-ups");
  const horizon = HORIZONS.includes(Number(query.get("days"))) ? Number(query.get("days")) : 7;
  const plan = useResource(() => api.get("/api/follow-ups", { horizonDays: horizon }), [horizon]);
  const [previewBusy, preview] = useStartPreview();
  const data = plan.data;
  const policy = data?.policy;

  return html`<div>
    <${PageHead}
      title="Follow-ups"
      sub=${policy
        ? `Drafts for you to send yourself; nothing is sent from here. First after ${policy.firstAfterDays} days, second after ${policy.secondAfterDays}, closed as ghosted after ${policy.ghostAfterDays}.`
        : "Drafts for you to send yourself; nothing is sent from here."}
    />
    ${plan.error ? html`<${ErrorNotice} error=${plan.error} onRetry=${plan.reload} />` : null}
    ${plan.loading && !data ? html`<div class="panel panel--pad"><${Skeleton} lines=${5} /></div>` : null}
    ${data && !data.enabled
      ? html`<div class="panel"><${Empty} title="Follow-ups are off">Set <code>campaign.followUps.enabled</code> to true to get reminders and drafts after submitting.</${Empty}></div>`
      : null}
    ${data?.enabled
      ? html`
          <section aria-labelledby="due-title">
            <div class="section__head">
              <h2 id="due-title">Due now</h2>
              <${Excluded} excluded=${data.excluded} />
            </div>
            ${data.due.length
              ? html`<ul class="rows">${data.due.map((item) => html`<${Due} key=${`${item.applicationId}-${item.kind}`} item=${item} onDone=${() => plan.reload({ quiet: true })} />`)}</ul>`
              : html`<div class="panel"><${Empty} title="Nothing is due">Follow-ups fall due ${policy.firstAfterDays} days after you submit, if the employer has not replied.</${Empty}></div>`}
          </section>
          <section class="section" aria-labelledby="upcoming-title">
            <div class="section__head">
              <h2 id="upcoming-title">Coming up</h2>
              <div class="field" style=${{ flexDirection: "row" }}>
                <label class="field__label sr-only" for="followup-horizon">Look ahead</label>
                <select id="followup-horizon" class="select" value=${String(horizon)} onChange=${(event) => setQuery({ days: event.currentTarget.value === "7" ? undefined : event.currentTarget.value })}>
                  ${HORIZONS.map((days) => html`<option value=${String(days)}>Next ${days} days</option>`)}
                </select>
              </div>
            </div>
            <${DataTable}
              caption="Follow-ups coming up"
              columns=${[
                { key: "date", label: "Due", render: (row) => html`<span class="nowrap">${row.dueDate}</span>` },
                { key: "role", label: "Application", render: (row) => html`<a class="cell-main" href=${`/applications?app=${encodeURIComponent(row.applicationId)}`}>${row.company}</a><span class="cell-sub">${row.title}</span>` },
                { key: "kind", label: "Step", render: (row) => html`<${Plate} value=${row.kind} text=${KIND_TEXT[row.kind] ?? label(row.kind)} />` },
              ]}
              rows=${data.upcoming}
              rowKey=${(row) => `${row.applicationId}-${row.kind}`}
              empty=${html`<${Empty} title=${`Nothing falls due in the next ${horizon} days`} />`}
            />
          </section>
          <${Handled} handled=${data.handled} />
          <section class="section" aria-labelledby="stale-title">
            <div class="section__head"><h2 id="stale-title">Long-silent applications</h2></div>
            <div class="panel panel--pad stack">
              <p>After ${policy.ghostAfterDays} days with no reply beyond an acknowledgement, an application can be closed as ghosted. Preview the list first: the dry run records nothing.</p>
              <div class="row">
                <${Button} busy=${previewBusy} onClick=${preview}>Preview (dry run)</${Button}>
                <a href="/runs?start=close-stale" class="small">Record them from Runs</a>
              </div>
            </div>
          </section>
        `
      : null}
  </div>`;
}
