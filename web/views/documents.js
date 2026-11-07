import { api } from "../api.js";
import { Drawer } from "../components/drawer.js";
import { DataTable } from "../components/table.js";
import { Button, Empty, ErrorNotice, Icon, PageHead, Plate, Segmented, Skeleton } from "../components/ui.js";
import { ago, dateTime, label, num } from "../lib/format.js";
import { html, useState } from "../lib/html.js";
import { useAction, useResource, useTitle } from "../lib/hooks.js";
import { setQuery } from "../lib/router.js";
import { toast, useStatus } from "../lib/store.js";

/** The resume each application uploads and its cover letter, the rendered files, and rendering on request. */

const SCOPES = {
  open: ["drafted", "needs_human", "awaiting_approval", "approved"],
  submitted: ["submitted"],
  all: [],
};

function renderMessage(result) {
  const warnings = result.warnings?.length ? ` ${result.warnings.length} warning(s): ${result.warnings.join("; ")}` : "";
  return `Rendered ${result.pages} page${result.pages === 1 ? "" : "s"}.${warnings}`;
}

function Variants({ overview, onRendered }) {
  const [busy, run] = useAction(toast);
  const [result, setResult] = useState(null);
  const render = async (id) => {
    const rendered = await run(() => api.post(`/api/documents/variants/${encodeURIComponent(id)}/render`, {}), { success: renderMessage });
    if (rendered) {
      setResult(rendered);
      onRendered();
    }
  };
  return html`<div class="panel panel--pad stack">
    ${overview.resumeSource.present
      ? html`<p class="small muted">Rendered from <span class="mono">${overview.resumeSource.path}</span>. A track variant is your curated selection; nothing is dropped to fit.</p>`
      : html`<div class="notice notice--held">
          <p class="notice__title">No resume source yet</p>
          <p>Tailoring and rendering read <span class="mono">${overview.resumeSource.path}</span>. Copy <code>examples/resume.example.json</code> there and fill it in (see docs/DOCUMENTS.md). Until then each application uploads its track's file as it is.</p>
        </div>`}
    <table class="table">
      <caption class="sr-only">Resume variants</caption>
      <thead><tr><th scope="col">Variant</th><th scope="col">File</th><th scope="col"><span class="sr-only">Render</span></th></tr></thead>
      <tbody>
        ${overview.variants.map(
          (variant) => html`<tr key=${variant.id}>
            <td><span class="cell-main">${variant.label}</span><span class="cell-sub mono">${variant.id}</span></td>
            <td><span class="mono small">${variant.fileName}</span> ${variant.exists ? null : html`<${Plate} text="Missing" tone="bad" />`}</td>
            <td class="num"><${Button} small busy=${busy} disabled=${!overview.resumeSource.present} onClick=${() => render(variant.id)}>Render</${Button}></td>
          </tr>`,
        )}
      </tbody>
    </table>
    ${result ? html`<p class="notice notice--ok small">${result.nextStep}</p>` : null}
  </div>`;
}

function Tailor({ applicationId, status, onTailored }) {
  const [headline, setHeadline] = useState("");
  const [busy, run] = useAction(toast);
  const appStatus = useStatus();
  if (status === "submitted") return null;
  const tailor = async (event) => {
    event.preventDefault();
    const result = await run(() => api.post(`/api/documents/${encodeURIComponent(applicationId)}/tailor`, headline.trim() ? { headline: headline.trim() } : {}), {
      success: (tailored) => `Tailored: ${tailored.pages} page(s), ${tailored.changes.length} change(s).${tailored.approvalVoided ? " The approval was voided; approve the packet again." : ""}`,
    });
    if (result) {
      appStatus.reload({ quiet: true });
      onTailored();
    }
  };
  return html`<section class="drawer__section">
    <h3>Tailor the resume</h3>
    <form class="stack" onSubmit=${tailor}>
      <p class="small muted">Renders a resume for this posting from your resume source, checks it, and makes it the file this application uploads. The packet changes, so any approval is void and you approve again.</p>
      <div class="field">
        <label class="field__label" for="tailor-headline">Headline (optional)</label>
        <input id="tailor-headline" class="input" maxlength="200" value=${headline} onInput=${(event) => setHeadline(event.currentTarget.value)} placeholder="Kept from the variant when empty" />
      </div>
      <div><${Button} type="submit" busy=${busy}>${busy ? "Rendering..." : "Tailor resume"}</${Button}></div>
    </form>
  </section>`;
}

