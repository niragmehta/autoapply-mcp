import { api } from "../api.js";
import { EditorDrawer } from "../components/confirm.js";
import { DataTable } from "../components/table.js";
import { Empty, ErrorNotice, PageHead, Plate, Segmented } from "../components/ui.js";
import { inDays, when } from "../lib/format.js";
import { html, useState } from "../lib/html.js";
import { useResource, useTitle } from "../lib/hooks.js";
import { setQuery } from "../lib/router.js";
import { useStatus } from "../lib/store.js";
import { IcsLink, InterviewDetail } from "./interview-detail.js";
import { ScheduleForm, stageLabel } from "./interview-forms.js";

/** Interviews: the schedule, booking one from an application, and each one's prep sheet and debriefs. */

function ScheduleDrawer({ applicationId, onClose, onSaved }) {
  const [dirty, setDirty] = useState(false);
  return html`<${EditorDrawer} wide dirty=${dirty} title="Schedule an interview" sub="From one of your applications" onClose=${onClose}>
    <section class="drawer__section"><${ScheduleForm} applicationId=${applicationId} onDirty=${setDirty} onSaved=${onSaved} onCancel=${onClose} /></section>
  </${EditorDrawer}>`;
}

export default function Interviews({ query }) {
  useTitle("Interviews");
  const scope = query.get("scope") === "all" ? "all" : "upcoming";
  const openInterview = query.get("interview");
  const schedule = query.get("schedule");
  const interviews = useResource(() => api.get("/api/interviews", { scope, limit: 200 }), [scope]);
  const status = useStatus();
  const next = status.data?.afterApply?.nextInterview;
  const refresh = () => {
    interviews.reload({ quiet: true });
    status.reload({ quiet: true });
  };
  const columns = [
    {
      key: "when",
      label: "When",
      render: (row) =>
        row.scheduledAt
          ? html`<span class="nowrap">${when(row.scheduledAt)}</span><span class="cell-sub">${inDays(row.daysUntil)}</span>`
          : html`<span class="muted">Not booked</span>`,
    },
    { key: "role", label: "Application", render: (row) => html`<span class="cell-main">${row.company}</span><span class="cell-sub">${row.title}</span>` },
    { key: "stage", label: "Stage", render: (row) => html`<span class="small">${stageLabel(row.stage)}</span>` },
    { key: "with", label: "With", render: (row) => html`<span class="small">${row.interviewers.map((person) => person.name).join(", ") || "-"}</span>` },
    { key: "status", label: "Status", render: (row) => html`<${Plate} value=${row.status} />` },
    {
      key: "prep",
      label: "Prep",
      render: (row) => html`<span class="stack" style=${{ gap: "0.25rem" }}>
        <a class="nowrap" href=${`/prep?interview=${encodeURIComponent(row.id)}`}>Prep sheet</a>
        <${IcsLink} interview=${row} />
      </span>`,
    },
  ];
  return html`<div>
    <${PageHead}
      title="Interviews"
      sub=${next ? html`Next: <strong>${next.company}</strong>, ${when(next.scheduledAt)} (${inDays(next.daysUntil)})` : "Your interview schedule, each with a prep sheet and room for a debrief."}
      actions=${html`<a class="btn btn--primary" href="/interviews?schedule=1">Schedule interview</a>`}
    />
    <div class="stack">
      <div class="row">
        <${Segmented}
          legend="Interviews to show"
          hideLegend
          value=${scope}
          onChange=${(value) => setQuery({ scope: value === "all" ? "all" : undefined })}
          options=${[{ value: "upcoming", label: "Upcoming" }, { value: "all", label: "All" }]}
        />
      </div>
      ${interviews.error ? html`<${ErrorNotice} error=${interviews.error} onRetry=${interviews.reload} />` : null}
      <${DataTable}
        caption="Interviews"
        columns=${columns}
        rows=${interviews.data?.interviews}
        rowKey=${(row) => row.id}
        loading=${interviews.loading}
        selectedKey=${openInterview}
        onOpen=${(row) => setQuery({ interview: row.id }, { replace: false })}
        empty=${html`<${Empty} title=${scope === "upcoming" ? "No interviews coming up" : "No interviews recorded"} action=${html`<a class="btn" href="/interviews?schedule=1">Schedule one</a>`}>
          When an employer books a call, schedule it here from its application: it records the step and gives you a calendar file and a prep sheet.
        </${Empty}>`}
      />
    </div>
    ${openInterview ? html`<${InterviewDetail} key=${openInterview} interviewId=${openInterview} onClose=${() => setQuery({ interview: undefined })} onChanged=${refresh} />` : null}
    ${schedule
      ? html`<${ScheduleDrawer}
          applicationId=${schedule === "1" ? "" : schedule}
          onClose=${() => setQuery({ schedule: undefined })}
          onSaved=${(saved) => {
            refresh();
            setQuery({ schedule: undefined, interview: saved.id, scope: undefined });
          }}
        />`
      : null}
  </div>`;
}
