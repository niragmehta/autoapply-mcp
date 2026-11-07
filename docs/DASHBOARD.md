# Dashboard and run queue

A local web dashboard for steering a campaign, and a run queue that executes long operations (discovery,
preparation, submission, liveness checks, inbox scans, sourcing) in the background while you watch. The dashboard
calls the same services as the MCP tools, so every guard, approval check and audit event is identical whichever way
you work. It covers the whole campaign: the pipeline before applying, and replies, follow-ups, interviews, offers,
analytics, reports, documents and new sources after.

## Starting it

```bash
npm run build          # once, or after pulling changes
npm run dashboard      # serves http://127.0.0.1:4317
npm run dashboard -- --port 4400
```

The command:

1. loads `paths.secrets` (`~/.autoapply/.env` by default: `KEY=value` lines for the ATS password and the
   verification mailbox) without overriding variables already set in the shell, and prints only how many it loaded;
2. opens the workspace (a configuration problem is printed, and the dashboard still starts so its Health page can
   show the details);
3. marks runs left `running` by a process that no longer exists as `interrupted`;
4. starts the server and prints a sign-in link containing a fresh token.

Open the printed link once. It sets a session cookie and redirects to the dashboard without the token in the
address bar. The token changes on every start unless `AUTOAPPLY_DASHBOARD_TOKEN` is set (24 or more URL-safe
characters), which is useful for scripts.

Stop with Ctrl+C. Runs finish the application in hand first (a browser submission can take several minutes) and
are then marked `interrupted`; press Ctrl+C again to stop at once.

| Variable | Purpose |
| --- | --- |
| `AUTOAPPLY_HOME` and the other path variables | Same as the MCP server (see CONFIGURATION.md). |
| `AUTOAPPLY_DASHBOARD_TOKEN` | Fixed token instead of a random one. |
| `AUTOAPPLY_DASHBOARD_PORT` | Default port when `--port` is not given. |

## Security model

The dashboard can approve and submit applications, so it is treated as a privileged local tool.

- **Loopback only.** It refuses to listen on anything but `127.0.0.1`, `localhost` or `::1`.
- **Per-start secret.** Every `/api` request needs the session cookie (`HttpOnly`, `SameSite=Strict`, set by the
  `/?token=` link) or `Authorization: Bearer <token>`. Tokens are compared in constant time and repeated wrong
  tokens are throttled.
- **DNS rebinding.** Requests whose `Host` header is not `127.0.0.1`, `localhost` or `[::1]` with the right port are
  refused, so a hostile page that rebinds its own domain to 127.0.0.1 cannot reach the API.
- **CSRF.** State-changing requests authenticated by cookie must carry a matching `Origin`. Bearer requests cannot
  be forged cross-site; if they carry an `Origin`, it must match too. Bodies must be `application/json`, which a
  cross-site form cannot send.
- **Input validation.** Every path parameter, query string and body is validated with zod; bodies are capped at
  256 KB.
- **Headers.** `Content-Security-Policy: default-src 'self'` with no inline script (the import map is allowed by its
  exact hash), `frame-ancestors 'none'`, `X-Content-Type-Options: nosniff`, `Referrer-Policy: no-referrer`,
  `X-Frame-Options: DENY` and a restrictive `Permissions-Policy`. No CDNs, web fonts or tracking.
- **Files.** Static files come only from `web/` and the three vendor modules; screenshots only from the artifacts
  directory, by a validated flat file name. Tracker exports and calendar files are served from the exports folder by
  a validated file name, tailored PDFs only when their stored path lies inside the documents folder, and report
  Markdown only from inside the reports folder. Path traversal, encoded separators, dot files and Windows device
  names are rejected before the filesystem is touched.
- **Secrets.** Health reports which secret names are present; values never leave the process. Run logs and
  summaries are redacted like the audit log.
- **Home folder.** Paths, packet text (preview and manual packet) and error messages shown in the browser have the
  user's home folder shortened to `~`.
- **Errors.** Domain errors return their stable code and message; unexpected errors return a generic message and are
  logged to the terminal.