function DocumentDetail({ applicationId, role, onClose, onChanged }) {
  const { data, error, loading, reload } = useResource(() => api.get(`/api/documents/${encodeURIComponent(applicationId)}`), [applicationId]);
  const changed = () => {
    reload({ quiet: true });
    onChanged();
  };
  return html`<${Drawer}
    title=${role ? `${role.company}: ${role.title}` : "Documents"}
    sub=${html`<span class="mono">${applicationId}</span>`}
    onClose=${onClose}
  >
    ${error ? html`<${ErrorNotice} error=${error} onRetry=${reload} />` : null}
    ${loading && !data ? html`<${Skeleton} lines=${6} />` : null}
    ${data
      ? html`
          <section class="drawer__section">
            <p class="notice">${data.nextStep}</p>
            <dl class="facts" style=${{ marginTop: "0.75rem" }}>
              <dt>Application</dt><dd class="row"><${Plate} value=${data.status} /><a href=${`/applications?app=${encodeURIComponent(data.applicationId)}`}>Open it</a></dd>
              <dt>Resume</dt>
              <dd>
                <span class="mono small">${data.resume.fileName || "-"}</span>
                ${data.resume.tailored ? html` <${Plate} text="Tailored" tone="ok" />` : html` <${Plate} text="Track variant" tone="muted" />`}
                ${data.resume.exists ? null : html` <${Plate} text="File missing" tone="bad" />`}
                ${data.resume.latest?.href ? html`<span class="cell-sub"><a href=${data.resume.latest.href} target="_blank" rel="noopener noreferrer">Open the tailored PDF</a></span>` : null}
              </dd>
              <dt>Cover letter</dt>
              <dd>
                ${data.coverLetter.present ? `${num(data.coverLetter.words)} words` : html`<span class="muted">None</span>`}
                ${data.coverLetter.pdf
                  ? html`<span class="cell-sub">${data.coverLetter.pdf.matchesText ? "PDF matches the text" : "PDF is older than the text"}${data.coverLetter.pdf.href ? html` · <a href=${data.coverLetter.pdf.href} target="_blank" rel="noopener noreferrer">Open</a>` : ""}</span>`
                  : null}
              </dd>
            </dl>
          </section>
          <${Tailor} applicationId=${data.applicationId} status=${data.status} onTailored=${changed} />
          <section class="drawer__section">
            <h3>Files</h3>
            ${data.history.length
              ? html`<ul class="plain-list">
                  ${data.history.map(
                    (entry) => html`<li key=${entry.id}>
                      ${entry.href ? html`<a href=${entry.href} target="_blank" rel="noopener noreferrer">${entry.fileName}</a>` : html`<span class="mono">${entry.fileName}</span>`}
                      <span class="small muted"> ${label(entry.kind)} · ${dateTime(entry.createdAt)}${entry.pages ? ` · ${entry.pages} page${entry.pages === 1 ? "" : "s"}` : ""}${entry.changes ? ` · ${entry.changes} change${entry.changes === 1 ? "" : "s"}` : ""}</span>
                      ${entry.exists ? null : html` <${Plate} text="File missing" tone="bad" />`}
                      ${entry.exists && !entry.href ? html`<span class="cell-sub">Stored outside the documents folder, so it is not served here.</span>` : null}
                    </li>`,
                  )}
                </ul>`
              : html`<${Empty} title="No rendered files yet" />`}
          </section>
        `
      : null}
  </${Drawer}>`;
}

export default function Documents({ query }) {
  useTitle("Documents");
  const scope = Object.hasOwn(SCOPES, query.get("scope") ?? "") ? query.get("scope") : "open";
  const openApp = query.get("app");
  const overview = useResource(() => api.get("/api/documents", { status: SCOPES[scope], limit: 200 }), [scope]);
  const data = overview.data;
  const columns = [
    { key: "role", label: "Application", render: (row) => html`<span class="cell-main">${row.company}</span><span class="cell-sub">${row.title}</span>` },
    { key: "status", label: "Status", render: (row) => html`<${Plate} value=${row.status} />` },
    {
      key: "resume",
      label: "Resume",
      render: (row) => html`<span class="mono small">${row.resumeFile || "-"}</span>
        <span class="cell-sub">${row.tailored ? `Tailored ${ago(row.tailoredAt)}` : `Track variant ${row.resumeId}`}${row.resumeExists ? "" : " · file missing"}</span>`,
    },
    {
      key: "letter",
      label: "Cover letter",
      render: (row) => (row.coverLetterWords ? html`<span class="small">${num(row.coverLetterWords)} words${row.coverLetterPdfAt ? " · PDF" : ""}</span>` : html`<span class="muted small">None</span>`),
    },
    { key: "files", label: "Files", numeric: true, render: (row) => num(row.documents) },
  ];
  return html`<div>
    <${PageHead}
      title="Documents"
      sub="The resume each application uploads and its cover letter. Rendering happens only when you click."
      actions=${html`<${Segmented}
        legend="Applications to show"
        hideLegend
        value=${scope}
        onChange=${(value) => setQuery({ scope: value === "open" ? undefined : value })}
        options=${[{ value: "open", label: "Not sent" }, { value: "submitted", label: "Submitted" }, { value: "all", label: "All" }]}
      />`}
    />
    ${overview.error ? html`<${ErrorNotice} error=${overview.error} onRetry=${overview.reload} />` : null}
    ${data
      ? html`<section aria-labelledby="variants-title">
          <div class="section__head"><h2 id="variants-title">Resume variants</h2><p class="section__note">One per track, from profile.resumes</p></div>
          <${Variants} overview=${data} onRendered=${() => overview.reload({ quiet: true })} />
        </section>`
      : null}
    <section class="section" aria-labelledby="docs-title">
      <div class="section__head"><h2 id="docs-title">Applications</h2><p class="section__note">${data ? `${num(data.count)} shown` : ""}</p></div>
      <${DataTable}
        caption="Documents per application"
        columns=${columns}
        rows=${data?.rows}
        rowKey=${(row) => row.applicationId}
        loading=${overview.loading}
        selectedKey=${openApp}
        onOpen=${(row) => setQuery({ app: row.applicationId }, { replace: false })}
        empty=${html`<${Empty} title="No applications here" action=${html`<a class="btn" href="/jobs?decision=accept&hasApplication=no"><${Icon} name="play" /> Prepare one from Jobs</a>`} />`}
      />
    </section>
    ${openApp
      ? html`<${DocumentDetail}
          key=${openApp}
          applicationId=${openApp}
          role=${data?.rows.find((row) => row.applicationId === openApp) ?? null}
          onClose=${() => setQuery({ app: undefined })}
          onChanged=${() => overview.reload({ quiet: true })}
        />`
      : null}
  </div>`;
}
