# Listing sources

`list_sources` is the permanent, code-backed catalog. It distinguishes employer
ATS adapters, aggregate job leads, community threads and public lead pages.
Installing new discovery support does not change `campaign.json`, employer
permissions, pay/location gates or application approvals.
Restart the registered MCP server after building to load new tool definitions;
`reload_config` rereads personal configuration, not running JavaScript modules.

## Employer boards

All seven ATS kinds use the existing `add_company_board`, `discover_jobs`,
`list_queue` and `explain_job` workflow. `add_company_board` verifies actual
postings before saving a board; pass `save:false` for verification only.

| ATS | Board token | Source |
|---|---|---|
| Greenhouse | Employer board token | Public Job Board API |
| Lever | Employer slug and global/EU region | Public Postings API |
| Ashby | Employer board name | Public job-board API |
| Workday | `tenant/datacenter/site` from the real careers URL | Public tenant listings and details |
| SmartRecruiters | Employer identifier, preserving case, e.g. `ServiceNow` | Public company Posting API |
| Workable | Employer slug, e.g. `rokt` | Public account feed with `details=true`, not employer SPI credentials |
| Recruitee | Employer subdomain, e.g. `aikidosecurity` | Company XML `/api/feeds/offers.xml` |

Example discovery, not submission:

```json
{"name":"ServiceNow","ats":"smartrecruiters","board":"ServiceNow","query":"security","save":false}
```

After deciding to save the verified board, use `save:true`, then
`discover_jobs {"companies":["ServiceNow"]}`. `query` narrows SmartRecruiters and
Workday requests. Prefer it for large boards: SmartRecruiters list pages need
detail requests for complete descriptions and salary evidence.

SmartRecruiters, Workable and Recruitee **do not have browser submission
integrations**. Their assisted/auto calls fail with `ats_browser_not_supported`,
even if a domain has been explicitly allowlisted. Manual packets still require
the normal approval, resume, destination and pacing guards.

## Aggregate leads

```json
{"source":"himalayas","query":"product security engineer","country":"US","limit":20,"page":1}
```

Call this with `search_job_sources`. It fetches one bounded page, returns source
identity, original publication dates, raw salary units, location/time-zone
restrictions, attribution and continuation metadata. It does not insert jobs,
prepare applications or follow outbound application links. Descriptions are
wrapped as untrusted content. Recognized ATS links include an unverified
`boardCandidate` to use with the employer-board workflow.

| Source | Access | Filters and caveats |
|---|---|---|
| [Himalayas](https://himalayas.app/api) | Public, no key | `query`, `country`, `company` slug, `page`. No city `location` filter. Search pages differ from its cursor-based browse API. |
| [Foorilla](https://foorilla.com/api/llms.txt) | Existing PRO+ account and `AUTOAPPLY_FOORILLA_API_KEY` | `query` (title), `location`, `company`, `page`. Textual/ISO `country` is not supported by this connector. |

The tool's limit is 1-100 (default 20). If a provider page contains more results
than requested, `pagination.truncated` and `remainingOnPage` explain that
`nextPage` repeats the same page; use `nextPageLimit` before advancing. Otherwise
`nextPage` identifies the next page. Never infer that a limited page covers the
entire source.

Foorilla readiness reports key presence, not verified subscription access.
Missing or unauthorized credentials produce `source_auth_required`. Its
documented jobs schema lacks a description and pay period; those fields are not
invented. Estimated/converted salary fields are excluded. No subscription,
login or purchase is performed.

## Portfolio and regional lead pages

```json
{"source":"a16z","url":"https://jobs.a16z.com/jobs","limit":30}
```

Call this with `scan_source_page`. Supported source IDs are `a16z`, `sequoia`,
`yc` and `builtinsf`. The optional URL must be on the selected catalog entry's
HTTPS origin. Only one page is read, and employer links are not visited. Results
include ATS tokens, regional identity and provenance, not inferred company
names, salaries or application permission.

| Source | Useful for |
|---|---|
| [a16z](https://jobs.a16z.com/jobs) | AI/security/platform portfolio employers and outbound ATS links |
| [Sequoia](https://jobs.sequoiacap.com/jobs) | Portfolio employers across different ATS platforms |
| [YC Work at a Startup](https://www.workatastartup.com/jobs) | Startup leads; applying through YC requires an account |
| [Built In SF](https://www.builtinsf.com/jobs) | Regional discovery; verify actual employer geography and published pay |

These pages are not anonymous bulk APIs. Some render their links in JavaScript
or use custom employer pages. An empty scan explicitly warns that browser or
manual follow-up may be needed; it is **not** a claim that no jobs exist.
Respect source terms and access controls; there is no login or anti-bot bypass.
The existing `scan_hiring_thread` now recognizes the same supported ATS link
shapes, including regional Lever boards.

## Provenance, access and limits

- Employer ATS data enters the normal normalization, deduplication, eligibility
  and scoring pipeline. Aggregator and portfolio metadata does not.
- Verify employer-owned salary and primary job locations. A shared headquarters
  tag is not proof of a Bay Area vacancy; missing salary on another city's
  posting is not permission to bypass a published Bay Area salary.
- Unknown salary periods stay unknown; neither employer nor aggregate discovery
  should manufacture an annual salary or a fresh posting date. Published
  compensation with an unsupported period is held by
  `compensation-period-unknown`, not treated as unpublished pay; cached
  acceptances cannot pass a salary-filtered queue using unknown units.
- New integrations use fixed HTTPS source hosts, bounded responses, timeouts,
  retries, redirect validation and host throttling. Custom API headers are
  dropped on cross-origin redirects and never printed in tool output.
- Recruitee's [authentication notice](https://docs.recruitee.com/reference/authentication-1)
  requires employer tokens for Careers JSON beginning February 10, 2027, but
  explicitly exempts XML feeds. This integration uses XML and rejects DTD/entity
  declarations.
- Credit Himalayas and link back; do not republish its listings to third-party
  job sites. Foorilla data uses CC BY-SA 4.0: preserve attribution, license link,
  change indication and applicable share-alike requirements. Tools return these
  conditions with results.
- Foorilla documents 5 requests/second and 600/minute; the connector uses at
  least 700ms between host requests. Other unspecified public-feed quotas are
  not unlimited-use permission. Honor errors and backoff.

Reference contracts:
[SmartRecruiters](https://developers.smartrecruiters.com/docs/endpoints),
[Workable](https://workable.readme.io/reference/jobs-1),
[Recruitee XML](https://support.recruitee.com/en/articles/8213076-faq-api),
[Himalayas OpenAPI](https://himalayas.app/docs/openapi.json),
[Foorilla](https://foorilla.com/api/llms.txt).