- **Nothing is sent, nothing is decided for you.** Follow-up and outreach drafts are copied, never sent. A reply is
  recorded only when you click Record outcome (a pasted reply is never recorded automatically); an inbox scan records
  only the kinds you listed in `campaign.inbox.autoRecord`, and its start form says which. Every approval, dismissal,
  accepted board and submission is an explicit click.

## Runs

A run is a row in the `runs` table with an append-only log in `run_logs`. Any process can list runs and read logs;
only the process that started a run executes it.

| Host | Lifetime |
| --- | --- |
| Dashboard (`npm run dashboard`) | Durable: runs keep going while the browser is closed. Use it for submission runs. |
| MCP server (`start_run` tool) | Runs live as long as the MCP client session. When the client exits, the server exits and its runs become `interrupted`. |

Statuses: `queued`, `running`, `succeeded`, `failed`, `cancelled`, `interrupted`. One run of each type executes at a
time per host; others wait in order.

**Cancelling** is cooperative: a queued run is cancelled at once; a running one stops at its next item boundary, so
an application being submitted is always finished and recorded first. Cancelling a run hosted by another process
flags it; that process stops it within one heartbeat (15 s).

**Recovery.** Each host records a heartbeat. On start, and every heartbeat, a host marks runs `interrupted` when
their process is gone (same machine, dead pid) or their heartbeat is older than two minutes.

**Configuration edits** apply between items: executors re-read `profile.json`, `campaign.json` and
`companies.json` whenever one changes on disk. The run queue never closes the shared database handle to do so.

### Built-in run types

| Type | Params | What it does |
| --- | --- | --- |
| `discovery` | `companies?: string[]`, `chunkSize?: number` (default 10) | Calls `runDiscovery` per chunk of active boards, with per-board progress. Unknown or paused companies are logged and skipped. |
| `prepare` | `jobIds?: string[]` or `filter?: {tiers, tracks, locationClasses, companies, minCompensation, allowUnknownCompensation, minScore, limit}`, `force?` | Calls `prepareApplication` for each job and reports ready versus needs-human. A filter selects like `prepare_batch`: tiers default to A and B, roles already applied to or dismissed are excluded, the per-company ceiling holds, and `submission.maxBatchSize` caps the selection. |
| `submit` | `applicationIds: string[]`, `mode?: auto \| assisted`, `headed?`, `paceSeconds?`, `codeWaitSeconds?`, `packetHashes?` | See below. |
| `liveness` | `jobIds?`, `applicationStatuses` (default awaiting_approval, approved, needs_human), `includeQueue` (false), `limit` (200), `force` (false) | Asks each posting's board, then its page, whether it still takes applications, and stores the verdict. Summary: `checked`, `open`, `closed` (a count), `unknown`, `missing`, and `closedPostings: [{jobId, company, title, detail}]`, which the run panel lists with links to each job. |
| `close-stale` | `dryRun` (**true** by default) | Lists submitted applications silent past `campaign.followUps.ghostAfterDays`; records them as ghosted only with `dryRun: false`. |
| `inbox` | `lookbackDays?`, `dryRun` (false) | Reads replies from the configured mailbox, read-only. Kinds in `campaign.inbox.autoRecord` are recorded; the rest wait in the Inbox for you. Needs `campaign.inbox.enabled`. |
| `alerts` | `lookbackDays` (14) | Imports LinkedIn job-alert emails from the verification mailbox as leads. |
| `funded` | `months` (3), `limit` (50) | Reads public funding-news feeds and stores recently funded companies as leads. |
| `propose` | `limit` (5) | Finds and verifies ATS boards for companies seen in new leads. Writes nothing; you accept boards on the Leads page. |
| `harvest` | `ats?`, `indexes` (1), `maxPages?`, `scan` (true), `scanLimit` (200) | Harvests boards from the Common Crawl index, then scans untracked ones for roles that pass the gates. |

The first three are registered by `registerBuiltinTasks`; the rest by `registerFeatureTasks`
(`src/runner/tasks/features.ts`), which `registerBuiltinTasks` calls.

A **submit run** processes an explicit list a person chose. For each application, in order:

1. skip it if already submitted;
2. skip it if the company already has `campaign.runner.roundCap.max` submissions since `roundCap.since`
   (company names are normalised, so "Acme, Inc." and "ACME" count together);
3. with `campaign.runner.autoAllowlist` on, add the company to `submission.allowedCompanies` just before submitting
   (an empty allowlist already permits every company and is left alone);
4. preview the packet and skip it when a required answer is unresolved; nothing is guessed;
5. when `packetHashes` names a hash for it and the current packet differs, skip it as changed since review;
6. approve the current packet hash if it is not already approved at that hash, noting "approved via submit run
   &lt;id&gt;": starting the run is the person's approval of that list;
7. call `submitApplication` (auto unless assisted; headless unless headed, except Ashby, which flags headless
   submissions as spam); when the `pacing` guard answers, wait the seconds it names and retry, at most eight times.
   With `campaign.hygiene.liveness.beforeSubmit` on, `submitApplication` itself checks the posting (reusing a recent
   stored verdict) and refuses one confirmed closed with AppError `posting_closed`; an unconfirmed check proceeds.
   The run logs that refusal as a `SKIP`, not a failure;
8. log `SENT`, `FILLED`, `FAIL` or `SKIP` with the reason and the screenshot name, then wait `paceSeconds` before the
   next application that reached an employer.

`daily_limit_reached` and `mode_not_permitted` stop the whole run, since they would refuse every later item too.
Every guard in `submitApplication` still applies to every item. There is no separate preflight hook: the closed-posting
check lives in `submitApplication`, so it holds for submit runs, `submit_application`, `submit_batch` and the
dashboard's manual packet alike.

A skipped item for a closed posting carries `code: "posting_closed"` in the run summary and in its `SKIP` log line's
data. The dashboard reads that code and nothing else (never the reason text or the audit log) and adds a
`postingClosed` count to submit-run summaries, so run lists, the run panel and its log say "posting closed" instead
of a generic skip. A manual packet request for a closed posting answers 409 with the same code, and the application
panel explains it.

Runner settings live in `campaign.runner` (see CONFIGURATION.md): `paceSeconds`, `roundCap`, `autoAllowlist`,
`headed`, `codeWaitSeconds`.

### MCP tools

| Tool | Purpose |
| --- | --- |
| `start_run` | Queue a run `{type, params}` and return its id. |
| `run_status` | Status, progress, summary and recent log lines. |
| `list_runs` | Recent runs from every host. |
| `cancel_run` | Cancel or ask the owning host to stop a run. |
| `run_logs` | Log lines after a sequence number, to follow a run. |

### Adding a run type

```ts
import { getRunQueue } from "./runner/index.js";

getRunQueue().registerTask(
  "salary-survey",
  async (ctx, params: { jobIds: string[] }) => {
    for (const [index, jobId] of params.jobIds.entries()) {
      if (ctx.signal.aborted) break;      // honour cancel between items
      const workspace = ctx.workspace;    // fresh configuration for this item
      // ... do one item ...
      ctx.log("info", `read ${jobId}`, { jobId });
      ctx.progress(index + 1, params.jobIds.length);
      await ctx.sleep(1000);              // rejects as soon as the run is cancelled
    }
    return { read: params.jobIds.length }; // stored as the run summary
  },
  { params: SalarySurveyParamsSchema, concurrency: 1, description: "Read pay data for chosen postings." },
);
```

`ctx` provides `workspace`, `log(level, message, data?)`, `progress(done, total)`, `signal`, `sleep(ms)` and
`throwIfCancelled()`. Register at startup in both hosts (the dashboard CLI and the MCP server) so either can run it.

## API

All endpoints are under `/api`, return JSON (downloads excepted), and need the cookie or bearer token. Every
non-GET endpoint also passes the same-origin check.

### Pipeline

