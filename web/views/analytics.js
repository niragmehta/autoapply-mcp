import { api } from "../api.js";
import { DataTable } from "../components/table.js";
import { Button, Empty, ErrorNotice, Icon, PageHead, Plate, RateText, Skeleton, SMALL_SAMPLE } from "../components/ui.js";
import { ago, bytes, label, num } from "../lib/format.js";
import { html, useState } from "../lib/html.js";
import { useAction, useResource, useTitle } from "../lib/hooks.js";
import { setQuery } from "../lib/router.js";
import { toast, useMeta } from "../lib/store.js";

/**
 * How the campaign converts. Every rate is printed with its sample ("25%,
 * 3 of 12") and rates on fewer than ten cases are marked as small samples,
 * so a ratio is never read without the count behind it.
 */

const DIMENSIONS = ["tier", "track", "ats", "companyTier", "scoreBand", "locationClass", "submissionMode", "weekSubmitted"];

const days = (value) => (value === null || value === undefined ? "-" : `${Math.round(value * 10) / 10} d`);

/** A group's name: campaign tracks by their label, everything else as words. */
function useGroupLabel() {
  const tracks = useMeta().data?.tracks ?? [];
  return (dimension, key) => {
    if (dimension === "track") return tracks.find((track) => track.id === key)?.label ?? label(key);
    if (dimension === "weekSubmitted" || dimension === "scoreBand") return key;
    return label(key);
  };
}

function Section({ id, title, note, children, wide }) {
  return html`<section class=${`section${wide ? " analytics__wide" : ""}`} aria-labelledby=${id}>
    <div class="section__head"><h2 id=${id}>${title}</h2>${note ? html`<p class="section__note">${note}</p>` : null}</div>
    ${children}
  </section>`;
}

function Funnel({ funnel }) {
  return html`<${DataTable}
    caption="Funnel"
    columns=${[
      { key: "stage", label: "Stage", render: (row) => html`<span class="cell-main">${label(row.stage)}</span>` },
      { key: "count", label: "Count", numeric: true, render: (row) => num(row.count) },
      { key: "previous", label: "From the stage before", render: (row) => html`<${RateText} rate=${row.fromPrevious} />` },
      { key: "submitted", label: "Of submitted", render: (row) => html`<${RateText} rate=${row.fromSubmitted} />` },
    ]}
    rows=${funnel.stages}
    rowKey=${(row) => row.stage}
    empty=${html`<${Empty} title="Nothing to count yet" />`}
  />`;
}

function Conversion({ conversion }) {
  const [dimension, setDimension] = useState("tier");
  const groupLabel = useGroupLabel();
  const rows = conversion[dimension] ?? [];
  return html`<div class="stack">
    <div class="field" style=${{ maxWidth: "16rem" }}>
      <label class="field__label" for="conversion-by">Break down by</label>
      <select id="conversion-by" class="select" value=${dimension} onChange=${(event) => setDimension(event.currentTarget.value)}>
        ${DIMENSIONS.map((value) => html`<option value=${value}>${label(value)}</option>`)}
      </select>
    </div>
    <${DataTable}
      caption=${`Conversion by ${label(dimension).toLowerCase()}`}
      columns=${[
        { key: "key", label: label(dimension), render: (row) => html`<span class="cell-main">${groupLabel(dimension, row.key)}</span>` },
        { key: "submitted", label: "Submitted", numeric: true, render: (row) => num(row.submitted) },
        { key: "replied", label: "Replied", render: (row) => html`<${RateText} rate=${row.replied} />` },
        { key: "advanced", label: "Advanced", render: (row) => html`<${RateText} rate=${row.advanced} />` },
        { key: "interviewed", label: "Interviewed", render: (row) => html`<${RateText} rate=${row.interviewed} />` },
        { key: "offered", label: "Offer", render: (row) => html`<${RateText} rate=${row.offered} />` },
        { key: "rejected", label: "Rejected", render: (row) => html`<${RateText} rate=${row.rejected} />` },
        { key: "flight", label: "Waiting", numeric: true, render: (row) => num(row.inFlight) },
      ]}
      rows=${rows}
      rowKey=${(row) => row.key}
      empty=${html`<${Empty} title="No submitted applications in this view" />`}
    />
  </div>`;
}

