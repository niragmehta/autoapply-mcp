# autoapply-mcp

An MCP server and local dashboard that turn a verified candidate profile into a governed job-search pipeline. It discovers postings from public ATS boards, screens out dead and ghost postings, gates and scores what survives with quotable evidence, drafts only the answers your profile supports, tailors your resume without inventing anything, refuses to submit without a recorded human approval, then follows through: it reads replies, schedules follow-ups, and helps with interviews and offers.

It is built for high-volume search **without** becoming a spam bot. Discovery, ranking, form-filling and bookkeeping are automated. Judgement, truthfulness and consent are not.

## What it does

| Stage | Behaviour |
|---|---|
| Discover | Reads 35 kinds of employer board: Greenhouse, Lever, Ashby, Workday, SmartRecruiters, Workable, Recruitee, 12 enterprise systems (iCIMS, Taleo, SuccessFactors, Oracle Cloud, Phenom, Eightfold, Avature, Cornerstone, UKG, ADP, Paylocity, Jobvite), 12 small-business systems (BambooHR, JazzHR, Breezy, Rippling, Gem, Pinpoint, Dover, Teamtailor, Personio, HiBob, Zoho Recruit, ClearCompany) and the Google, Meta, Amazon and Apple career sites |
| Source | Finds new employers: 12 job-lead sources, VC portfolio boards, Hacker News hiring threads, LinkedIn job-alert emails, funding news and a Common Crawl board harvest, each turned into a verified board before it is used |
| Screen | Confirms postings are still open, clusters reposts, flags ghost-posting signals, and honours your do-not-apply list and dismissed postings |
| Gate and score | Hard-rejects on location, seniority, pay floor, clearance, citizenship and sponsorship, then ranks survivors on seven weighted dimensions, each with the quote that earned it |
| Evaluate | Builds a deep, scored report for a posting (fit, gaps, level, compensation, legitimacy) that you or your agent can save and compare |
| Draft | Loads the employer's real questions and answers only what verified profile data supports |
| Tailor | Renders a one-page resume tailored to each posting from your `resume.json`, and fact-checks cover letters against your profile |
| Approve | Binds a human approval to a hash of the exact submission content |
| Submit | Manual, assisted or auto, never beyond the mode the campaign permits |
| Follow through | Reads replies (read-only), records outcomes you confirm, drafts follow-ups, closes ghosted applications, exports a tracker and reports what is working |
| Interview and offer | Story bank, interview preparation and debriefs, contacts and outreach drafts, offer comparison and negotiation plans |
| Orchestrate | A run queue for long jobs and a local dashboard to start runs, watch them, and see where every job and application stands |

## Design rules

1. **Nothing is invented.** Every drafted answer traces to a profile field or a pre-approved answer, tailoring only reorders content already in your resume source, and cover letters and outreach are fact-checked. Anything else is handed back to you.
2. **Sensitive questions always stop.** Work authorization, citizenship, compensation, criminal history, demographics and legal attestations require a human decision by default.
3. **Approval binds to content.** `approve_application` records a packet hash. Editing anything invalidates it and submission is refused.
4. **External text is untrusted data.** Job descriptions, careers pages, emails and lead sources are scanned for prompt-injection patterns, wrapped in an explicit data boundary, and never treated as instructions. Every URL is checked before it is fetched, including what its host name resolves to, so a link cannot reach your own network.
5. **Anti-bot controls and terms are respected.** A detected CAPTCHA aborts the run and hands the application back to you; there is no solving, evading or fingerprint spoofing. Sources whose terms forbid automated access stay off unless you enable them.
6. **Destinations are allowlisted.** Submissions only go to hosts and companies the campaign explicitly trusts, over HTTPS.
7. **It never speaks for you.** The server reads your mailbox but never sends email or messages. Follow-ups and outreach are drafts for you to send, and replies are recorded only when you confirm them.

## Requirements

- Node.js 22.5 or newer (uses the built-in `node:sqlite`, so there is no native build step)
- Playwright for assisted or automatic form filling, and for rendering tailored resumes: `npm install playwright && npx playwright install chromium`

## Install

```bash
git clone <repository-url> autoapply-mcp
cd autoapply-mcp
npm install
npm run build
npm test
```

## Configure

Personal data lives outside the repository, so a checkout can be published as-is. The default home is `~/.autoapply`:

```bash
npm run init
```

`init` creates `~/.autoapply` from the shipped examples, adds `resumes/`, `data/` and `artifacts/`, and prints the editing order. It never overwrites a file that already exists, so it is safe to re-run. Your agent can then fill the profile in conversation with the `onboard` prompt and the `profile_status`, `update_profile` and `import_resume_text` tools; see [docs/ONBOARDING.md](docs/ONBOARDING.md).

### The profile template

