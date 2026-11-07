import { html } from "../lib/html.js";
import { dateTime, inDays, label, num, plural, when } from "../lib/format.js";
import { useTitle } from "../lib/hooks.js";
import { useStatus } from "../lib/store.js";
import { RouteLine } from "../components/routeline.js";
import { RunBoard } from "../components/runboard.js";
import { Empty, ErrorNotice, Icon, Meter, PageHead, Plate, Skeleton } from "../components/ui.js";

/** Where the campaign stands and what is waiting on the person. */

/** Response kinds read as counted nouns: "2 interviews", "1 offer", "3 rejected". */
function responseText(status, count) {
  const words = label(status).toLowerCase();
  const countable = status !== "rejected" && status !== "ghosted" && status !== "withdrawn";
  return `${num(count)} ${countable && count !== 1 ? `${words}s` : words}`;
}

function stationsFrom(data) {
  const { jobs, applications, today, outcomes, afterApply } = data;
  const tiers = jobs.acceptedByTier;
  const responseKinds = outcomes.taxonomy?.responses ?? [];
  const responses = responseKinds.filter((status) => outcomes.byStatus[status]).map((status) => responseText(status, outcomes.byStatus[status]));
  const replies = afterApply?.repliesToReview ?? 0;
  return [
    {
      id: "discovered",
      label: "Discovered",
      count: jobs.discovered,
      href: "/jobs",
      notes: jobs.discoveredToday ? [`${num(jobs.discoveredToday)} new today`] : [],
    },
    {
      id: "accepted",
      label: "Accepted",
      count: jobs.byDecision.accept ?? 0,
      href: "/jobs?decision=accept",
      notes: [
        `A ${num(tiers.A)} · B ${num(tiers.B)} · C ${num(tiers.C)}`,
        ...(jobs.queueDepth ? [{ text: `${num(jobs.queueDepth)} not prepared`, tone: "info", href: "/jobs?decision=accept&hasApplication=no" }] : []),
      ],
    },
    {
      id: "prepared",
      label: "Prepared",
      count: applications.total,
      href: "/applications",
      held: applications.needsHuman > 0,
      notes: [
        ...(applications.needsHuman ? [{ text: `${num(applications.needsHuman)} need you`, tone: "held", href: "/needs-human" }] : []),
        ...(applications.ready ? [{ text: `${num(applications.ready)} ready`, tone: "info", href: "/applications?status=awaiting_approval,approved" }] : []),
      ],
    },
    {
      id: "submitted",
      label: "Submitted",
      count: applications.submitted,
      href: "/applications?status=submitted",
      notes: [`${num(today.submitted)} today${today.dailyLimit ? ` of ${num(today.dailyLimit)}` : ""}`],
    },
    {
      id: "responded",
      label: "Responded",
      count: outcomes.responded,
      href: "/analytics",
      held: replies > 0,
      notes: [
        ...(replies ? [{ text: `${num(replies)} ${replies === 1 ? "reply" : "replies"} to review`, tone: "held", href: "/inbox" }] : []),
        ...(responses.length ? [responses.join(" · ")] : []),
      ],
    },
  ];
}

function NextActions({ actions }) {
  if (actions.length === 0) {
    return html`<div class="panel">
      <${Empty} title="Nothing is waiting on you">
        Held questions, packets to approve, replies to confirm, follow-ups due and failed runs appear here as they come up.
      </${Empty}>
    </div>`;
  }
  return html`<ul class="rows">
    ${actions.map(
      (action) => html`<li key=${action.id}>
        <a class="action-row" href=${action.href}>
          <span class=${`action-row__count${action.tone === "attention" ? " action-row__count--held" : ""}`}>${num(action.count)}</span>
          <span>
            <span class="action-row__label">${action.label}</span>
            <span class="action-row__detail">${action.detail}</span>
          </span>
          <${Icon} name="chevron" />
        </a>
      </li>`,
    )}
  </ul>`;
}

function Today({ today }) {
  const limit = today.dailyLimit;
  const text = limit ? `${num(today.submitted)} of ${num(limit)} sent today` : `${num(today.submitted)} sent today (no daily limit)`;
  return html`<div class="panel panel--pad stack">
    <h3>Today</h3>
    <p><strong>${text}</strong></p>
    ${limit ? html`<${Meter} value=${today.submitted} max=${limit} text=${text} />` : null}
    <p class="small muted">${limit && today.submitted >= limit ? "The daily limit is reached; submit runs stop until tomorrow." : "Submission runs stop on their own at the daily limit."}</p>
  </div>`;
}