function Timing({ responseTimes, velocity }) {
  const kinds = [responseTimes.firstReply, ...responseTimes.byKind];
  const most = Math.max(1, ...velocity.weeks.map((week) => week.submitted));
  return html`<div class="split split--even">
    <div class="stack">
      <h3>Time to reply</h3>
      <${DataTable}
        caption="Days from submission to reply"
        columns=${[
          { key: "kind", label: "Reply", render: (row) => label(row.kind) },
          { key: "n", label: "Cases", numeric: true, render: (row) => html`<span class=${row.n < SMALL_SAMPLE ? "rate--small" : undefined}>${num(row.n)}</span>` },
          { key: "median", label: "Median", numeric: true, render: (row) => days(row.median) },
          { key: "p75", label: "75% within", numeric: true, render: (row) => days(row.p75) },
        ]}
        rows=${kinds}
        rowKey=${(row) => row.kind}
        empty=${html`<${Empty} title="No replies yet" />`}
      />
    </div>
    <div class="stack">
      <h3>Pace</h3>
      <p>${num(velocity.submittedLast7Days)} submitted in the last 7 days, ${num(velocity.submittedLast30Days)} in 30; ${num(Math.round(velocity.averageSubmittedPerWeek.value * 10) / 10)} a week over ${num(velocity.averageSubmittedPerWeek.weeks)} weeks.</p>
      <${DataTable}
        caption="Submissions and first replies by week"
        columns=${[
          { key: "week", label: "Week", render: (row) => html`<span class="nowrap">${row.week}</span>` },
          {
            key: "submitted",
            label: "Submitted",
            render: (row) => html`<span class="bar-cell"><span class="bar" aria-hidden="true"><span style=${{ "--p": row.submitted / most }}></span></span>${num(row.submitted)}</span>`,
          },
          { key: "replies", label: "First replies", numeric: true, render: (row) => num(row.firstReplies) },
        ]}
        rows=${[...velocity.weeks].reverse().slice(0, 12)}
        rowKey=${(row) => row.week}
        empty=${html`<${Empty} title="Nothing submitted yet" />`}
      />
    </div>
  </div>`;
}

function Rejections({ patterns }) {
  const groupLabel = useGroupLabel();
  return html`<div class="split split--even">
    <div class="stack">
      <h3>Where rejections come</h3>
      <${DataTable}
        caption="Rejections by stage"
        columns=${[
          { key: "stage", label: "After", render: (row) => label(row.stage) },
          { key: "count", label: "Count", numeric: true, render: (row) => num(row.count) },
          { key: "share", label: "Share", render: (row) => html`<${RateText} rate=${row.share} />` },
        ]}
        rows=${patterns.byStage}
        rowKey=${(row) => row.stage}
        empty=${html`<${Empty} title="No rejections recorded" />`}
      />
    </div>
    <div class="stack">
      <h3>Highest rejection rates</h3>
      <${DataTable}
        caption="Groups with the highest rejection rates"
        columns=${[
          { key: "group", label: "Group", render: (row) => html`<span class="cell-main">${groupLabel(row.dimension, row.key)}</span><span class="cell-sub">${label(row.dimension)}</span>` },
          { key: "rate", label: "Rejected", render: (row) => html`<${RateText} rate=${row.rejected} />` },
        ]}
        rows=${patterns.highestRejectionRates}
        rowKey=${(row) => `${row.dimension}:${row.key}`}
        empty=${html`<${Empty} title="Not enough outcomes to compare" />`}
      />
    </div>
  </div>`;
}

