# Job hygiene and deep evaluation

Before effort goes into a posting, the server checks that it is still open,
looks for signs that it is not a real opening, and measures it against the
candidate's verified profile. The server computes everything deterministic;
the agent researches pay and culture with its own tools, writes the narrative
from the server's evidence, and saves it as a report.

The ideas follow [career-ops](https://github.com/career-ops-hq/career-ops)
(MIT): liveness before effort, repost and ghost-job signals ("Block G"),
knock-out checks, a do-not-apply list, and the A-H evaluation report.

## Liveness

`check_liveness` (and every `prepare_application`) asks whether a posting
still takes applications.

1. **The ATS API**, through the adapter's `checkPosting`:

   | ATS | Open | Closed | Unknown |
   |---|---|---|---|
   | Greenhouse | job endpoint returns the posting | 404 "Job not found" | anything else |
   | Lever | postings API returns it | - | a 404 (Lever hides confidential postings from the API), so the page decides |
   | Ashby | the board still lists it | the board no longer lists it | board without the public API |
   | Workday | CXS detail with `posted` and `canApply` | 404, 403 `S22` (withdrawn), `posted: false`, `canApply: false` | other refusals |
   | SmartRecruiters | `active` and public | inactive or not public | 400/404 (its answer to unknown ids) |
   | Workable | `state: "published"` | 404, closed or archived | other states |
   | Recruitee | the public feed carries it | missing from the feed, closed or past `close_at` | feed unreadable |

2. **The posting page**, when the adapter has no check or its answer was
   unknown. Redirects are followed by hand so the final address is known.
   - Closed: HTTP 404/410; a redirect to the board's index (including
     Greenhouse's `?error=true`); the page saying so ("no longer accepting
     applications", "this job has expired", "position has been filled",
     "job not found", ...), unless the phrase sits inside a condition
     ("accepted until the position has been filled").
   - Open: the page publishes this posting's schema.org JobPosting, or shows
     its title and an apply control.
   - Unknown: everything else, including blocked requests (401/403/429/451),
     server errors, anti-bot walls, client-rendered shells and redirects that
     merely lose the posting id.

**Unknown never blocks anything.** Only `closed` stops `prepare_application`
or a submission, from a tool, a batch or a submit run (error `posting_closed`;
a submit run logs it as a skip and moves on). Network errors are always
unknown. Pages are fetched over HTTPS from public host names only: IP literals,
local names, and names that resolve to a private address are refused.

Verdicts are stored in `liveness_checks`. A verdict younger than
`hygiene.liveness.maxAgeHours` (default 24) is reused; an unknown one only for
an hour. The check before a submission reuses a verdict for at most an hour.

**Listing absence.** Discovery stamps every posting of one board fetch with
the same `last_seen_at`. A posting last seen more than 12 hours before the
board's latest full fetch (the newest timestamp at least two postings share)
has left the listing. This is a legitimacy signal, not a verdict.

## Reposts

`find_reposts` clusters stored postings by board and title identity within
`hygiene.reposts.windowDays` (90). A cluster with at least
`hygiene.reposts.minPostings` (2) posting ids first seen on two or more
different days is a repost.

The title identity is the set of title words after removing bracketed
segments (locations, workplace and requisition notes), requisition ids,
workplace words and punctuation, and expanding Sr/Jr/Mgr. Word order does not
matter. Level numerals are canonicalized (II = 2) but never removed: Engineer
II and Engineer III are different grades, so different requisitions. A
different city, team or seniority word keeps titles apart, and postings first
seen on the same day are parallel headcount, not reposts.

## Legitimacy

`posting_legitimacy` returns observations, each with quoted evidence and,
where one exists, an innocent explanation. They are observations, not
accusations.

| Signal | Severity |
|---|---|
| Liveness closed | high |
| Candidate asked to pay a fee or buy equipment (common scam pattern) | high |
| Posted more than 60 days ago | medium |
| Re-posted (repost cluster) | medium |
| Missing from the board's latest listing | medium |
| Posted by an agency for an unnamed client ("on behalf of our client") | medium |
| Commission-only pay | medium |
| Very short description (under 500 characters) | medium |
| Wide pay range (max/min at least 2, or 150,000 wide) | low |
| No pay range in a pay-transparency jurisdiction | low |
| Vague description (under 1,500 characters, naming no technology) | low |
| Instructions aimed at AI tools in the description | low |
| Contract, fixed-term, C2C, W-2 contract or 1099 terms | info |
| AI or automated screening disclosed | info |
| Liveness open, fresh posting, published pay | positive |

