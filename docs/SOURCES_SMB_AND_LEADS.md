# Startup/SMB ATS sources and aggregator lead sources

This page covers two additions to discovery:

- **Twelve startup/SMB ATS adapters**: BambooHR, JazzHR, Breezy HR, Rippling,
  Gem, Pinpoint, Dover, Teamtailor, Personio, HiBob, Zoho Recruit and
  ClearCompany. They read employer boards into the normal discovery pipeline
  (`add_company_board`, `discover_jobs`, `list_queue`, `explain_job`).
- **Ten aggregator and VC-network lead sources** for `search_job_sources`:
  Built In, Remote OK, Remotive, We Work Remotely, Jobicy, The Muse, Job Bank
  (Canada), Getro boards, Consider boards and Working Nomads. They return
  unverified leads, never stored jobs.

Both are **discovery only**. Nothing here logs in, solves a challenge, bypasses
bot protection or submits an application. Endpoint behaviour was adapted from
[career-ops](https://github.com/career-ops-hq/career-ops) (MIT); the code is our own.

## SMB ATS boards

Every board is a short string read off the employer's careers URL. Verify and
save it with `add_company_board` (postings must really come back before it is
saved), then discover with `discover_jobs`:

```json
{"name":"Acme","ats":"bamboohr","board":"acme","query":"engineer","save":false}
```

A board that is not in the expected shape fails with `invalid_board`, and the
error's `details` name the format and an example, so the fix is a copy and paste.

| ATS (`ats`) | Board format | Example | Read it off | Probed by `resolve_company_board` |
|---|---|---|---|---|
| BambooHR (`bamboohr`) | tenant subdomain | `acme` | `https://acme.bamboohr.com/careers` | yes, `/careers/list` |
| JazzHR (`jazzhr`) | ApplyToJob subdomain | `acme` | `https://acme.applytojob.com/apply` | no (HTML only) |
| Breezy HR (`breezy`) | tenant subdomain | `acme` | `https://acme.breezy.hr/` | yes, `/json` |
| Rippling (`rippling`) | board slug | `acme` | `https://ats.rippling.com/acme/jobs` | yes, listing API |
| Gem (`gem`) | job-board vanity path | `acme` | `https://jobs.gem.com/acme` | yes, Job Board API |
| Pinpoint (`pinpoint`) | tenant subdomain | `acme` | `https://acme.pinpointhq.com/` | yes, `/postings.json` |
| Dover (`dover`) | company slug | `acme` | `https://app.dover.com/apply/acme/<job-id>` | yes, slug lookup |
| Teamtailor (`teamtailor`) | subdomain; `slug.na` for North America | `acme`, `acme.na` | `https://acme.teamtailor.com/jobs`, `https://acme.na.teamtailor.com/jobs` | yes, both regions |
| Personio (`personio`) | subdomain | `acme` | `https://acme.jobs.personio.de/` (or `.com`) | yes, `/search.json` |
| HiBob (`hibob`) | careers-site label, kept exactly | `acme`, `acme-3f2a` | `https://acme.careers.hibob.com/` | no (needs a header) |
| Zoho Recruit (`zohorecruit`) | subdomain; `slug.<dc>` outside `.com` | `acme`, `acme.eu`, `acme.com.au` | `https://acme.zohorecruit.com/jobs/Careers` | no (HTML only) |
| ClearCompany (`clearcompany`) | careers-site `siteId` GUID | `a01e8e2d-0f1d-2586-1830-5910e6e7d498` | `career-site.js?siteId=<GUID>` in the employer careers page source | no (GUID cannot be guessed) |

### Finding boards

- **From a company name.** `resolve_company_board` tries name variants against
  every adapter's `probeUrls`. A probe is one GET that must return JSON, so it
  only exists for hosts with a JSON endpoint (see the last column). Unknown
  tenants answer 404 or redirect to the vendor's marketing site, which counts as
  "not found".
- **From a link.** Use the employer's careers page or an aggregator lead's
  `applyUrl`. A posting link works too: each adapter's `parsePostingUrl`
  understands its own posting URLs (BambooHR `/careers/<id>`, JazzHR
  `/apply/<id>/...`, Breezy `/p/<id>-...`, Rippling `/<board>/jobs/<uuid>`, Gem
  `jobs.gem.com/<board>/<id>`, Pinpoint `/postings/<uuid>`, Dover
  `/apply/<slug>/<uuid>`, Teamtailor `/jobs/<id>-...`, Personio `/job/<id>`,
  HiBob `/jobs/<uuid>`, Zoho `/jobs/Careers/<id>/...`). ClearCompany apply links
  live on the employer's own `<tenant>.clearcompany.com` host, which does not
  carry the `siteId`, so its posting URLs cannot be parsed.
- **HTML-only, header-only and GUID boards** (JazzHR, Zoho Recruit, HiBob,
  ClearCompany) are added from the careers link, never guessed. JazzHR and Zoho
  serve server-rendered HTML; HiBob's JSON requires a `companyidentifier` header
  that `probeJson` does not send; ClearCompany needs the GUID. `verifyBoard`
  (one cheap request) confirms them when `add_company_board` runs.

### What each adapter reads

| ATS | Listing | Per-posting detail |
|---|---|---|
| BambooHR | `/careers/list` (all postings, one request) | `/careers/<id>/detail` for description, date, pay text and country |
| JazzHR | `/apply` job cards (title, location, department) | posting page schema.org JobPosting: description, date, pay, remote flag, closing date |
| Breezy | `/json` position feed (dates, locations with countries, remote flag, salary text) | posting page schema.org JobPosting for the description |
| Rippling | listing API, 100 a page, at most 40 pages | `/jobs/<uuid>` for description, date and pay ranges |
| Gem | documented Job Board API, every post with its description | none needed |
| Pinpoint | `postings.json` with structured compensation; Pinpoint's seeded demo postings are dropped | posting page schema.org data for date and country |
| Dover | slug → client id, then `careers-page/<id>/jobs`, 300 a page, at most 10 pages | application-portal job for description, date and pay; inactive or private jobs are dropped |
| Teamtailor | `jobs.json` feed with descriptions, dates, locations and pay, at most 10 pages | none needed |
| Personio | documented `/xml` feed, or the career site's `search.json` where the feed is disabled | posting page schema.org data for descriptions the feed omits |
| HiBob | career site's `/api/job-ad` JSON (with the tenant header) | none (no single-ad endpoint) |
| Zoho Recruit | `/jobs/Careers` page's embedded job list, parsed as data without running scripts | none needed |
| ClearCompany | careers API, 100 a page, at most 30 pages | `/v1/<siteId>/<jobId>` for `fetchPosting` and `checkPosting` |

### Shared behaviour

- **HTTP.** Every request goes through `src/sources/http.ts`: HTTPS only, the
  honest `autoapply-mcp` user agent, at least `AUTOAPPLY_MIN_INTERVAL_MS`
  (700 ms) between requests to one host, retries on 429/5xx, timeouts and size
  caps. Requests are pinned to the board's host; a redirect elsewhere (the usual
  answer for an unknown tenant) is reported as `not_found`.
