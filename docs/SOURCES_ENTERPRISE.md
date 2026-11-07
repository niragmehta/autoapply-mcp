# Enterprise ATS sources

Twelve adapters discover postings on the applicant-tracking systems large US
employers use: Oracle Recruiting Cloud, iCIMS, SAP SuccessFactors, Phenom,
Eightfold, Taleo, Jobvite, UKG Pro (UltiPro), Avature, Cornerstone OnDemand,
Paylocity and ADP Workforce Now.

They are **discovery only**. Postings are fetched, gated, scored and explained
like any other board; applications are prepared as manual packets for a person
to submit. Nothing here logs in, solves a challenge or submits anything.
Endpoint behaviour was adapted from [career-ops](https://github.com/career-ops-hq/career-ops) (MIT).

## Adding a board

Every board is a short string read off the employer's careers URL. Add it with
`add_company_board` (which verifies that postings really come back before
saving) and discover with `discover_jobs`:

```json
{"name":"JPMorgan Chase","ats":"oraclecloud","board":"jpmc.fa.oraclecloud.com/CX_1002","query":"software engineer","save":false}
```

Pasting a careers URL as the board is rejected with an `invalid_board` error
that names the board string the URL points at, so the fix is a copy and paste.

| ATS (`ats`) | Board format | Example | Read it off |
|---|---|---|---|
| Oracle Recruiting Cloud (`oraclecloud`) | `host/siteNumber` | `jpmc.fa.oraclecloud.com/CX_1002` | `https://jpmc.fa.oraclecloud.com/hcmUI/CandidateExperience/en/sites/CX_1002/jobs` |
| iCIMS (`icims`) | portal host, or a bare tenant for `careers-<tenant>.icims.com` | `careers-gdms.icims.com` | `https://careers-gdms.icims.com/jobs/search?ss=1` |
| SAP SuccessFactors (`successfactors`) | career-site host, plus a brand path if any | `jobs.zf.com` | `https://jobs.zf.com/search/` |
| Phenom (`phenom`) | `host/country/language` | `careers.mastercard.com/us/en` | `https://careers.mastercard.com/us/en/search-results` |
| Eightfold (`eightfold`) | `tenant` or `tenant/domain` (a host with dots is used as written) | `qualcomm/qualcomm.com` | `https://qualcomm.eightfold.ai/careers?domain=qualcomm.com` |
| Taleo Enterprise (`taleo`) | `host/careersection` | `hdr.taleo.net/ex` | `https://hdr.taleo.net/careersection/ex/jobsearch.ftl` |
| Jobvite (`jobvite`) | vanity slug | `tylertech` | `https://jobs.jobvite.com/tylertech/jobs` |
| UKG Pro (`ultipro`) | `host/tenant/boardId` | `recruiting.ultipro.com/MIC1014MICS/aba7ab7f-e037-4961-b6cf-c1491e2105e0` | `https://recruiting.ultipro.com/MIC1014MICS/JobBoard/aba7ab7f-…/` |
| Avature (`avature`) | `host/site path` (bare tenant → `<tenant>.avature.net/careers`) | `bloomberg.avature.net/careers` | `https://bloomberg.avature.net/careers/SearchJobs` |
| Cornerstone (`csod`) | `host/siteId`, plus `/corp` when `c=` differs from the host's first label | `cornerstone.csod.com/2` | `https://cornerstone.csod.com/ux/ats/careersite/2/home?c=cornerstone` |
| Paylocity (`paylocity`) | board GUID | `a432d829-f701-4cf3-9108-56ef703b2ac5` | `https://recruiting.paylocity.com/Recruiting/Jobs/All/<guid>` |
| ADP Workforce Now (`adp`) | `cid`, plus `/ccId` when the URL has one | `1774d0ee-6390-4d36-9333-1f675e3b3058` | `https://workforcenow.adp.com/mascsr/default/mdf/recruitment/recruitment.html?cid=…&ccId=…` |

## Shared behaviour

- **HTTP.** Every request goes through `src/sources/http.ts`: HTTPS only, the
  honest `autoapply-mcp` user agent, at least `AUTOAPPLY_MIN_INTERVAL_MS`
  (700 ms) between requests to one host, two retries on 429/5xx, timeouts and
  a size cap. Requests are pinned to the board's own host; a redirect off it
  fails the request.
- **Caps.** A board returns at most `AUTOAPPLY_<ATS>_MAX_POSTINGS` postings
  (default 500) and spends at most `AUTOAPPLY_<ATS>_MAX_DETAILS` requests
  (default 100, `0` turns them off) on per-posting descriptions the listing
  lacks. `<ATS>` is the `ats` value upper-cased: `ORACLECLOUD`, `ICIMS`,
  `SUCCESSFACTORS`, `PHENOM`, `EIGHTFOLD`, `TALEO`, `JOBVITE`, `ULTIPRO`,
  `AVATURE`, `CSOD`, `PAYLOCITY`, `ADP`. Postings past the detail cap keep the
  listing's fields (often a teaser and no date). Prefer narrowing with
  `company.query` over raising the caps; boards list newest first where the
  ATS allows it, so the freshest postings get descriptions.
- **Search.** `company.query` is sent as the ATS's own keyword search where one
  exists (Oracle `keyword`, iCIMS `searchKeyword`, SuccessFactors `q`, Phenom
  `keywords`, Eightfold `query`, Taleo `KEYWORD`, UKG `QueryString`, Avature
  `search`, Cornerstone `searchText`). Jobvite, Paylocity and ADP have none,
  so the query is ignored there.
- **Pagination** stops at the published total, an empty page, a page that
  repeats rows already seen (an ignored offset), or the cap. A source that
  rate-limits (HTTP 429 after retries) a later page ends the walk with the
  pages already read, and a 429 on a description stops further description
  requests for that board.
- **Resilience.** One malformed row, failed description or unreadable page
  never loses the rest of the board: the row is skipped or keeps its listing
  fields, and a warning is logged. A posting the ATS reports gone between the
  listing and the description request is dropped.
- **Normalization.** Every job goes through `normalizeJob`: the URL and apply
  URL are the human posting page, dates are absolute ISO instants (date-only
  values at UTC midnight), structured pay is kept as `ats-structured`, and
  otherwise pay is parsed from the description. `country` is passed only when
  the ATS publishes one country for the whole posting. Structured addresses
  outside the US and Canada drop their region, so Tamil Nadu's "TN" never
  reads as Tennessee.
- **Liveness.** `checkPosting` answers `open`, `closed` or `unknown`. Closed
  needs the ATS's own word (a removed-posting page, a 404/410 from a
  single-posting endpoint, a closed flag, an ended posting window); network
  errors, challenges, blocked or unrecognised pages are always `unknown`. A
  stored posting id that does not match the ATS's id format is also `unknown`
  (never sent), and `fetchPosting` rejects it with `invalid_posting_id`.
  SuccessFactors and Avature check the stored posting URL instead, and only
  when it is a job page on the board's own host.
