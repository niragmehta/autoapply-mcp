import { api } from "../api.js";
import { Button, ErrorNotice, Icon, PageHead, Plate, Skeleton } from "../components/ui.js";
import { bytes, dateTime, label, num } from "../lib/format.js";
import { html } from "../lib/html.js";
import { useResource, useTitle } from "../lib/hooks.js";

/** Whether this workspace can run: checks, runtime, paths and a read-only view of the configuration. */

function Checks({ checks }) {
  return html`<ul class="rows">
    ${checks.map(
      (check) => html`<li key=${check.id} class="action-row check-row">
        <${Plate} text=${check.ok ? "Pass" : check.level === "warn" ? "Optional" : "Fail"} tone=${check.ok ? "ok" : check.level === "warn" ? "warn" : "bad"} />
        <span>
          <span class="action-row__label">${check.label}</span>
          <span class="action-row__detail">${check.detail}</span>
        </span>
      </li>`,
    )}
  </ul>`;
}

function Facts({ entries }) {
  return html`<dl class="facts">
    ${entries.map(([term, value]) => html`<dt>${term}</dt><dd>${value}</dd>`)}
  </dl>`;
}

function Config({ config }) {
  const campaign = config.campaign;
  if (!campaign) return html`<p class="notice notice--bad">campaign.json could not be read; see the checks above.</p>`;
  const submission = campaign.submission;
  const runner = campaign.runner;
  return html`<div class="split">
    <div class="panel panel--pad stack">
      <h3>Submission</h3>
      <${Facts}
        entries=${[
          ["Mode", label(submission.mode)],
          ["Daily limit", submission.dailyLimit === null ? "None" : num(submission.dailyLimit)],
          ["Per company", `at most ${num(submission.maxPerCompany)}`],
          ["Batch size", `at most ${num(submission.maxBatchSize)}`],
          ["Min delay", `${num(submission.minDelaySeconds)} s between submissions`],
          ["Allowlist", submission.allowedCompanies.length ? submission.allowedCompanies.join(", ") : "Empty: auto submission is not limited by company"],
        ]}
      />
    </div>
    <div class="panel panel--pad stack">
      <h3>Runs</h3>
      <${Facts}
        entries=${[
          ["Pace", `${num(runner.paceSeconds)} s between applications`],
          ["Round cap", runner.roundCap ? `${runner.roundCap.max} per company since ${runner.roundCap.since}` : "None"],
          ["Auto-allowlist", runner.autoAllowlist ? "On: companies are allowlisted just before a run submits" : "Off"],
          ["Browser", runner.headed ? "Visible window" : "Headless (Ashby always visible)"],
          ["Code wait", `${num(runner.codeWaitSeconds)} s for email verification codes`],
        ]}
      />
    </div>
    <div class="panel panel--pad stack">
      <h3>Tracks</h3>
      <div class="table-wrap" style=${{ border: 0 }}>
        <table class="table">
          <caption class="sr-only">Campaign tracks</caption>
          <thead><tr><th scope="col">Track</th><th scope="col">Resume</th><th scope="col" class="num">Share</th></tr></thead>
          <tbody>
            ${campaign.tracks.map((track) => html`<tr key=${track.id}><td>${track.label} <span class="cell-sub mono">${track.id}</span></td><td class="mono small">${track.resumeId}</td><td class="num">${Math.round(track.allocation * 100)}%</td></tr>`)}
          </tbody>
        </table>
      </div>
    </div>
    <div class="panel panel--pad stack">
      <h3>Profile</h3>
      ${config.profile
        ? html`<${Facts} entries=${[["Name", config.profile.name], ["Resumes", config.profile.resumes.map((resume) => resume.id).join(", ")], ["Locations", campaign.locations.map(label).join(", ")]]} />`
        : html`<p class="notice notice--bad">profile.json could not be read.</p>`}
    </div>
  </div>`;
}

/** Profile readiness from the onboarding checks, with the next steps that name the tool fixing each gap. */
function Readiness({ profile }) {
  if (!profile) return null;
  if (profile.error) return html`<p class="notice notice--bad">Profile readiness could not be read: ${profile.error}</p>`;
  const tones = { blocker: "bad", important: "warn", suggested: "muted" };
  return html`<div class="panel panel--pad stack">
    <div class="row">
      <strong>${profile.ready ? "Ready to apply" : "Not ready yet"}</strong>
      <${Plate} text=${`${num(profile.readiness)}% of checks pass`} tone=${profile.ready ? "ok" : "warn"} />
    </div>
    ${profile.nextSteps.length
      ? html`<ul class="plain-list">
          ${profile.nextSteps.map(
            (step, index) => html`<li key=${index}>
              <${Plate} text=${label(step.severity)} tone=${tones[step.severity] ?? "muted"} />
              <span> ${step.message}</span>
              ${step.tool ? html`<span class="cell-sub">Fix with <code>${step.tool}</code></span>` : null}
            </li>`,
          )}
        </ul>`
      : html`<p class="muted">Nothing left to fill in.</p>`}
  </div>`;
}