- **Caps.** Listing pagination stops when the board is exhausted or a page
  repeats. A board larger than its listing cap fails with `source_limit` rather
  than being cut short silently (Rippling 4,000, Dover 3,000 and ClearCompany
  3,000 postings); Teamtailor stops after 10 feed pages with a warning.
  Boards that need a second request per posting spend at most
  `AUTOAPPLY_SMB_DETAIL_LIMIT` of them (default 100, `0` turns details off,
  maximum 1000). Postings past the cap keep their listing fields and a warning
  is logged. `company.query` is applied before detail requests, so narrowing it
  is the way to keep a large board's details within the cap.
- **One bad posting never loses the board.** A posting that fails to parse is
  skipped with a warning; a failed detail request keeps the listing row.
- **Search.** None of these boards has a keyword search endpoint, so
  `company.query` is matched locally: every term must start a word in the title
  (or department), `"*"` or blank means everything.
- **Normalization.** Everything passes through `normalizeJob`. Published dates
  become absolute UTC timestamps (dates without a zone are read as UTC; relative
  ages are never invented). `country` is set to `US` or `CA` only when the
  posting publishes it and all of its locations agree. Pay is structured only
  from published fields; a missing or ambiguous unit stays `unknown` and is
  never annualized. ClearCompany publishes no currency, so its pay is kept only
  for US or Canadian postings.
- **Liveness.** `checkPosting` answers `open`, `closed` (the ATS says 404/410 or
  marks the posting closed or expired) or `unknown`. Network errors, rate limits,
  403s and 5xx are always `unknown`, never `closed`.
- **Submission.** Applications to these boards are manual packets. The catalog
  marks every entry `discovery-only` / `manual-only`; there is no browser
  integration until one is built and explicit domains and company permission
  are configured.

