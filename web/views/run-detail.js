import { api, followRun } from "../api.js";
import { Drawer } from "../components/drawer.js";
import { Button, ErrorNotice, Plate, Progress, Skeleton } from "../components/ui.js";
import { clock, dateTime, duration, label, num, plural } from "../lib/format.js";
import { html, useEffect, useRef, useState } from "../lib/html.js";
import { useAction } from "../lib/hooks.js";
import { isActive, isClosedLine, livenessClosed, logClass, postingClosedCount, runSummary, runTitle } from "../lib/runs.js";
import { toast, useStatus } from "../lib/store.js";

/** One run: progress, result, and its log streaming live over server-sent events. */

const MAX_LINES = 2000;

function useRunStream(runId) {
  const [run, setRun] = useState(null);
  const [lines, setLines] = useState([]);
  const [error, setError] = useState(null);
  const [live, setLive] = useState(false);

  useEffect(() => {
    let closed = false;
    let lastSeq = 0;
    let stop = () => {};
    setRun(null);
    setLines([]);
    setError(null);
    api
      .get(`/api/runs/${encodeURIComponent(runId)}`)
      .then((detail) => {
        if (closed) return;
        setRun(detail.run);
        setLines(detail.logs);
        lastSeq = detail.logs.at(-1)?.seq ?? 0;
        if (!isActive(detail.run)) return;
        setLive(true);
        stop = followRun(
          runId,
          {
            log: (line) => {
              if (line.seq <= lastSeq) return;
              lastSeq = line.seq;
              setLines((previous) => [...previous, line].slice(-MAX_LINES));
            },
            progress: (progress) => setRun((previous) => (previous ? { ...previous, progressDone: progress.done, progressTotal: progress.total } : previous)),
            run: (next) => setRun((previous) => ({ ...previous, ...next })),
            end: () => {
              setLive(false);
              // The stored record carries the final summary as the dashboard reads it (closed postings marked).
              api
                .get(`/api/runs/${encodeURIComponent(runId)}`)
                .then((final) => !closed && setRun(final.run))
                .catch(() => {});
            },
            error: () => setLive(false),
          },
          lastSeq,
        );
      })
      .catch((failure) => !closed && setError(failure));
    return () => {
      closed = true;
      stop();
    };
  }, [runId]);

  return { run, lines, error, live };
}

function itemPlate(item) {
  if (item.code === "posting_closed") return html`<${Plate} text="Posting closed" tone="bad" title="The employer no longer takes applications for this posting" />`;
  const outcome = item.outcome ?? item.state;
  const tone = outcome === "sent" || outcome === "ready" ? "ok" : outcome === "failed" ? "bad" : outcome === "needs_human" ? "held" : "muted";
  return html`<${Plate} text=${label(outcome)} tone=${tone} />`;
}

function SummaryItems({ run }) {
  const items = run.summary?.items;
  if (!Array.isArray(items) || items.length === 0) return null;
  const isSubmit = run.type === "submit";
  return html`<div class="table-wrap">
    <table class="table">
      <caption class="sr-only">Per-item results</caption>
      <thead><tr><th scope="col">${isSubmit ? "Application" : "Job"}</th><th scope="col">Result</th><th scope="col">Detail</th></tr></thead>
      <tbody>
        ${items.slice(0, 200).map((item) => {
          const id = item.applicationId;
          return html`<tr key=${id ?? item.jobId}>
            <td>
              ${id ? html`<a class="cell-main" href=${`/applications?app=${encodeURIComponent(id)}`}>${item.company}</a>` : html`<a class="cell-main" href=${`/jobs?job=${encodeURIComponent(item.jobId)}&dismissed=include`}>${item.company}</a>`}
              <span class="cell-sub">${item.title}</span>
            </td>
            <td>${itemPlate(item)}</td>
            <td class="small" style=${{ maxWidth: "20rem", overflowWrap: "anywhere" }}>
              ${item.reason ?? item.detail ?? ""}
              ${item.code === "posting_closed" && id
                ? html`<span class="cell-sub">Dismiss the job to take it out of the queue; its application is then skipped.</span>`
                : null}
            </td>
          </tr>`;
        })}
      </tbody>
    </table>
  </div>`;
}