Tier: **suspicious** with one high or two medium signals; **caution** with one
medium or two low; otherwise **high** confidence. Info and positive signals
never lower it.

Pay-transparency jurisdictions (laws in force by late 2025): California,
Colorado, Washington, New York, Illinois, Minnesota, Maryland, Hawaii,
Vermont, Massachusetts, New Jersey and the District of Columbia. Most exempt
small employers, and remote US roles are generally covered when they can be
done from those states, so a missing range is an observation, not a violation.

## Years of experience

The description's years bar is read by rules, with the sentence it came from.

- Phrasings: "5+ years", "minimum of 5 years", "at least five years",
  "4-6 years", "between 3 and 5 years", "8 or more years", "five (5) years".
- Required or preferred from the cue nearest the figure ("required", "must",
  "minimum" / "preferred", "nice to have", "a plus", "ideally"), else from the
  section heading. A figure outside any section is "unclear".
- Ignored: ages, company history, vesting, degree lengths ("4-year degree"),
  ceilings ("up to 10 years"), other people's experience ("engineers with 10+
  years"), and benefits and legal sections.
- The gating figure is the **lowest** required bar (the most lenient honest
  reading). Sub-requirements ("including 2 years leading") never lower it.
  A bar with an equivalent route ("or an equivalent combination of education
  and experience") is reported but never rejects.

Candidate years come from `hygiene.experience.candidateYears`, or else from
`profile.experience`: internships excluded, overlapping roles counted once.

When the posting states a bar, its evaluation carries the flag `years-required:N`, plus
`years-over-tolerance` when the bar exceeds the candidate's years by more than
`hygiene.experience.toleranceYears` (1.5). With `hygiene.experience.enforce`
on, such a posting is rejected by the gate `experience-years` (only for a
confident bar: stated as required, with no equivalent route).

## Do-not-apply list

`blacklist_company {company?, domain?, reason}` records the candidate's own
decision in `campaign.hygiene.blacklist` (campaign.json is backed up first,
validated, and reloaded). Matching stored postings are re-evaluated at once.
`list_blacklist` shows the list. Nothing is ever added automatically.

- `company` entries match the employer name ignoring case, accents,
  punctuation and legal suffixes (Inc, LLC, Ltd, GmbH...). Other words count:
  "Acme Labs" is not "Acme".
- `domain` entries match the posting or apply URL's host or any subdomain:
  `example.com` matches `jobs.example.com`, never `notexample.com`.

A match fails the gate `blacklisted`, and an evaluation shows the recorded
reason; the agent asks before evaluating such a posting.

## Deep evaluation

`evaluate_job {jobId}` (or `evaluate_posting` for a URL or pasted text)
returns the deterministic scaffold:

- **Requirements**, split from the description's sections, each with an
  importance band - `required`, `preferred` or `bonus` - and its source:
  `jd-wording` (the item says "must", "required", "preferred", "a plus"),
  `structure` (the section it sits under) or `estimate` (recognised by phrasing
  only). An estimate is never `required`.
- **Evidence** per requirement from the verified profile only: `direct`
  (a listed skill, a fact or highlight doing the thing, enough years, a
  matching degree, work authorization), `adjacent` (a sibling technology, a
  skill held at "familiar", years within tolerance, equivalent experience),
  or `none`, with citations (skill names, fact ids, experience entries,
  quotes). Requirements bundling several asks take the weakest.
- **Skill gap** in three buckets: listed in `profile.skills`, supported by
  facts or experience, or a gap that must never be claimed.
- **Keyword coverage**: important posting terms weighted by title,
  requirement importance, responsibilities and frequency; coverage of the
  profile (or a supplied resume text), terms safe to emphasise, and terms
  that must not be added.
- **Level**: the posting's level (title, years, scope language) against the
  candidate's (years on common bands: under 2 junior, 2-5 mid, 5-8 senior,
  8-12 staff, 12+ principal; and the campaign's seniority list) - `stretch`,
  `at-level` or `below-level` - with positioning advice.
- **Archetype**: the matching campaign track. A role matching no track title
  scores North Star 1 instead of borrowing the nearest label.
- Compensation against the candidate's target and minimum, liveness,
  legitimacy, the do-not-apply match, interview focus areas (required items
  with the weakest evidence), relevant facts, and a `stories` hook for the
  story bank.

### Score

A 1-5 global score. The base maps the campaign's 0-100 score so its tier
thresholds meet the verdict bands:

| Campaign score | 1-5 base | Verdict |
|---|---|---|
| tier A or above | 4.5-5.0 | strong match, apply |
| tier B to A | 4.0-4.4 | apply |
| tier C to B | 3.5-3.9 | only with a specific reason |
| below tier C | 1.0-3.4 | do not apply |

Linear within each band; scores round down, so a score never rounds into a
better band. Adjustments: requirement coverage moves it by up to +/-0.5
(`(cvMatch - 3) x 0.25`), published pay under the candidate's minimum costs
0.3, red flags at 2 or below cost 0.5, a role matching no target track or a
suspicious posting is capped at 3.4, and a gated or closed posting scores 1.

Dimensions, each `supported`, `partial` or `unknown` with its evidence:

| Dimension | How |
|---|---|
| CV match | requirement coverage, weighted by importance (required 3, preferred 1.5, bonus 0.75; estimates half), direct 1, adjacent 0.5 |
| North Star | 5 title match with the track's keywords, 4 title match, 3 keywords only, 2 a few keywords, 1 no match or an excluded title |
| Compensation | top of the published range against target (5) and minimum (3); unknown when unpublished |
| Red flags | starts at 5; gates, closure, legitimacy, prompt-injection text, an over-tolerance years bar and work-authorization needs subtract |
| Culture | always unknown here; the agent researches it |

Evidence confidence: **low** when the posting is too short, CV match is
unknown, or two dimensions are unknown; **medium** when any is partial or
unknown; **high** only when all are supported. Up to three verification
priorities say what would change the call.

### Reports

`save_evaluation_report` takes the narrative - `summary`, `cvMatchNotes`,
`strategy`, `compResearch` (`notes` and `sources`), `cultureNotes`,
`interviewPlan`, `verdict`, `score`, `scoreDeviation` - and:

- re-builds the scaffold, so the report reflects the current configuration;
- requires the verdict to be the band the score falls in, and a
  `scoreDeviation` reason when the score is 0.5 or more from the
  deterministic one;
- flags any figure in the summary or CV notes that appears in neither the
  scaffold nor the profile as an **unverified figure**, in the database and
  at the top of the Markdown;
- stores it in `evaluation_reports` and writes
  `{reports}/{NNN}-{company-slug}-{yyyy-mm-dd}.md`, numbered after the highest
  number in the table or the folder.

The Markdown follows career-ops' layout: header (score, decision,
legitimacy, confidence), summary, A) role summary, B) match with CV
(requirement table, skill buckets, keyword coverage), C) level and strategy,
D) compensation (advertised figure first, then research with sources), E)
culture, F) interview plan, G) posting legitimacy, score evidence, the posting
archived in a fenced block, and a JSON machine summary.