| Endpoint | Purpose |
| --- | --- |
| `GET /api/status` | Funnel, jobs by decision, tier and track, the unprepared queue (counted like `list_queue`: by fingerprint, without dismissed roles), dismissed count, applications by status, today against the daily limit, round progress, outcomes with the outcome taxonomy, the after-applying summary (replies to review, follow-ups due, interviews this week, offers, new leads, board proposals), runs and next actions. |
| `GET /api/meta` | Enumerations for filter controls (outcome taxonomy from the follow-up policy, inbox, follow-up, lead and career enums), campaign submission and runner settings, run types. |
| `GET /api/jobs` | `q, tier, track, decision, locationClass, ats, company, hasApplication, minScore, dismissed (hide \| include \| only), sort, dir, page, pageSize` (lists as `a,b` or repeated keys). Rows carry the dismissal, the latest liveness verdict and whether the same role was applied to elsewhere. |
| `GET /api/jobs/facets` | Value counts for the job filters, and the dismissed count. |
| `GET /api/jobs/dismissed` | Dismissed roles with reasons (`limit`). |
| `GET /api/jobs/:id` | Posting, evaluation (gate, components, flags), application, duplicates, dismissal, liveness history, legitimacy signals, events. |
| `POST /api/jobs/:id/prepare` | `{force?, resumeId?}` |
| `POST /api/jobs/:id/dismiss`, `POST /api/jobs/:id/restore` | `{reason?}` / `{}`. Dismissing takes the role, and the same role on any other board, out of the queue. If it has an unsent application, a rejection is recorded against that application's current packet (which voids any earlier approval and sets it to skipped) and its items in prepared batches become `skipped`; the result reports `skippedApplicationId` and `batchItemsSkipped`. A submitted application is refused (409 `already_submitted`). Restoring brings the role back, not the application: prepare and approve it again. |
| `POST /api/jobs/dismiss`, `POST /api/jobs/restore` | Bulk: `{jobIds, reason?}` / `{jobIds}`; each dismissal reports the same fields, and each refusal is reported per job. |
| `POST /api/jobs/:id/liveness` | Check the posting now (`{force?}`, default true) and return the verdict with fresh legitimacy signals. |
| `GET /api/applications` | `status, q, company, sort, dir, page, pageSize`; each row carries unresolved count and latest outcome. |
| `GET /api/applications/:id` | Packet preview, answers with sources and blocked state, approval, outcomes, interviews, offers, the posting's latest liveness verdict, events (the application's and its job's, such as a dismissal), screenshots. |
| `POST /api/applications/:id/answers` | `{answers: [{questionKey, answer}], coverLetter?, notes?}` |
| `POST /api/applications/:id/approve` | `{packetHash, decision?: approved \| rejected, note?}` |
| `POST /api/applications/:id/submit` | `{mode}`: `manual` returns the packet text (409 `posting_closed` when the posting reads closed); `assisted` and `auto` must go through a submit run. |
| `POST /api/applications/:id/record-submission` | `{confirmationRef?, notes?}` |
| `POST /api/applications/:id/outcome` | `{status, detail?}`; `status` is any outcome kind of the follow-up policy, recorded through `recordApplicationOutcome`. |
| `GET /api/needs-human` | Held applications grouped by unresolved question, with guidance, earlier answers to the same question and the latest screenshot. |
| `POST /api/needs-human/answers` | `{items: [{applicationId, questionKey, answer}]}`, applied per application. |
| `GET /api/artifacts/:name` | A PNG or JPEG screenshot from the artifacts directory. |
| `GET /api/documents` | Each application's resume (tailored or track variant) and cover letter (`status`, `limit`), the resume source and the profile's variants. |
| `GET /api/documents/:applicationId` | `document_status` for one application, with links to its PDFs. |
| `GET /api/documents/files/:id` | A tailored PDF, only from inside the documents folder. |
| `POST /api/documents/:applicationId/tailor` | `{headline?}`: render a tailored resume (voids any approval). |
| `POST /api/documents/variants/:resumeId/render` | Render a track variant from `resume.json`. |

### After applying