function Calibration({ calibration }) {
  const { rankCorrelation: rho } = calibration;
  const reason = calibration.reason && !calibration.reading.includes(calibration.reason) ? calibration.reason : null;
  return html`<div class="stack">
    <p class="prose">${calibration.reading}</p>
    ${calibration.insufficientData && reason ? html`<p class="notice">${reason}</p>` : null}
    <${DataTable}
      caption="Outcomes by score band"
      columns=${[
        { key: "band", label: "Score band", render: (row) => html`<span class="cell-main">${row.band}</span>` },
        { key: "n", label: "Resolved", numeric: true, render: (row) => num(row.n) },
        { key: "replied", label: "Replied", render: (row) => html`<${RateText} rate=${row.replied} />` },
        { key: "advanced", label: "Advanced", render: (row) => html`<${RateText} rate=${row.advanced} />` },
      ]}
      rows=${calibration.bands}
      rowKey=${(row) => row.band}
      empty=${html`<${Empty} title="No scored applications resolved yet" />`}
    />
    <p class="small muted">
      Rank correlation (Spearman) between score and outcome: ${rho.rho === null ? "not computed" : html`<strong>${Math.round(rho.rho * 100) / 100}</strong>`} over ${num(rho.n)} applications${rho.n < SMALL_SAMPLE ? ", a small sample" : ""}.${" "}
      ${num(calibration.sample.inFlight)} still waiting are left out.
    </p>
  </div>`;
}

function SkillGaps({ skillGaps }) {
  return html`<div class="stack">
    <p class="small muted">${num(skillGaps.postingsAnalyzed)} target postings read${skillGaps.window ? ` (${skillGaps.window.from.slice(0, 10)} to ${skillGaps.window.to.slice(0, 10)})` : ""}; "recent" is the last ${num(skillGaps.recentWindowDays)} days.</p>
    <${DataTable}
      caption="Skills postings ask for that your profile does not show"
      columns=${[
        { key: "term", label: "Asked for", render: (row) => html`<span class="cell-main">${row.term}</span><span class="cell-sub">${label(row.category)}</span>` },
        { key: "postings", label: "Of postings", render: (row) => html`<${RateText} rate=${row.postings} />` },
        { key: "recent", label: "Recently", render: (row) => html`<${RateText} rate=${row.recent} />` },
        { key: "trend", label: "Trend", render: (row) => html`<${Plate} text=${label(row.trend)} tone=${row.trend === "rising" ? "warn" : "muted"} />` },
      ]}
      rows=${skillGaps.gaps}
      rowKey=${(row) => row.term}
      empty=${html`<${Empty} title="No gaps found">Your profile covers the skills your target postings ask for most.</${Empty}>`}
    />
    ${skillGaps.strengths.length
      ? html`<p class="small">Strengths postings ask for: ${skillGaps.strengths.slice(0, 12).map((entry, index) => html`${index ? ", " : ""}<strong>${entry.term}</strong> (${Math.round((entry.postings.rate ?? 0) * 100)}%)`)}</p>`
      : null}
  </div>`;
}

function Discards({ discards }) {
  const { totals } = discards;
  return html`<div class="stack">
    <p>${num(totals.evaluated)} postings evaluated: ${num(totals.accepted)} accepted, ${num(totals.review)} for review, ${num(totals.rejected)} rejected by a gate.</p>
    <${DataTable}
      caption="Postings rejected by each gate rule"
      columns=${[
        { key: "rule", label: "Gate rule", render: (row) => html`<span class="cell-main">${label(row.rule)}</span>${row.examples.length ? html`<span class="cell-sub">e.g. ${row.examples.slice(0, 2).join("; ")}</span>` : null}` },
        { key: "count", label: "Postings", numeric: true, render: (row) => num(row.count) },
        { key: "share", label: "Of rejections", render: (row) => html`<${RateText} rate=${row.share} />` },
      ]}
      rows=${discards.byRule}
      rowKey=${(row) => row.rule}
      empty=${html`<${Empty} title="No postings rejected yet" />`}
    />
  </div>`;
}