`get_evaluation_report {jobId | reportId}` and `list_evaluation_reports` read
them back.

## Pasted URLs and text

`evaluate_posting {url}` recognises Greenhouse, Lever, Ashby, Workday,
SmartRecruiters, Workable and Recruitee posting URLs, reads the posting
through that ATS's API, and stores it as discovery would (a board the
candidate already tracks keeps its name and tier; otherwise the board slug
becomes the name unless `company` is given). Any other host is read through
its schema.org JobPosting metadata as an `external` posting. A posting the
ATS no longer publishes returns `posting_closed`; a page without metadata
returns `posting_unreadable` - paste the text instead:
`evaluate_posting {text, company, title, location?, url?}`.

All fetched and pasted content is untrusted: it is size-capped, chat control
tokens are neutralised, and it is returned inside an untrusted-content
boundary. Nothing is applied to and no board is added to companies.json.

## Prompts

- `evaluate_job` (`jobId` or `url`): scaffold, confirm liveness, research pay
  and the company with the agent's own tools (five searches at most, sources
  cited), write each section from the scaffold's evidence, score against the
  bands, save, and recommend against applying below 4.0 unless the candidate
  gives a reason.
- `triage_queue` (`limit`): a quick apply / evaluate-first / skip pass over the
  top of the queue from liveness, legitimacy and evaluation flags.

## Configuration

```json
{
  "hygiene": {
    "liveness": { "beforePrepare": true, "beforeSubmit": true, "maxAgeHours": 24 },
    "reposts": { "windowDays": 90, "minPostings": 2 },
    "experience": { "candidateYears": 7, "toleranceYears": 1.5, "enforce": false },
    "blacklist": [{ "scope": "company", "value": "Example Corp", "reason": "declined an offer", "since": "2026-10-01" }]
  }
}
```

Every field is optional; the values shown other than `candidateYears` and
`blacklist` are the defaults.