/** The postings a liveness run found closed, or the applications close-stale picked. */
function ResultList({ run }) {
  const summary = run.summary ?? {};
  const closed = run.type === "liveness" ? livenessClosed(summary).postings : [];
  if (closed.length > 0) {
    return html`<section class="drawer__section">
      <h3>Closed postings</h3>
      <ul class="plain-list">
        ${closed.map(
          (entry) => html`<li key=${entry.jobId}>
            <a href=${`/jobs?job=${encodeURIComponent(entry.jobId)}&dismissed=include`}>${entry.company}: ${entry.title}</a>
            <span class="cell-sub">${entry.detail}</span>
          </li>`,
        )}
      </ul>
    </section>`;
  }
  if (run.type === "close-stale" && Array.isArray(summary.closed)) {
    return html`<section class="drawer__section">
      <h3>${summary.dryRun ? "Would be closed as ghosted" : "Closed as ghosted"}</h3>
      ${summary.dryRun ? html`<p class="notice" style=${{ marginBottom: "0.75rem" }}>Dry run: nothing was recorded. Start close-stale with dry run off to record these.</p>` : null}
      ${summary.closed.length
        ? html`<ul class="plain-list">
            ${summary.closed.map(
              (entry) => html`<li key=${entry.applicationId}>
                <a href=${`/applications?app=${encodeURIComponent(entry.applicationId)}`}>${entry.company}: ${entry.title}</a>
                <span class="cell-sub">Silent for ${plural(entry.silentDays, "day")}</span>
              </li>`,
            )}
          </ul>`
        : html`<p class="muted">No application has been silent long enough.</p>`}
    </section>`;
  }
  const next = { propose: ["/leads", "Review the proposals on Leads"], inbox: ["/inbox", "Review replies in the Inbox"], alerts: ["/leads", "See the new leads"], funded: ["/leads", "See the new leads"], harvest: ["/leads", "See what harvesting found"] }[run.type];
  return next && !isActive(run) ? html`<section class="drawer__section"><a class="btn" href=${next[0]}>${next[1]}</a></section>` : null;
}

export function RunDetail({ runId, onClose, onChanged }) {
  const { run, lines, error, live } = useRunStream(runId);
  const [follow, setFollow] = useState(true);
  const [busy, act] = useAction(toast);
  const status = useStatus();
  const log = useRef(null);

  useEffect(() => {
    if (follow && log.current) log.current.scrollTop = log.current.scrollHeight;
  }, [lines.length, follow]);

  useEffect(() => {
    if (run && !isActive(run)) {
      status.reload({ quiet: true });
      onChanged?.();
    }
  }, [run?.status]);

  const cancel = async () => {
    const result = await act(() => api.post(`/api/runs/${encodeURIComponent(runId)}/cancel`), {
      success: (outcome) =>
        outcome.outcome === "requested"
          ? "Asked the process hosting this run to stop it."
          : outcome.outcome === "signalled"
            ? "Stopping after the current item."
            : "Cancelled.",
    });
    if (result) onChanged?.();
  };

  const onScroll = () => {
    const element = log.current;
    if (!element) return;
    const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
    if (atBottom !== follow) setFollow(atBottom);
  };

  return html`<${Drawer}
    wide
    title=${run ? runTitle(run) : "Run"}
    sub=${html`<span class="mono">${runId}</span>`}
    onClose=${onClose}
    actions=${run && isActive(run) ? html`<${Button} kind="danger" small busy=${busy} onClick=${cancel}>Cancel run</${Button}>` : null}
  >
    ${error ? html`<${ErrorNotice} error=${error} />` : null}
    ${!run && !error ? html`<${Skeleton} lines=${5} />` : null}
    ${run
      ? html`
          <section class="drawer__section">
            <dl class="facts">
              <dt>Status</dt>
              <dd class="row"><${Plate} value=${run.status} />${live ? html`<span class="small muted">Following live</span>` : null}</dd>
              <dt>Progress</dt><dd><${Progress} done=${run.progressDone} total=${run.progressTotal} /></dd>
              <dt>Started</dt><dd>${run.startedAt ? dateTime(run.startedAt) : "Waiting for a free slot"}</dd>
              <dt>Time</dt><dd>${run.startedAt ? duration(run.startedAt, run.finishedAt) : "-"}</dd>
              <dt>Host</dt><dd>${run.hostedHere ? "This dashboard" : `Another process (pid ${run.hostPid}) on ${run.hostName}`}</dd>
              ${runSummary(run) ? html`<dt>Result</dt><dd>${runSummary(run)}</dd>` : null}
              ${run.error ? html`<dt>Error</dt><dd class="field__error">${run.error}</dd>` : null}
            </dl>
          </section>
          <section class="drawer__section">
            <div class="section__head">
              <h3>Log</h3>
              <span class="small muted">${num(lines.length)} line${lines.length === 1 ? "" : "s"}${follow ? "" : " · scrolled up, not following"}</span>
            </div>
            <ol class="log" role="log" aria-live="polite" aria-label="Run log" tabindex="0" ref=${log} onScroll=${onScroll}>
              ${lines.length === 0 ? html`<li class="log__empty">No log lines yet.</li>` : null}
              ${lines.map(
                (line) => html`<li key=${line.seq} class=${logClass(line)}>
                  <time datetime=${line.ts}>${clock(line.ts)}</time>
                  <span>${isClosedLine(line) ? html`<span class="log__tag">posting closed</span> ` : null}${line.message}</span>
                </li>`,
              )}
            </ol>
          </section>
          ${run.summary?.items?.length
            ? html`<section class="drawer__section">
                <h3>Items</h3>
                ${postingClosedCount(run.summary)
                  ? html`<p class="notice notice--bad" style=${{ marginBottom: "0.75rem" }}>
                      ${plural(postingClosedCount(run.summary), "posting was", "postings were")} confirmed closed and skipped: the employer no longer takes applications there.
                    </p>`
                  : null}
                <${SummaryItems} run=${run} />
              </section>`
            : null}
          <${ResultList} run=${run} />
        `
      : null}
  </${Drawer}>`;
}