| Endpoint | Purpose |
| --- | --- |
| `GET /api/inbox` | Whether reply reading is on and a mailbox configured (never credentials), counts per status, last scan. |
| `GET /api/inbox/replies` | `status` (default `proposed`), `limit`: replies with classification, evidence, match or candidates, and why they wait. |
| `POST /api/inbox/replies/:id/confirm` | `{kind?, applicationId?}`: record the outcome, correcting kind or application. |
| `POST /api/inbox/replies/:id/dismiss` | Set a reply aside; nothing is recorded. |
| `POST /api/inbox/paste` | `{text, subject?, from?, applicationId?}`: classify a pasted reply into a proposal (never recorded automatically). |
| `GET /api/follow-ups` | `horizonDays` (0-60, default 7): due follow-ups with drafts and channels, upcoming ones, exclusions, and `handled`: follow-ups sent or skipped in the last 30 days, each with `skipped`. |
| `POST /api/follow-ups/mark` | `{applicationId, kind, action: done \| skip \| snooze, days?, note?}`, passed to `markFollowUp`. `done` means you sent it, which counts as contact. `skip` resolves the reminder without sending: it is not counted as contact, so the next reminder and the ghost-close date keep their dates. The record carries `skipped`. |
| `GET /api/interviews` | `scope` (upcoming \| all), `status`, `applicationId`, `limit`. |
| `GET /api/interviews/:id` | One interview with its prep plans, practice and debrief notes. |
| `GET /api/interviews/:id/ics` | Calendar file for a scheduled interview, generated on request (not written to disk). |
| `GET /api/interview-sessions` | `applicationId, interviewId, kind, limit`. |
| `GET /api/offers`, `GET /api/offers/compare` | Offers (`status`, `applicationId`); comparison in the profile's currency (`includeClosed`). |
| `GET /api/stories`, `GET /api/stories/scaffold` | Story bank (`tag, skill, limit`); competency coverage. |
| `GET /api/contacts` | `company, kind, applicationId, limit`. |
| `GET /api/outreach` | Drafts: `applicationId, contactId, company, status, channel, limit`. |
| `POST /api/outreach/:id/mark` | `{status: sent_by_user \| discarded \| draft}`: record what you did with a draft. |
| `GET /api/company-notes` | Research notes for one `company`, or across every company. |

### Insights and sources

| Endpoint | Purpose |
| --- | --- |
| `GET /api/analytics` | `campaign_analytics` (`since`): funnel, conversion by dimension, timing, rejection patterns, calibration, skill gaps, discards. Every rate carries its sample. |
| `GET /api/exports`, `POST /api/exports` | List exports; write a tracker export `{format: csv \| markdown}`. |
| `GET /api/exports/:name` | Download an export or calendar file from the exports folder. |
| `GET /api/reports`, `GET /api/reports/:id` | Evaluation reports (`jobId`, `limit`); one report with its Markdown, read only from inside the reports folder. |
| `GET /api/reposts` | Reposted roles (`windowDays, minPostings, company, limit`). |
| `GET /api/blacklist` | The do-not-apply list. |
| `GET /api/companies` | Boards with posting, acceptance and application counts. |
| `POST /api/companies` | Verify a board, then save it (422 when it serves no postings). |
| `PATCH /api/companies/:name` | `{active?, tier?, tags?}` |
| `GET /api/leads` | `status, source, limit`, with counts per source and status. |
| `POST /api/leads/status` | `{ids (1-500), status: ignored \| new}`, passed to `setLeadsStatus`: ignore leads or restore them to new. Resolved leads are never changed; returns `{status, updated, missing}`. |
| `GET /api/leads/proposals` | Boards from the latest successful `propose` run for companies not yet in companies.json. |
| `POST /api/leads/proposals/accept` | `{proposals: [{company, ats, board, region?, tier?}]}`: re-verify and save each accepted board. |
| `GET /api/harvest` | Harvested boards by type and status, boards with fitting roles, recent harvests. |

### System

| Endpoint | Purpose |
| --- | --- |
| `GET /api/runs`, `POST /api/runs` | List (`status, type, before, limit`) or start (`{type, params}`) runs. Submit-run summaries carry `postingClosed`, counted from items with `code: "posting_closed"`. |
| `GET /api/runs/types` | Registered run types. |
| `GET /api/runs/:id`, `POST /api/runs/:id/cancel`, `GET /api/runs/:id/logs` | Inspect, cancel, page logs (`afterSeq`). |
| `GET /api/runs/:id/events` | Server-sent events: `log` (with `id` = sequence, so `Last-Event-ID` resumes), `progress`, `run`, then `end`. |
| `GET /api/events` | Audit log: `type, subject, before, limit`. |
| `GET /api/health` | Configuration validity, resumes, Playwright, IMAP, reply reading, profile readiness, secret names, database counts, paths (home shortened to `~`), version. |