/** After applying, as a timetable: one row per stage, each a link to its page. Zero is said plainly. */
function AfterApplying({ after }) {
  if (!after) return null;
  const next = after.nextInterview;
  const rows = [
    {
      id: "inbox",
      label: "Replies",
      href: "/inbox",
      value: after.repliesToReview ? html`<strong>${plural(after.repliesToReview, "reply", "replies")}</strong> to review` : "Nothing waiting for review",
      held: after.repliesToReview > 0,
    },
    {
      id: "follow-ups",
      label: "Follow-ups",
      href: "/follow-ups",
      value: after.followUpsDue ? html`<strong>${num(after.followUpsDue)}</strong> due, drafts ready to copy` : "None due",
    },
    {
      id: "interviews",
      label: "Next interview",
      href: "/interviews",
      value: next
        ? html`<strong>${next.company}</strong> · ${next.title} <span class="muted">${when(next.scheduledAt)} (${inDays(next.daysUntil)})</span>`
        : "None scheduled",
    },
    {
      id: "offers",
      label: "Offers",
      href: "/offers",
      value: after.activeOffers
        ? html`<strong>${num(after.activeOffers)}</strong> in play${after.offersDueThisWeek ? html`, <strong>${num(after.offersDueThisWeek)}</strong> to decide this week` : ""}`
        : "None in play",
      held: after.offersDueThisWeek > 0,
    },
    {
      id: "leads",
      label: "Sources",
      href: "/leads",
      value:
        after.newLeads || after.pendingProposals
          ? html`<strong>${num(after.newLeads)}</strong> new leads · <strong>${num(after.pendingProposals)}</strong> board proposals`
          : "No new leads",
    },
  ];
  return html`<ul class="rows">
    ${rows.map(
      (row) => html`<li key=${row.id}>
        <a class="info-row" href=${row.href}>
          <span class="info-row__label">${row.held ? html`<span class="info-row__held" aria-hidden="true"></span>` : null}${row.label}</span>
          <span class="info-row__value">${row.value}</span>
          <${Icon} name="chevron" />
        </a>
      </li>`,
    )}
  </ul>`;
}

function Round({ round }) {
  if (!round) {
    return html`<div class="panel panel--pad stack">
      <h3>This round</h3>
      <p class="muted">No round cap is set. Set <code>campaign.runner.roundCap</code> to limit submissions per company for a stretch of the campaign.</p>
    </div>`;
  }
  if (round.error) {
    return html`<div class="panel panel--pad stack"><h3>This round</h3><p class="notice notice--bad">${round.error}</p></div>`;
  }
  const top = round.companies.slice(0, 6);
  const atCap = round.companies.filter((company) => company.atCap).length;
  return html`<div class="panel panel--pad stack">
    <h3>This round</h3>
    <p><strong>${plural(round.submitted, "submission")}</strong> since ${dateTime(round.sinceIso)}, at most ${round.max} per company${atCap ? `; ${plural(atCap, "company", "companies")} at the cap` : ""}.</p>
    ${top.length
      ? html`<table class="table">
          <caption class="sr-only">Submissions per company this round</caption>
          <thead><tr><th scope="col">Company</th><th scope="col" class="num">Sent</th><th scope="col"><span class="sr-only">Cap</span></th></tr></thead>
          <tbody>
            ${top.map(
              (company) => html`<tr key=${company.company}>
                <td>${company.company}</td>
                <td class="num">${company.submitted} / ${round.max}</td>
                <td>${company.atCap ? html`<${Plate} text="At cap" tone="warn" />` : null}</td>
              </tr>`,
            )}
          </tbody>
        </table>`
      : html`<p class="muted small">Nothing submitted this round yet.</p>`}
  </div>`;
}

export default function Overview() {
  useTitle("Overview");
  const { data, error, loading, reload } = useStatus();

  if (!data) {
    return html`<div>
      <${PageHead} title="Overview" />
      ${loading ? html`<div class="panel panel--pad"><${Skeleton} lines=${4} /></div>` : html`<${ErrorNotice} error=${error} onRetry=${reload} />`}
    </div>`;
  }

  const runs = [...data.runs.active, ...data.runs.recent.filter((run) => !data.runs.active.some((active) => active.id === run.id))].slice(0, 8);
  return html`<div>
    <${PageHead}
      title="Overview"
      sub=${`${data.campaign.name} · ${label(data.campaign.submissionMode)} submission · ${plural(data.companies.active, "active board")}`}
      actions=${html`<a class="btn btn--primary" href="/runs"><${Icon} name="play" /> Start a run</a>`}
    />
    ${error ? html`<${ErrorNotice} error=${error} onRetry=${reload} />` : null}
    <${RouteLine} stations=${stationsFrom(data)} />
    <div class="split section">
      <section aria-labelledby="needs-you-title">
        <div class="section__head">
          <h2 id="needs-you-title">Needs you</h2>
          <p class="section__note">Most urgent first</p>
        </div>
        <${NextActions} actions=${data.nextActions} />
      </section>
      <section aria-labelledby="runs-title">
        <div class="section__head">
          <h2 id="runs-title">Runs</h2>
          <a href="/runs">All runs</a>
        </div>
        <${RunBoard}
          runs=${runs}
          caption="Recent runs"
          compact
          empty=${html`<${Empty} title="No runs yet">Start a discovery run to fetch postings from your boards.</${Empty}>`}
        />
      </section>
    </div>
    <section class="section" aria-labelledby="after-title">
      <div class="section__head">
        <h2 id="after-title">After applying</h2>
        <p class="section__note">Replies, follow-ups, interviews, offers and new sources</p>
      </div>
      <${AfterApplying} after=${data.afterApply} />
    </section>
    <section class="section" aria-labelledby="today-title">
      <div class="section__head"><h2 id="today-title">Today and this round</h2></div>
      <div class="split split--top">
        <${Today} today=${data.today} />
        <${Round} round=${data.round} />
      </div>
    </section>
  </div>`;
}
