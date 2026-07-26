# autoapply-mcp

An MCP server that turns a verified candidate profile into a governed job-application pipeline: it discovers postings from public ATS boards, applies hard eligibility gates, scores what survives with quotable evidence, drafts only the answers your profile actually supports, and refuses to submit anything without a recorded human approval.

It is built for high-volume search **without** becoming a spam bot. Discovery, ranking and form-filling are automated. Judgement, truthfulness and consent are not.

## What it does

| Stage | Behaviour |
|---|---|
| Discover | Fetches Greenhouse, Lever and Ashby public job-board APIs for the companies you configure |
| Gate | Hard-rejects on location, seniority, compensation floor, clearance, citizenship and sponsorship constraints |
| Score | Ranks survivors across seven weighted dimensions, each with the quote that earned it |
| Draft | Builds a match report, loads the employer's real questions, and answers only what verified profile data supports |
| Approve | Binds a human approval to a hash of the exact submission content |
| Submit | Manual, assisted or auto - never beyond the mode the campaign permits |
| Track | Records submissions, outcomes and an append-only audit log |

## Design rules

1. **Nothing is invented.** Every drafted answer traces to a profile field or a pre-approved answer. Anything else is handed back to you.
2. **Sensitive questions always stop.** Work authorization, citizenship, compensation, criminal history, demographics and legal attestations require a human decision by default.
3. **Approval binds to content.** `approve_application` records a packet hash. Editing anything invalidates it and submission is refused.
4. **Job descriptions are untrusted data.** Text from employers is scanned for prompt-injection patterns, wrapped in an explicit data boundary, and never treated as instructions.
5. **Anti-bot controls are respected.** A detected CAPTCHA aborts the run and hands the application back to you. There is no solving, evading or fingerprint spoofing.
6. **Destinations are allowlisted.** Submissions only go to hosts the campaign explicitly trusts, over HTTPS.

## Requirements

- Node.js 22.5 or newer (uses the built-in `node:sqlite`, so there is no native build step)
- Playwright, only if you want assisted or automatic form filling: `npm install playwright && npx playwright install chromium`

## Install

```bash
git clone <your-fork> autoapply-mcp
cd autoapply-mcp
npm install
npm run build
npm test
```

## Configure

Create a config directory and copy the examples:

```bash
mkdir -p ~/.autoapply
cp examples/profile.example.json   ~/.autoapply/profile.json
cp examples/campaign.example.json  ~/.autoapply/campaign.json
cp presets/ai-security-us-canada.json ~/.autoapply/companies.json
```

Then edit them and verify:

```bash
AUTOAPPLY_HOME=~/.autoapply node dist/cli/doctor.js --probe
```

`doctor` validates all three files, checks that your resume files exist, confirms every track points at a real resume variant, and probes each configured board.

`presets/ai-security-us-canada.json` ships 80 company boards that were verified live against the ATS APIs, weighted toward AI, security and infrastructure companies in the US and Canada.

### Environment variables

| Variable | Default | Purpose |
|---|---|---|
| `AUTOAPPLY_HOME` | `~/.autoapply` | Root for config, database and artifacts |
| `AUTOAPPLY_PROFILE` | `$HOME/profile.json` | Candidate profile |
| `AUTOAPPLY_CAMPAIGN` | `$HOME/campaign.json` | Campaign policy |
| `AUTOAPPLY_COMPANIES` | `$HOME/companies.json` | Company board list |
| `AUTOAPPLY_DB` | `$HOME/data/autoapply.sqlite` | SQLite database |
| `AUTOAPPLY_ARTIFACTS` | `$HOME/artifacts` | Screenshots and submission evidence |
| `AUTOAPPLY_LOG_LEVEL` | `info` | `debug`, `info`, `warn`, `error` |
| `AUTOAPPLY_MIN_INTERVAL_MS` | `700` | Minimum delay between requests to one host |
| `AUTOAPPLY_MAX_RESPONSE_MB` | `64` | Response size ceiling |

## Register with an MCP client

```json
{
  "mcpServers": {
    "autoapply": {
      "command": "node",
      "args": ["/absolute/path/to/autoapply-mcp/dist/index.js"],
      "env": { "AUTOAPPLY_HOME": "/absolute/path/to/your/config" }
    }
  }
}
```

The server speaks stdio. All logs go to stderr, so stdout stays clean for the protocol.

## Typical session

```
discover_jobs                  -> fetch every board, gate, score, store
list_queue                     -> the ranked, de-duplicated shortlist
explain_job        jobId       -> gate result and scoring evidence
prepare_application jobId      -> match report, employer questions, drafted answers
set_application_content        -> your cover letter and any answers only you can give
preview_application            -> the exact packet plus its hash
approve_application  + hash    -> your explicit authorization
submit_application   mode      -> manual, assisted or auto
record_outcome                 -> track what happened
```

See [docs/TOOLS.md](docs/TOOLS.md) for every tool, [docs/CONFIGURATION.md](docs/CONFIGURATION.md) for the schemas, [docs/RESUMES.md](docs/RESUMES.md) for resume variants and LaTeX builds, and [docs/SAFETY.md](docs/SAFETY.md) for the guarantees and their limits.

## Submission modes

| Mode | Behaviour | Use it when |
|---|---|---|
| `manual` | Server prepares the packet; you submit it yourself | Always start here |
| `assisted` | Server fills the hosted form in a visible browser and leaves it open for you to review and submit | After the manual pilot proves the packets are right |
| `auto` | Server fills and clicks submit | Only for allowlisted companies on forms you have already seen work |

`auto` additionally requires the company to appear in `submission.allowedCompanies`, every required field to be fillable, and no blocked questions to remain unanswered.

## What it deliberately does not do

- No LinkedIn, Indeed or Wellfound automation. Their terms prohibit it and their anti-bot systems are built to stop it. Use their alerts as leads, then apply through the employer's own board.
- No Workday support. Each tenant is bespoke, session-bound and protected; a candidate-side integration cannot be done reliably or respectfully.
- No CAPTCHA solving, proxy rotation or fingerprint evasion.
- No writing of your resume prose or cover letters. The server supplies structured evidence; your agent writes the words and you approve them.

## Known limitations

- Compensation parsed from description text is a heuristic. Postings that list several geographic pay zones can yield the wrong figure, so those results carry a `compensation-parsed-from-text` flag. Structured ATS pay data is preferred whenever a board publishes it.
- FX rates in `campaign.json` are static. Update them before relying on a cross-currency floor.
- Only Greenhouse publishes an application question schema. For Lever and Ashby the server drafts against a baseline field set and reads the real form during an assisted run.
- `@modelcontextprotocol/sdk` currently pulls a transitive advisory in `@hono/node-server` affecting its static-file server. This server uses the stdio transport only and never serves static files, so the affected code path is not reachable.

## Development

```bash
npm run typecheck
npm test
npm run coverage
```

174 tests cover location classification, compensation parsing, every gate, scoring, the answer policy, resume validation, submission guards, packet hashing, persistence, the ATS adapters and an end-to-end run through a real in-memory MCP client.

## License

MIT