A new area adds `src/dashboard/api/<area>.ts` exporting `registerRoutes(router)` and lists it in
`src/dashboard/api/index.ts`. Read-only SQL the services do not offer lives in `src/dashboard/queries/`.

## Views

The browser app lives in `web/` and needs no build: Preact and htm are served from `node_modules` through an import
map (`/vendor/preact.mjs`, `/vendor/preact-hooks.mjs`, `/vendor/htm.mjs`).

Navigation is a rail drawn as a line map, in five sections. Needs human keeps a yellow count; Inbox, Follow-ups,
Interviews and Leads show quieter counts. Below 1024 px the rail becomes a top bar with a Menu button and the
yellow "need you" count.

| Section | View | Key | What it is for |
| --- | --- | --- | --- |
| Pipeline | Overview | `g o` | The pipeline as a line of stations, what needs you (held questions, replies, offers, packets, follow-ups, interviews, proposals, failed runs), recent runs, the after-applying timetable, today and the round cap. |
| | Jobs | `g j` | Every posting, filtered and sorted in the URL, including a Dismissed filter. Select rows to dismiss (with a reason) or restore in bulk. A row opens the evaluation, liveness and legitimacy with Check now, Prepare, and Dismiss or Restore. Dismissing asks first and says what happens to an unsent application (skipped, approval voided, out of prepared batches). |
| | Applications | `g a` | Applications by status. A row opens the packet: blocked questions, approval bound to the shown hash (or the rejection that skipped it), a submit run or the manual packet, outcomes, interviews and offers, screenshots and history. A closed posting is called out. |
| | Needs human | `g n` | Held applications grouped by question, so one answer releases every application asking it. |
| | Documents | `g d` | The resume and letter each application uses, the rendered PDFs, rendering a variant or tailoring a resume. |
| After applying | Inbox | `g i` | Replies to review: what each reads as, which application, why it waits; record or dismiss; paste a reply. |
| | Follow-ups | `g f` | Due follow-ups with drafts to copy; mark sent, skip (not counted as contact) or snooze; what is coming up; what was sent or skipped lately; a dry-run preview of closing silent applications. |
| | Interviews and offers | `g v` | Interviews with calendar files and prep notes, offers compared, story bank coverage, contacts with outreach drafts, company research. |
| Insights | Analytics | `g s` | Funnel and conversion with every rate's sample, timing, rejections, score calibration, skill gaps, gate discards, tracker export. |
| | Reports | `g e` | Evaluation reports to read, reposted roles, the do-not-apply list. |
| Sources | Companies | `g c` | Boards with their yield; pause, resume and re-tier; add a board after verifying it. |
| | Leads | `g l` | Board proposals to accept, leads by source and status with Ignore and Restore (one or many; resolved leads keep their status), harvesting results. |
| System | Runs | `g r` | Start any run type (forms with defaults; close-stale is a dry run unless you untick it and confirm), history, live logs, cancel. |
| | Health | `g h` | Checks, profile readiness, runtime, secret names, read-only configuration, database counts and paths. |

Keyboard: `g` then a view's key moves between views, `/` focuses the page's search, `j`/`k` or arrows move between
table rows, Enter opens one, Escape closes the panel, `?` lists the shortcuts.

**Adding a view:** write `web/views/<name>.js` with a default component, call
`registerView({id, path, label, group, order, key, load, badge?})` in `web/views/index.js` (the group is one of
`NAV_GROUPS` in `web/nav.js`; the key must be free), and add the API module it needs. The rail, the mobile menu,
routing, shortcuts and badges pick it up.

Design decisions and the visual system are recorded in [design/DASHBOARD_DESIGN.md](design/DASHBOARD_DESIGN.md).