function Exports() {
  const files = useResource(() => api.get("/api/exports"), []);
  const [busy, run] = useAction(toast);
  const exportAs = async (format) => {
    const result = await run(() => api.post("/api/exports", { format }));
    if (result) {
      toast(`Exported ${num(result.rows)} applications.`, { href: result.href, linkText: "Download" });
      files.reload({ quiet: true });
    }
  };
  return html`<div class="panel panel--pad stack">
    <p class="small muted">Every application with its status, latest outcome and link, for a spreadsheet or your notes. Files are written to the exports folder.</p>
    <div class="row">
      <${Button} busy=${busy} onClick=${() => exportAs("csv")}><${Icon} name="download" /> Export CSV</${Button}>
      <${Button} busy=${busy} onClick=${() => exportAs("markdown")}><${Icon} name="download" /> Export Markdown</${Button}>
    </div>
    ${files.data?.files?.length
      ? html`<ul class="plain-list small">
          ${files.data.files.slice(0, 6).map(
            (file) => html`<li key=${file.name}><a href=${`/api/exports/${encodeURIComponent(file.name)}`} download>${file.name}</a> <span class="muted">${bytes(file.sizeBytes)} · ${ago(file.modifiedAt)}</span></li>`,
          )}
        </ul>`
      : null}
  </div>`;
}

export default function Analytics({ query }) {
  useTitle("Analytics");
  const since = query.get("since") ?? "";
  const [draft, setDraft] = useState(since);
  const analytics = useResource(() => api.get("/api/analytics", { since }), [since]);
  const data = analytics.data;
  return html`<div>
    <${PageHead}
      title="Analytics"
      sub="Every rate shows the count behind it. Rates on fewer than ten cases are marked as small samples: read them with care."
    />
    <form class="filters" onSubmit=${(event) => { event.preventDefault(); setQuery({ since: draft }); }} aria-label="Period">
      <div class="field">
        <label class="field__label" for="analytics-since">Count activity from</label>
        <input id="analytics-since" class="input" type="date" value=${draft} onInput=${(event) => setDraft(event.currentTarget.value)} />
      </div>
      <${Button} type="submit" small>Apply</${Button}>
      ${since ? html`<${Button} small kind="ghost" onClick=${() => { setDraft(""); setQuery({ since: undefined }); }}>Whole campaign</${Button}>` : null}
    </form>
    ${analytics.error ? html`<${ErrorNotice} error=${analytics.error} onRetry=${analytics.reload} />` : null}
    ${analytics.loading && !data ? html`<div class="panel panel--pad"><${Skeleton} lines=${8} /></div>` : null}
    ${data
      ? html`
          ${data.notes.length ? html`<div class="notice" style=${{ marginBottom: "1rem" }}>${data.notes.map((note) => html`<p>${note}</p>`)}</div>` : null}
          <div class="analytics">
            <${Section} id="funnel-title" title="Funnel" note=${since ? `Since ${since}` : "Whole campaign"}><${Funnel} funnel=${data.funnel} /></${Section}>
            <${Section} id="export-title" title="Tracker export"><${Exports} /></${Section}>
            <${Section} id="conversion-title" title="What converts" wide><${Conversion} conversion=${data.conversion} /></${Section}>
            <${Section} id="timing-title" title="Timing" wide><${Timing} responseTimes=${data.responseTimes} velocity=${data.velocity} /></${Section}>
            <${Section} id="rejections-title" title="Rejections" note=${`${num(data.rejectionPatterns.total)} recorded`} wide><${Rejections} patterns=${data.rejectionPatterns} /></${Section}>
            <${Section} id="calibration-title" title="Is the score right?"><${Calibration} calibration=${data.calibration} /></${Section}>
            <${Section} id="gaps-title" title="Skill gaps"><${SkillGaps} skillGaps=${data.skillGaps} /></${Section}>
            <${Section} id="discards-title" title="What the gates discard" wide><${Discards} discards=${data.discards} /></${Section}>
          </div>
        `
      : null}
  </div>`;
}