## Aggregator and VC-network lead sources

`search_job_sources` reads one bounded page from one source:

```json
{"source":"getro","query":"security engineer","site":"jobs.generalcatalyst.com","country":"US","limit":20}
```

Each lead carries `source`, `sourceId`, `sourceUrl`, provenance (`endpoint`,
`retrievedAt`, raw published value) and `mustVerifyEmployer: true`. Results
carry the source's `attribution` (label, link and requirements) and
`limitations`. Where the source publishes the employer's own ATS link it is the
lead's `applyUrl`; the tool derives an unverified `boardCandidate` from it for
`add_company_board`. Salary is kept only with the units the source states.
Leads are never inserted as jobs and never grant application permission.

A filter a source cannot honour is rejected with `source_filter_unsupported`
before any request; it is never silently ignored.

| Source (`source`) | Endpoint | Filters | Pages | Spacing / cache | `applyUrl` |
|---|---|---|---|---|---|
| Built In (`builtin`) | server-rendered listing page | `category` (required), `site` (market), `location` (`remote`/`hybrid`), `company` | 1-3, 25 a page | 2 s / 15 min | — (Built In job page only) |
| Remote OK (`remoteok`) | `remoteok.com/api` (~100 newest) | `country`, `location`, `company` (local) | local | 700 ms / 15 min | listing's apply link |
| Remotive (`remotive`) | `remotive.com/api/remote-jobs` | `category`, `company` (server); `country`, `location` (local) | local | 30 s / 6 h | — |
| We Work Remotely (`weworkremotely`) | RSS: all jobs or `category` feed slug | `country`, `location`, `company` (local) | local | 700 ms / 60 min | — |
| Jobicy (`jobicy`) | `jobicy.com/api/jobs` | `country` (geo slug), `category` (industry slug), `company` (local) | cursor, ≤ 5, 50 a page | 700 ms / 10 min | Jobicy job URL (their terms) |
| The Muse (`themuse`) | `themuse.com/api/public/jobs` | query must be a Muse category; `location`, `company` | 20 a page | 700 ms / 10 min | — |
| Job Bank (`jobbankca`) | public Atom search feed | `location`; `country` must be Canada | 100 a page | 5 s / 30 min | — |
| Getro (`getro`) | `api.getro.com` collection search | `site` (required), `country`/`location` | 20 a page | 700 ms / 10 min | employer ATS link |
| Consider (`consider`) | board `/api-boards/search-jobs` | `site` (required), `location` (`remote` = remote only), `country` | cursor, ≤ 5, 50 a page | 700 ms / 10 min | employer ATS link |
| Working Nomads (`workingnomads`) | `workingnomads.com/api/exposed_jobs/` (~30 newest) | `category`, `country`, `location`, `company` (local) | local | 700 ms / 15 min | — |

"Local" filters run over the cached feed. Locally paged sources report totals of
the filtered list; cursor and feed sources report `pagination.total` as a lower
bound. A truncated page sets `truncated` and `nextPageLimit`.

### Choosing values

- **Built In `category`**: `artificial-intelligence`, `content`,
  `customer-success`, `cybersecurity-it`, `data-analytics`, `design-ux`,
  `dev-engineering`, `finance`, `hr`, `legal`, `marketing`, `operations`,
  `product`, `project-management`, `sales`. **`site`**: `builtin.com` (default),
  `www.builtinsf.com`, `www.builtinnyc.com`, `www.builtinla.com`,
  `www.builtinboston.com`, `www.builtinaustin.com`, `www.builtinchicago.org`,
  `www.builtincolorado.com`, `www.builtinseattle.com`.
- **We Work Remotely `category`**: a feed slug from its RSS page, e.g.
  `remote-back-end-programming-jobs`.
- **Jobicy**: `country` `US`/`CA` map to `usa`/`canada`; other values are used as
  Jobicy geo slugs (`europe`, `uk`, ...). `category` is an industry slug such as
  `engineering`.
- **The Muse**: the API has no keyword search, so `query` must be one of its
  categories, e.g. `Software Engineering`, `Data Science`, `Product Management`;
  `location` uses its names (`San Francisco, CA`, `Flexible / Remote`).