- **Pasted URLs.** `parsePostingUrl` recognises posting URLs (below) and
  `fetchPosting` reads one posting without the board being configured.
- **Probing.** `probeUrls` guesses listings only where a slug maps to one:
  iCIMS (`careers-<slug>.icims.com`), Avature (`<slug>.avature.net/careers`),
  Jobvite (`jobs.jobvite.com/<slug>/jobs`) and Eightfold (classic API, and PCSX
  with the guessed domain `<slug>.com`). The first three are HTML pages, so
  they only resolve once board probing accepts non-JSON responses.

## Per ATS

### Oracle Recruiting Cloud

- **Fetches** the public `recruitingCEJobRequisitions` REST finder, 200 per
  page, newest first, until `TotalJobsCount` (short pages occur mid-list and
  do not end the walk), then `recruitingCEJobRequisitionDetails` per posting
  for the description, responsibilities, qualifications, the posting window,
  the schedule and pay flex fields ("Base Pay/Salary: …").
- **Country** from `PrimaryLocationCountry` and secondary locations.
- **Liveness:** the detail finder returning nothing, or an ended posting
  window, is closed.
- **Posting URLs:** `…/CandidateExperience/<lang>/sites/<site>/job/<id>` and
  `…/requisitions/preview/<id>`.
- **Limits:** some tenants front the API with a WAF that refuses cloud and
  datacenter addresses. Branded hosts that proxy Oracle are not accepted.

### iCIMS

- **Fetches** the portal's search pages (`/jobs/search?ss=1&in_iframe=1&pr=N`,
  20 cards per page, until the pager's last page) for title, location
  ("US-MN-Bloomington" rewritten as "Bloomington, MN, United States"), posted
  date and header fields such as "Combined Salary Range", then each posting
  page's schema.org `JobPosting` for description, posting date, address,
  employment type and any `baseSalary`.
- **Liveness:** 404/410, the portal's "job could not be found" page, or a
  passed `validThrough` is closed.
- **Posting URLs:** `https://<portal>.icims.com/jobs/<id>/<slug>/job`.
- **Limits:** no anonymous API; portal themes vary, so card fields are read by
  label. Card identifiers ("ID: 2026-79192") are left out of the description.