`examples/profile.example.json` holds no personal data, compensation or location preferences. It does carry a bank of 170 recurring application questions, each matched to the wordings employers use:

- **Fill in:** `identity`, `workAuthorization`, `compensation`, `preferences`, `resumes`, `skills`, `facts`, `experience` and `education`. Every value in these sections is a placeholder or an example to replace. The `workAuthorization` country lists start empty, which gates out every posting that requires citizenship until you add the ISO codes, such as `CA` or `US`, of the countries you can work in.
- **Pre-answered:** decisions that hold for almost anyone, which you should review once before your first run: "How did you hear about us?" (the company careers page), privacy, data-processing and background-check consents, and voluntary demographic questions, set to decline.
- **Blank:** anything personal. A blank answer means you are asked whenever a form needs it; write it once and it is reused. Legally material questions, such as work authorization, export control, government ties, arbitration and salary, are also set to `allowAutoFill: false`, so a filled-in answer stays a suggestion until you set it to true.
- **Narratives:** the "why this company" templates stay suggestions until you rewrite them in your own words and set `allowAutoFill` to true. See [docs/BATCH.md](docs/BATCH.md#narrative-templates).

For tailored resumes, write `~/.autoapply/resume.json` from [`examples/resume.example.json`](examples/resume.example.json) and set `documents.tailorResume`; see [docs/DOCUMENTS.md](docs/DOCUMENTS.md).

Then verify:

```bash
node dist/cli/doctor.js --probe
```

`doctor` validates all three files, checks that your resume files exist and are real PDFs, confirms every track points at a resume variant, warns about settings written in the wrong place, and probes each configured board. Unknown keys are stripped silently by the schema, so a setting written one level too high reads as configured and behaves as absent; `doctor` reports these as `WARN` and names where the setting belongs.

`presets/ai-security-us-canada.json` ships 135 company boards verified live against the ATS APIs, weighted toward AI, security and infrastructure companies in the US and Canada. It is a starting point: add boards with `resolve_company_board` and `add_company_board`, or let `propose_companies` suggest verified ones from your leads.

A fresh install cannot contact an employer: `submission.mode` is `manual`, and `submission.allowedCompanies` is empty, which blocks every company until you add it by name.

Every setting and environment variable is described in [docs/CONFIGURATION.md](docs/CONFIGURATION.md).

## Register with an MCP client

```json
{
  "mcpServers": {
    "autoapply": {
      "command": "node",
      "args": ["/absolute/path/to/autoapply-mcp/dist/index.js"],
      "env": { "AUTOAPPLY_HOME": "/absolute/path/to/your/.autoapply" }
    }
  }
}
```

The server speaks stdio and logs to stderr, so stdout stays clean for the protocol. Configuration for Copilot CLI, VS Code, Claude Desktop, Claude Code and others is in [docs/CLIENTS.md](docs/CLIENTS.md).

It registers 95 tools in eight toolsets: `core`, `sources`, `screening`, `documents`, `followup`, `career`, `onboarding` and `runs`. Some clients cap the tools one request may carry (VS Code allows 128 across all servers), so load only what you use, for example `"AUTOAPPLY_TOOLSETS": "core,screening,followup"`. Guided workflows ship as MCP prompts, starting with `autoapply_guide`.

## The dashboard

```bash
npm run dashboard        # serves http://127.0.0.1:4317 and prints a sign-in link
```

A local web app over the same services as the tools: start discovery, preparation, submission and sourcing runs and watch them live; review the queue, dismiss postings, and approve exact packets; work through replies, follow-ups, interviews and offers; and check analytics, sources and system health. It only listens on loopback and every request needs the session token. See [docs/DASHBOARD.md](docs/DASHBOARD.md).

## Typical session

Single application:

```
discover_jobs                  -> fetch every board, gate, score, store
list_queue                     -> the ranked, de-duplicated shortlist
evaluate_job       jobId       -> a deep report: fit, gaps, level, pay, legitimacy
prepare_application jobId      -> liveness check, match report, employer questions, drafted answers, tailored resume
set_application_content        -> your cover letter and any answers only you can give
preview_application            -> the exact packet plus its hash
approve_application  + hash    -> your explicit authorization
submit_application   mode      -> manual, assisted or auto
record_outcome                 -> or let scan_inbox propose it from the reply
```

High volume:

```
prepare_batch  {tiers:["A","B"], locationClasses:["bay-area"], minCompensation:250000}
preview_batch                  -> the set, plus grouped blocking questions
approve_batch  + manifestHash + expectedCount
submit_batch   mode            -> honours configured limits and pacing
```

Long jobs such as a full discovery or a paced submission round also run in the queue (`start_run`, or the dashboard), where they survive client timeouts.

## Submission modes

| Mode | Behaviour | Use it when |
|---|---|---|
| `manual` | Server prepares the packet; you submit it yourself | Always start here |
| `assisted` | Server fills the hosted form in a visible browser and leaves it open for you to review and submit | After the manual pilot proves the packets are right |
| `auto` | Server fills and clicks submit | Only for allowlisted companies on forms you have already seen work |

Browser submission covers Greenhouse, Lever, Ashby, Workday and the Google, Meta and Amazon career sites. The other ATS kinds are discovery-only and produce manual packets. `auto` additionally requires the company to appear in `submission.allowedCompanies`, every required field to be fillable, and no blocked questions to remain unanswered.

## What it deliberately does not do

- No LinkedIn, Indeed or Wellfound automation. Their terms prohibit it and signing in would put your account at risk. Their job-alert emails can be imported as leads; apply through the employer's own board.
- No sending. It never sends email, LinkedIn messages or follow-ups; it drafts them for you.
- No CAPTCHA solving, proxy rotation or fingerprint evasion.
- No invented content. The server supplies structured evidence and fact-checks; your agent writes the words and you approve them.

## Known limitations

- Compensation parsed from description text is a heuristic. Postings that list several geographic pay zones can yield the wrong figure, so those results carry a `compensation-parsed-from-text` flag. Structured ATS pay data is preferred whenever a board publishes it.
- FX rates in `campaign.json` are static. Update them before relying on a cross-currency floor.
- Only Greenhouse publishes an application question schema. For other boards the server drafts against a baseline field set and reads the real form during an assisted run.
- Enterprise and small-business boards cannot all be found by guessing; some must be added from the careers URL. Their formats and caps are in [docs/SOURCES_ENTERPRISE.md](docs/SOURCES_ENTERPRISE.md) and [docs/SOURCES_SMB_AND_LEADS.md](docs/SOURCES_SMB_AND_LEADS.md).
- `@modelcontextprotocol/sdk` currently pulls a transitive advisory in `@hono/node-server` affecting its static-file server. This server uses the stdio transport only and never serves files through it, so the affected code path is not reachable.

## Documentation

| Document | Covers |
|---|---|
| [TOOLS.md](docs/TOOLS.md) | Every tool and prompt, generated from the live schemas |
| [CONFIGURATION.md](docs/CONFIGURATION.md) | profile.json, campaign.json, companies.json and environment variables |
| [CLIENTS.md](docs/CLIENTS.md) | Registering the server with each MCP client |
| [ONBOARDING.md](docs/ONBOARDING.md) | Setting up a profile and campaign in conversation |
| [SOURCES.md](docs/SOURCES.md), [SOURCES_ENTERPRISE.md](docs/SOURCES_ENTERPRISE.md), [SOURCES_SMB_AND_LEADS.md](docs/SOURCES_SMB_AND_LEADS.md) | Boards, lead sources, formats, limits and terms |
| [SOURCING.md](docs/SOURCING.md) | Finding new employers: alerts, funding news, proposals and the Common Crawl harvest |
| [EVALUATION.md](docs/EVALUATION.md) | Liveness, reposts, legitimacy, the do-not-apply list and deep evaluation reports |
| [DOCUMENTS.md](docs/DOCUMENTS.md) and [RESUMES.md](docs/RESUMES.md) | resume.json, tailored resumes, cover letters and fact checks |
| [BATCH.md](docs/BATCH.md) | High-volume campaigns and cached personal data |
| [AFTER_APPLY.md](docs/AFTER_APPLY.md) | Inbox replies, follow-ups, outcomes and analytics |
| [CAREER.md](docs/CAREER.md) | Story bank, interviews, contacts, outreach and offers |
| [DASHBOARD.md](docs/DASHBOARD.md) | The dashboard and the run queue |
| [CLOUD.md](docs/CLOUD.md) | Moving your workspace to another machine or a cloud sandbox |
| [SAFETY.md](docs/SAFETY.md) | The guarantees and their limits |

## Development

```bash
npm run typecheck
npm test
npm run coverage
node scripts/check-no-user-data.mjs
```

Nearly 3,400 tests cover every adapter against recorded fixtures, the gates and scoring, the answer policy, submission guards and packet hashing, the run queue, the dashboard API, the after-apply loop, document tailoring and an end-to-end run through a real in-memory MCP client. `npm run typecheck` checks the tests as well as the source, and unit tests never touch the network. CI runs both on Linux and Windows and fails if a tracked file looks like personal data.

`docs/TOOLS.md` is generated from the tool schemas; after changing a tool, regenerate it with `UPDATE_TOOL_DOCS=1 npx vitest run test/toolDocs.test.ts`.

## Credits

Several features (posting liveness and legitimacy checks, deep evaluations, the story bank, interview and offer workflows, follow-up cadence, and many source adapters) adapt ideas and code from [career-ops](https://github.com/career-ops-hq/career-ops) under the MIT License. See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

## License

MIT