- **Getro `site`**: `jobs.generalcatalyst.com`, `jobs.accel.com`,
  `jobs.insightpartners.com`, `techjobfinder.investottawa.ca`, `hv.getro.com`,
  `talent.cherry.vc`, `careers.atomico.com`, `jobs.pointnine.com`,
  `jobs.earlybird.com`, `careers.speedinvest.com`; any `<name>.getro.com` board
  (its collection id is read once from the board page); or a numeric Getro
  collection id.
- **Consider `site`**: `jobs.sequoiacap.com`, `jobs.lsvp.com`,
  `jobs.kleinerperkins.com`, `jobs.bvp.com`, `jobs.felicis.com`,
  `jobs.founderful.com`. The a16z board is neither Getro nor Consider; use
  `scan_source_page` for it.

Network lists live in `src/sources/leads/networks.ts`. Only listed hosts (and
`*.getro.com` boards) are contacted, so `site` can never point a request at an
arbitrary server; add a network there after confirming its platform.

### Terms, attribution and rate limits

Each result repeats its source's requirements in `attribution.requirements`.
Honour them wherever leads are shown, and do not republish listings.

- **Remote OK**: link back to the Remote OK listing with a followed link (no
  `nofollow`) and name Remote OK as the source; no logo without permission.
  robots.txt signals `ai-train=no`: use listings for search, never training.
- **Remotive**: link back and name Remotive; do not submit its jobs to
  third-party job sites or use them to collect sign-ups. It blocks more than two
  requests a minute and advises a few fetches a day, hence the 30 s spacing and
  6-hour cache. Listings appear with a 24-hour delay.
- **We Work Remotely**: feeds may be used with a link back to WWR. The feed TTL
  is 60 minutes. Its HTML pages sit behind a bot challenge, which is not touched.
- **Jobicy**: credit Jobicy with a direct link and send applications through the
  Jobicy job URL, which is why `applyUrl` is the Jobicy URL. Covers the last
  seven days only.
- **The Muse**: 500 requests an hour without a key, meant for testing; register
  an app and set `AUTOAPPLY_THEMUSE_API_KEY` for ongoing use. The key is sent as
  the documented `api_key` parameter and never appears in results, provenance or
  errors.
- **Job Bank**: Job Bank's job-seeker terms prohibit automated access to its
  services, so `jobbankca` is **off by default**: searches fail with
  `source_restricted` until it is named in `AUTOAPPLY_ENABLE_RESTRICTED_SOURCES`.
  Once enabled it reads only the anonymous public Atom feed, one page per explicit
  request, 5 s apart (its robots.txt crawl delay). Every posting must be opened
  and verified by a person; never automate sign-in, Job Match or applications.
  Attribute to Job Bank, Government of Canada, without implying endorsement.
- **Built In**: Built In's Community Terms prohibit accessing or copying the site
  with bots or scrapers, so `builtin` is **off by default** in the same way.
  Once enabled the connector builds only robots.txt-permitted URLs
  (category pages and path-based keyword pages, never `?search=`, pages 1-3),
  reads one page per explicit request, never crawls, and returns links for a
  person to open. Do not use it for bulk collection.

Enabling either source is the candidate's decision to accept that site's terms
risk, for example `AUTOAPPLY_ENABLE_RESTRICTED_SOURCES=builtin,jobbankca`.
`list_sources` reports them as `opt-in-required` until then, and `opted-in` after.
- **Getro and Consider boards**: credit the network's board and link to it.
  Results carry no description; read the employer posting via `applyUrl`.
  Consider's search accepts only requests carrying the anonymous session cookie
  and CSRF token its board page gives every visitor, so each search first loads
  that page once. Because `http.ts` returns bodies but not response headers,
  that single page request is made in `src/sources/leads/boardSession.ts` with
  the same safeguards (host allowlist, HTTPS and per-redirect checks, user
  agent, timeout, size cap, 700 ms per-host spacing); the search itself goes
  through `http.ts`.
- **Working Nomads**: an undocumented public feed of recent jobs; credit Working
  Nomads and do not republish. Its listing links are redirects and are never
  followed.

## Configuration

| Variable | Default | Effect |
|---|---|---|
| `AUTOAPPLY_SMB_DETAIL_LIMIT` | `100` | Per-board cap on per-posting detail requests for SMB adapters (`0` disables, max 1000). |
| `AUTOAPPLY_THEMUSE_API_KEY` | unset | The Muse API key for use beyond testing; never returned. |
| `AUTOAPPLY_MIN_INTERVAL_MS` | `700` | Minimum spacing between requests to one host (shared with all sources). |