### SAP SuccessFactors

- **Fetches** the Recruiting Marketing tile fragment
  (`/tile-search-results/?q=…&sortColumn=referencedate&sortDirection=desc&startrow=N`,
  25–100 tiles per page by tenant). Tiles give title and path, and city or
  date only when the tenant shows them; otherwise the city is recovered from
  the job slug. Descriptions, dates and addresses come from each job page's
  JSON-LD or `JobPosting` microdata.
- **Career Site Builder** sites answer the tile endpoint with an empty shell;
  the adapter then reads `POST /services/recruiting/v1/jobs` in the en_US
  locale (10 per page). Those job pages render in the browser, so CSB
  postings carry no description, and an open CSB posting is confirmed by
  finding it in a title search (otherwise `unknown`).
- **Liveness:** a job page that redirects to `/errorpage/`, or 404/410, is
  closed.
- **Posting URLs:** `https://<host>[/<brand>]/job/<slug>/<numeric id>/`.
- **Limits:** sites behind a Cloudflare challenge (jobs.sap.com) cannot be read
  and are not worked around; CSB postings outside en_US are not listed.

### Phenom

- **Fetches** the site's public widget API (`POST /widgets`): `refineSearch`
  100 per page by offset with the board's locale (`us/en` is `lang: en_us`,
  `country: us`), then `jobDetail` per posting for the description and its
  schema.org data.
- **Country** only for single-location postings.
- **Liveness:** `jobDetail` with zero hits, or a passed posting end date, is
  closed.
- **Posting URLs:** `https://<host>/<country>/<language>/job/<jobId>[/<slug>]`.
- **Limits:** a `jobDetail` response is large (about 300 KB with ML fields).
  Many tenants apply on another ATS (often Workday), linked from the posting.

### Eightfold

- **Fetches** the newer PCSX search (`/api/pcsx/search`) or, when a tenant
  answers 403 there, the classic `/api/apply/v2/jobs`; both return ten
  postings per request. Descriptions come from `/api/pcsx/position_details`
  (or `/api/apply/v2/jobs/<id>`). PCSX requires the employer domain; without
  one in the board it is read once from the careers page (`_EF_GROUP_ID`).
- **Country** from the standardized "City, ST, US" locations.
- **Liveness:** 404 "Position not found" is closed.
- **Posting URLs:** `https://<tenant>.eightfold.ai/careers/job/<id>`,
  `…/careers?pid=<id>`, and `/careers/job/<id>` on branded hosts.
- **Limits:** strict rate limits. Requests use twice the usual spacing, and a
  429 ends the listing with the pages already read. The classic API path is
  implemented from documented shapes; no classic tenant was reachable to
  verify it live.

### Taleo Enterprise

- **Fetches** the section's `jobsearch.ftl` page for its portal number and
  column headings, then replays the page's anonymous
  `POST /careersection/rest/jobboard/searchjobs` (25 per page, by page number,
  until `totalCount`; pages can be uneven). Job pages
  (`jobdetail.ftl?job=<number>`) keep the description, locations, posting date
  and job type in the `initialHistory` form field, which is decoded field by
  field.
- **Liveness:** a job page with its description is open; "The job is no
  longer available" is closed.
- **Posting URLs:** `https://<host>.taleo.net/careersection/<section>/jobdetail.ftl?job=<number>`.
- **Limits:** Taleo Business Edition (`*.tbe.taleo.net`) is a different
  product and is not supported. Private sections without a public portal are
  refused. "Multiple Locations" rows learn their places only from the job page.

### Jobvite

- **Fetches** `jobs.jobvite.com/<slug>/jobs`, which lists every posting and
  embeds the company id, then the company XML feed
  (`app.jobvite.com/CompanyJobs/Xml.aspx?c=<id>`) with every description,
  date, location and the structured salary fields. Multi-location rows are
  merged into one posting. Board and posting pages are requested with
  `nl=1&fr=true`, without which tenants that have their own careers site
  (Imprivata, for one) redirect off jobs.jobvite.com.
- **Fallback:** the feed host rate-limits hard (429 with `Retry-After: 30`);
  when the feed fails the adapter reads posting pages from the list instead,
  up to the detail cap, without posting dates.
- **Liveness:** the posting page is open; Jobvite's "The job listing no longer
  exists" page (a 303 to the list) is closed.
- **Posting URLs:** `https://jobs.jobvite.com/<slug>/job/<id>`. Feed links on
  `app.jobvite.com` do not name the slug and are not recognised.
- **Limits:** no keyword search; a large feed is about 2 MB.

### UKG Pro Recruiting (UltiPro)

