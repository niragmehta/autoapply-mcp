# Sourcing companies and leads

Discovery reads the boards in `companies.json`. Sourcing finds the companies
that should be in it. Every source here produces **leads** - evidence that a
company is hiring - and a lead never becomes an application on its own: its
company is resolved to a verified ATS board, the candidate accepts the board,
and only then does `discover_jobs` read its postings through the usual gates.

```
LinkedIn alerts ─┐
Funding news ────┼─> leads ─> propose_companies ─> accept_company_proposals ─> companies.json ─> discover_jobs
Common Crawl ────┘
```

Leads live in the `leads` table, unique by `(source, source_id)`, so importing
the same alert or feed twice adds nothing. Status is `new`, `resolved` (its
board is in companies.json) or `ignored`. Lead titles, companies and places come
from third-party emails and feeds and are treated as data.

## LinkedIn job alerts

LinkedIn emails job alerts with links to `linkedin.com/jobs/view/<id>`, usually
wrapped in tracking redirects. The posting id is read through LinkedIn's own
`/comm/` links, `currentJobId` parameters, Outlook safe links and Google
redirects, and each posting is stored with source `linkedin-alert` and the
canonical `https://www.linkedin.com/jobs/view/<id>` link. Titles, companies and
places are read from the text around each link. Nothing ever visits LinkedIn.

- **Paste:** `import_job_alert {text}` or `{html}` - the whole alert email, as
  HTML or plain text.
- **Mailbox:** `scan_alert_inbox {lookbackDays}` reads alerts from the mailbox
  configured for verification codes (`AUTOAPPLY_OTP_IMAP_USER`,
  `AUTOAPPLY_OTP_IMAP_PASSWORD`, `AUTOAPPLY_OTP_IMAP_HOST`,
  `AUTOAPPLY_OTP_MAILBOX`). Forward LinkedIn alerts to that mailbox. Only
  messages from LinkedIn's job-alert senders are read; folders are opened
  read-only and bodies fetched with `BODY.PEEK`, so nothing is marked as read.
  Message bodies are never logged.

## Recently funded companies

`fetch_funded_companies {sources, months, limit}` reads public, unauthenticated
feeds from a fixed allowlist - each feed's host is enforced on every redirect,
and nothing behind a login is fetched. Headlines are parsed conservatively
("Acme raises $40M Series B", "Example Ventures leads $8M round in Acme",
"... raise $6M for compliance startup Acme"); acquisitions, layoffs, venture
funds, grants and advice columns are dropped. Each company becomes one lead
(source `funded`) carrying the round, amount, date and the announcement's link.

| Source | Feed | Default |
|---|---|---|
| `techcrunch` | techcrunch.com feed, startups and funding feeds | yes |
| `crunchbase` | news.crunchbase.com feed | yes |
| `siliconangle` | siliconangle.com feed | yes |
| `hn` | Hacker News search API (hn.algolia.com); the discussion page is stored, not the article | yes |
| `betakit` | betakit.com feed (Canada) | no |
| `geekwire` | geekwire.com feed (Pacific Northwest) | no |
| `prnewswire` | PR Newswire venture-capital feed | no |
| `guardian` | The Guardian technology feed | no |

These are the feeds career-ops' `company-funded.mjs` reads, plus Crunchbase
News, BetaKit and GeekWire; all were checked live on 2026-11-06. The response
shows each feed's health, so a feed that changes shape is visible rather than
silently empty.

## Proposals

`propose_companies {limit}` takes companies named in `new` leads that are not in
`companies.json` (nor excluded by `campaign.exclusions.companies` or the
hygiene blacklist) and finds a board for each:

1. a board the lead already names - an ATS posting URL, or the board a harvest
   scan recorded;
2. otherwise `resolveBoards`, which probes the supported ATS APIs with slug
   variants of the name (the same search as `resolve_company_board`).

Every candidate board is checked with `verifyBoard` and only boards that serve
postings are proposed. Companies with no findable board are remembered and not
probed again for 14 days. Leads of companies already tracked are marked
resolved. Nothing is written to companies.json.

`accept_company_proposals {proposals}` saves the boards the candidate accepted,
with tier `C` and tag `proposed`. Each board is verified again, an existing
company entry is never replaced, and the matching leads are marked resolved.
Saving a board never permits submission: that remains
`submission.allowedCompanies`.

## Board harvesting from Common Crawl

Common Crawl publishes an index of every URL each crawl captured. Querying it
for ATS hosts lists thousands of public boards no curated list contains.

```bash
npm run harvest -- --ats greenhouse --indexes 2 --scan
```

| Option | Meaning |
|---|---|
| `--ats` | `greenhouse,ashby,lever,workday` (default: all four) |
| `--indexes n` | the newest n crawl indexes, from `index.commoncrawl.org/collinfo.json` (default 1) |
| `--index ids` | explicit index ids, e.g. `CC-MAIN-2026-43` |
| `--max-pages n` | cap the pages read per host query |
| `--scan` | scan the harvested boards afterwards |
| `--scan-only` | scan without harvesting |
| `--limit n` | boards to scan in this run (default 50) |
| `--rescan-days n` | also rescan boards last scanned more than n days ago |
| `--status` | print what has been harvested, then exit |

**Harvest.** For each index and host (`job-boards.greenhouse.io/*`,
`boards.greenhouse.io/*`, `jobs.ashbyhq.com/*`, `jobs.lever.co/*`,
`jobs.eu.lever.co/*`, and the `myworkdayjobs.com` domain) the CDX API is read
page by page. The index server is shared and often overloaded, so 502, 503,
504 and 429 answers are retried with a doubling delay (10 s up to 60 s), and
pages are fetched one at a time with a pause between. Board slugs are taken
from the URLs (Workday as `tenant/datacenter/site`, keeping the most-cited site
per tenant), and anything already in `companies.json` or harvested before is
dropped. New boards are stored in `harvested_boards` as each page is read, so
a cancelled run (Ctrl+C) keeps what it found.

**Scan.** Each harvested board is fetched through the regular adapters and its
postings are run through the campaign's gates and scoring in memory - nothing
is stored in the jobs table. Workday boards are searched with the tracks' title
phrases and only titles that could pass the gates cost a detail request. Each
board is recorded as `matching`, `no-match`, `empty`, `dead`, `error` or
`tracked`; a matching board also becomes a `common-crawl` lead naming its
board, which `propose_companies` then offers.

A harvest reads tens of pages and can take an hour, which is longer than any
MCP tool call may run. It is started from a terminal or the run queue;
`harvest_status` reports the results to the agent.

For the run queue, the same work is exported as services that take a progress
callback and an `AbortSignal`:

```ts
harvestBoards({ db, companies, ats, indexes }, onProgress, signal)        // src/sourcing/commonCrawl.ts
scanHarvestedBoards(workspace, { ats, limit, rescanAfterDays }, onProgress, signal) // src/sourcing/boardScan.ts
```

## Tools

| Tool | Does |
|---|---|
| `import_job_alert` | Stores the postings in a pasted LinkedIn alert as leads |
| `scan_alert_inbox` | Reads LinkedIn alerts from the configured mailbox, read-only |
| `fetch_funded_companies` | Stores recently funded companies from the allowlisted feeds |
| `list_leads` | Lists leads with counts per source and status |
| `propose_companies` | Proposes verified boards for companies seen in leads; writes nothing |
| `accept_company_proposals` | Saves accepted boards to companies.json with tag `proposed` |
| `harvest_status` | Harvested boards by status, matching boards and recent runs |