export default function Health() {
  useTitle("Health");
  const health = useResource(() => api.get("/api/health"), []);
  const data = health.data;
  const failing = data?.checks.filter((check) => !check.ok && check.level !== "warn") ?? [];

  return html`<div>
    <${PageHead}
      title="Health"
      sub=${data ? (failing.length ? `${failing.length} required check${failing.length === 1 ? "" : "s"} failing` : "Every required check passes") : "Checking the workspace"}
      actions=${html`<${Button} busy=${health.loading} onClick=${() => health.reload()}><${Icon} name="refresh" /> Check again</${Button}>`}
    />
    ${health.error ? html`<${ErrorNotice} error=${health.error} onRetry=${health.reload} />` : null}
    ${!data && health.loading ? html`<div class="panel panel--pad"><${Skeleton} lines=${6} /></div>` : null}
    ${data
      ? html`
          <${Checks} checks=${data.checks} />
          <section class="section" aria-labelledby="readiness-title">
            <div class="section__head"><h2 id="readiness-title">Profile readiness</h2><p class="section__note">What is still a placeholder, most important first</p></div>
            <${Readiness} profile=${data.profile} />
          </section>
          <div class="split section">
            <section aria-labelledby="runtime-title" class="panel panel--pad stack">
              <h2 id="runtime-title">Runtime</h2>
              <${Facts}
                entries=${[
                  ["Version", `autoapply ${data.version} on Node ${data.node}`],
                  ["Dashboard", `${data.host.address}:${data.host.port}, pid ${data.host.pid}, up since ${dateTime(data.startedAt)}`],
                  ["Run types", data.runTypes.map((type) => type.type).join(", ")],
                  ["Verification inbox", data.imap.configured ? "Configured" : "Not configured"],
                  ["Reply reading", data.inbox ? (data.inbox.enabled ? (data.inbox.configured ? `On${data.inbox.lastScanAt ? `, last scan ${dateTime(data.inbox.lastScanAt)}` : ", not scanned yet"}` : "On, no mailbox configured") : "Off") : "-"],
                ]}
              />
            </section>
            <section aria-labelledby="secrets-title" class="panel panel--pad stack">
              <h2 id="secrets-title">Secrets</h2>
              <p class="small muted">Names only. Values never leave the dashboard process.</p>
              <${Facts}
                entries=${[
                  ["Secrets file", data.secrets.file ? data.paths.secrets : `None at ${data.paths.secrets}`],
                  ["In the file", data.secrets.inFile.length ? html`<span class="mono small">${data.secrets.inFile.join(", ")}</span>` : "None"],
                  ["In the environment", data.secrets.inEnvironment.length ? html`<span class="mono small">${data.secrets.inEnvironment.join(", ")}</span>` : "None"],
                ]}
              />
            </section>
          </div>
          <section class="section" aria-labelledby="config-title">
            <div class="section__head"><h2 id="config-title">Configuration</h2><p class="section__note">Read-only. Edit the JSON files; changes apply on the next request.</p></div>
            <${Config} config=${data.config} />
          </section>
          <div class="split section">
            <section aria-labelledby="database-title" class="panel panel--pad stack">
              <h2 id="database-title">Database</h2>
              <${Facts}
                entries=${[
                  ["File", html`<span class="mono small">${data.database.path}</span>`],
                  ["Size", bytes(data.database.sizeBytes)],
                  ...Object.entries(data.database.counts).map(([table, count]) => [label(table), count < 0 ? "missing" : num(count)]),
                ]}
              />
            </section>
            <section aria-labelledby="paths-title" class="panel panel--pad stack">
              <h2 id="paths-title">Paths</h2>
              <p class="small muted">Inside the home folder unless shown in full.</p>
              <${Facts}
                entries=${Object.entries(data.paths).map(([name, path]) => [
                  label(name),
                  html`<span class="mono small">${name !== "home" && path.startsWith(`${data.paths.home}\\`) ? path.slice(data.paths.home.length + 1) : name !== "home" && path.startsWith(`${data.paths.home}/`) ? path.slice(data.paths.home.length + 1) : path}</span>`,
                ])}
              />
            </section>
          </div>
        `
      : null}
  </div>`;
}