- **Fetches** `POST …/JobBoardView/LoadSearchResults` (50 per page, newest
  first) and each opportunity page, whose embedded
  `CandidateOpportunityDetail` record carries the description, explicit annual
  or hourly pay, the visible pay range and `OpportunityIsClosed`. Hosts are
  kept as written: `recruiting[N].ultipro.com`, `recruiting.ultipro.ca` and
  `<name>.rec.pro.ukg.net`.
- **Liveness:** the record's closed flag decides; the "not available", "not
  found" and "internal candidates only" notices are closed.
- **Posting URLs:** `…/<tenant>/JobBoard/<boardId>/OpportunityDetail?opportunityId=<id>`.
- **Limits:** UKG's numeric on-site/remote/hybrid code is not published with
  labels, so it is not mapped; remote work is read from location text.

### Avature

- **Fetches** `/<site>/SearchJobs/?search=…&jobOffset=N` (page size per
  tenant, 6–12), switching to a bare `offset` parameter on tenants that ignore
  `jobOffset`, until the results legend's total; then each JobDetail page.
- **Liveness:** a JobDetail page is open; a redirect to the portal's Error page
  (404) is closed.
- **Posting URLs:** `…/<site>/JobDetail/<slug>/<id>` and `…/JobDetail?jobId=<id>`
  on any host.
- **Limits:** card markup varies by theme; many tenants show no posting date.

### Cornerstone OnDemand

- **Fetches** the career site's home page for the anonymous bearer token it
  boots with (reused for ten minutes, never logged), then
  `POST /services/x/career-site/v1/search` (25 per page) and
  `GET /services/x/job-requisition/v2/requisitions/<id>/jobDetails`.
- **Liveness:** `GET /services/x/career-site/v1/requisition/<id>` lists where
  the requisition is posted; posted on this site inside its window is open,
  anything else (or a 404 from job details) is closed.
- **Posting URLs:** `https://<tenant>.csod.com/ux/ats/careersite/<site>/home/requisition/<id>?c=<corp>`.
- **Limits:** some tenants also require the session cookies the home page sets,
  which the shared HTTP client does not carry; those boards fail with 401
  rather than returning partial data.

### Paylocity

- **Fetches** the board page, whose `window.pageData` script holds every
  posting (one request, internal postings skipped), then each posting's
  Details page for the description.
- **Liveness:** the Details page is open; a redirect to "Job Not Found" is
  closed.
- **Limits:** no keyword search. A Details URL does not name its board, so
  there is no `parsePostingUrl`; configure the board first. The structured
  country is not used because it is often the tenant's default rather than the
  posting's.

### ADP Workforce Now

- **Fetches** the public staffing API (`…/staffing/v1/job-requisitions`, 20 per
  page with a one-based `$skip`), with titles, locations, posting dates and any
  published pay grade (period from the `SalaryType` field), then each
  requisition's detail for the description. Posting URLs carry the public
  `ExternalJobID`.
- **Liveness:** the detail endpoint answering an empty object is closed.
- **Posting URLs:** `recruitment.html?cid=…[&ccId=…]&jobId=…` (or `jwId=`);
  `fetchPosting` accepts either ADP's item id or the public job number, which
  it finds through the listing.
- **Limits:** no keyword search.

## Live verification (November 2026)

| ATS | Board verified | Postings seen |
|---|---|---|
| oraclecloud | `jpmc.fa.oraclecloud.com/CX_1002` | 7,142 (1,584 for "software engineer") |
| icims | `careers-gdms.icims.com` | about 400 for "software" (20 pages of 20) |
| successfactors | `jobs.zf.com`; CSB path on `jobs.bmwgroup.com` | 474 for "software engineer"; 215 in en_US |
| phenom | `careers.mastercard.com/us/en` | 954 (374 for "software engineer") |
| eightfold | `micron` (domain read from the careers page); `qualcomm/qualcomm.com` | 1,614 for "software engineer"; 2,074 total |
| taleo | `hdr.taleo.net/ex` | 2,319 (1,086 for "software") |
| jobvite | `tylertech` | 128 postings (290 feed rows) |
| ultipro | `recruiting.ultipro.com/MIC1014MICS/aba7ab7f-e037-4961-b6cf-c1491e2105e0` | 37 |
| avature | `bloomberg.avature.net/careers` | 326 (103 for "software") |
| csod | `cornerstone.csod.com/2` | 129 |
| paylocity | `a432d829-f701-4cf3-9108-56ef703b2ac5` | 40 |
| adp | `1774d0ee-6390-4d36-9333-1f675e3b3058` | 32 |
