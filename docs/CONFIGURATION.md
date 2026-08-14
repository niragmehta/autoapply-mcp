# Configuration

Three files drive everything. The server itself contains no personal data or campaign policy, which is what makes it reusable.

Scaffold them from the shipped examples:

```bash
npm run init                      # writes to ~/.autoapply
AUTOAPPLY_HOME=/path npm run init # or anywhere else
```

`init` never overwrites an existing file, so re-running it after adding one config fills in only what is missing.

Validate with:

```bash
AUTOAPPLY_HOME=/path/to/config node dist/cli/doctor.js --probe
```

## A key written in the wrong place does nothing

The schemas strip keys they do not define rather than rejecting the file, so a misplaced setting parses cleanly and then has no effect — the file says one thing and the campaign does another. `doctor` reports these:

```
WARN  campaign.json: "maxBatchSize" is ignored; it belongs at "submission.maxBatchSize"
WARN  profile.json: "answers[4].citation" is not a known setting and is ignored
```

Treat every `WARN` as a real defect. The commonest cases are submission policy written at the top level of `campaign.json` instead of under `submission`, and extra bookkeeping fields on an `answers` entry — the only fields an answer accepts are `key`, `label`, `patterns`, `answer`, `alternatives`, `allowAutoFill`, `skip` and `note`.

## profile.json

Your verified truth. Every drafted answer must trace back to something here.

### identity
Name, headline, email, phone, location and links. Contact form fields are filled from these.

### workAuthorization

```json
{
  "citizenships": ["Canada"],
  "authorizedIn": ["CA"],
  "requiresSponsorshipIn": ["US"],
  "statement": "Canadian citizen, authorized to work in Canada. US roles require employer support for work authorization.",
  "alwaysReviewManually": true
}
```

`authorizedIn` and `requiresSponsorshipIn` are ISO country codes and drive gating: a posting saying "must be authorized to work in Canada, no sponsorship" passes for a Canadian citizen applying to a Canadian role, and fails for the same wording on a US role.

Keep `alwaysReviewManually` true unless counsel has reviewed your exact wording.

### compensation
Your targets, plus a `disclosurePolicy` of `decline`, `range` or `exact`. Compensation questions are a blocked category by default regardless.

### resumes
At least one variant. Bind variants to campaign tracks:

```json
{ "id": "ai-security", "label": "AI Security", "path": "/abs/path/resume.pdf", "tracks": ["ai-security"], "isDefault": true }
```

`path` must point at the real file that gets uploaded. `doctor` fails if it is missing.

### skills
Name, aliases and a level of `expert`, `strong`, `working` or `familiar`. Levels weight the stack-alignment score; aliases are what make matching work (`OPA` for `Open Policy Agent`).

### facts
Your achievement database. Each fact is a statement, optional metrics and tags. Match reports rank these by relevance so an agent writes from your real accomplishments rather than inventing them.

### answers
Pre-approved answers to recurring questions:

```json
{
  "key": "source",
  "label": "How did you hear about us?",
  "patterns": ["how did you hear", "how did you find"],
  "answer": "Friend",
  "alternatives": ["Friend", "Referral", "Company careers page", "LinkedIn"],
  "allowAutoFill": true
}
```

`patterns` are case-insensitive substrings matched against the employer's question label, and the **longest** matching pattern wins, so a specific entry overrides a general one. They are plain substrings, not regular expressions: `record(?:ing)?` matches nothing, because no employer writes that. Write the literal words the form uses. Set `allowAutoFill` to false for anything you want to review each time; the answer is still offered as a suggestion and `note` is shown as guidance.

`alternatives` is an ordered preference list for questions rendered as a fixed set of choices. The first entry the employer actually offers is used; if none are offered, the question is handed back rather than submitted with an unlisted value. See [BATCH.md](BATCH.md).

`skip: true` records a deliberate decision to leave an optional field blank.

## campaign.json

Your policy: what qualifies, how it ranks, how far automation may go.

### tracks
A track is a role family with its own title patterns, keywords and resume variant. Jobs are scored against every track and keep the best fit.

```json
{
  "id": "ai-security",
  "allocation": 0.4,
  "titleIncludes": ["ai security", "security engineer"],
  "titleExcludes": ["sales"],
  "keywords": [{ "term": "guardrail", "weight": 3, "aliases": ["guardrails"] }],
  "resumeId": "ai-security"
}
```

`allocation` is reported by `campaign_status` as intended versus actual mix. It does not restrict what gets queued; it tells you when your pipeline is drifting.

Keyword weights run 0 to 10. Coverage saturates rather than requiring a full sweep, so a track with 20 keywords is not handicapped against one with 8.

### locations

```json
{ "allow": ["bay-area", "canada", "remote-canada"], "workplaceTypes": ["onsite", "hybrid", "remote", "unknown"] }
```

Location classes: `bay-area`, `us-other`, `canada`, `remote-us`, `remote-canada`, `remote-global`, `other`, `unknown`.

Classification handles ambiguous city names: `Richmond, BC` is Canada, `Richmond, CA` is the Bay Area, `Newark, NJ` is neither. A posting listing several offices keeps the strongest match.

A remote posting with a named office (`Toronto, ON (Remote)`) classifies by that office; one with only a country scope (`Remote - US`) classifies as a remote scope.

### compensation

```json
{
  "currency": "USD",
  "floors": { "US": 200000, "CA": 200000 },
  "fx": { "USD": 1, "CAD": 0.73 },
  "allowUnknown": true,
  "rejectBelowFloor": true
}
```

Floors are per ISO country code in the campaign currency; `"*"` sets a default. FX rates read as "one unit of this currency equals N units of the campaign currency" and are static - update them deliberately.

The **top** of a published range is compared against the floor. `allowUnknown` keeps postings that publish nothing, which is most of them; those score lower and carry a `compensation-unverified` flag.

### seniority and exclusions
`seniority.allow` and `seniority.reject` work against a level detected from the title (`intern`, `new-grad`, `junior`, `senior`, `staff`, `principal`, `manager`, `director`, `executive`, `unspecified`). Keep `unspecified` in `allow` or you will discard many legitimate postings.

Single-word exclusion patterns match on word boundaries, so `sales` does not exclude `Salesforce`.

### scoring

| Dimension | Default weight | Meaning |
|---|---|---|
| `roleAlignment` | 25 | Title match against the track |
| `domainAlignment` | 25 | Weighted keyword coverage, with evidence |
| `stackAlignment` | 15 | Overlap with your skills, weighted by level |
| `seniority` | 10 | Detected level fit |
| `compensation` | 10 | Published pay against the floor |
| `workAuthorization` | 10 | Whether you can work there without employer action |
| `freshness` | 5 | Posting age |

Thresholds set the tiers. Calibrate them against your own pool: run `discover_jobs`, then read the tier distribution in `campaign_status` and adjust so tier A is a shortlist rather than a category.

### submission

```json
{
  "mode": "manual",
  "allowedAtsDomains": ["job-boards.greenhouse.io", "jobs.lever.co", "jobs.ashbyhq.com"],
  "allowedCompanies": [],
  "dailyLimit": 15,
  "maxBatchSize": 3,
  "maxPerCompany": 3,
  "minDelaySeconds": 90
}
```

`mode` is a ceiling: a tool call may request a weaker mode but never a stronger one. `blockedQuestionCategories` defaults to the full sensitive set; removing an entry is a deliberate, consequential choice.

`allowedCompanies` is an allowlist, not a filter: an empty list blocks every employer. A company must be added by name before any application to it can be submitted, which is what stops a mis-scoped batch from contacting people you never intended to apply to.

`maxBatchSize` caps how many applications a single `prepare_batch` or `submit_batch` run may touch, even when a caller passes a larger explicit limit. Keeping it small keeps a run reviewable and avoids the rapid consecutive submissions that ATS platforms rate-limit. `maxPerCompany` caps how many live applications may exist for one employer, since several reject the excess outright.

## companies.json

```json
{
  "version": 1,
  "companies": [
    { "name": "Anthropic", "ats": "greenhouse", "board": "anthropic", "tier": "A", "tags": ["ai"], "active": true, "region": "global" }
  ]
}
```

`ats` is `greenhouse`, `lever`, `ashby` or `workday`. `board` is the public board slug, which is rarely the company name - use `resolve_company_board` to find it. For Workday there is no single slug: `board` is the `tenant/datacenter/site` triple read off the employer's career-site URL, e.g. `nvidia/wd5/NVIDIAExternalCareerSite`, and it cannot be guessed, so record it with `add_company_board`. `tier` influences scoring when compensation is unpublished. `region` is `eu` for EU-hosted Lever and Ashby instances. `query` is a server-side search filter, worth setting on large Workday tenants that publish thousands of unrelated postings.

`name` is an identity, not a label. Boards are matched on it case-insensitively, and `submission.maxPerCompany` is keyed by it, so two spellings of one employer become two boards with two separate ceilings.

Start from `presets/ai-security-us-canada.json`, which contains 135 boards verified live against the ATS APIs. `npm run init` copies it for you. It is a starting point, not a fixed list: this file is your own selection, so add and remove boards freely. Boards found during a campaign land in your copy, not in the repository, so contribute anything worth sharing back to the preset.

## Verification codes (environment only)

Greenhouse increasingly emails a one-time code before it accepts a submission,
and the code dies the moment a second submit asks for a new one. `submit_application`
with `waitForCodeSeconds` therefore holds the browser at the gate and polls
`<artifacts>/<applicationId>.code`, which a person can write by hand.

Setting the variables below lets the server read that code out of a mailbox
instead. Both readers run together, so the file hand-off keeps working and
whichever code arrives first is used.

| Variable | Default | Meaning |
|---|---|---|
| `AUTOAPPLY_OTP_IMAP_USER` | - | Mailbox address. Absent means the feature is off. |
| `AUTOAPPLY_OTP_IMAP_PASSWORD` | - | App password for that mailbox. |
| `AUTOAPPLY_OTP_IMAP_HOST` | `imap.gmail.com` | IMAP host. |
| `AUTOAPPLY_OTP_IMAP_PORT` | `993` | IMAPS port. |
| `AUTOAPPLY_OTP_MAILBOX` | `INBOX` | Folder to read. |
| `AUTOAPPLY_OTP_FROM` | - | Only consider senders containing this text. Greenhouse sends from `us.greenhouse-mail.io`, so use `greenhouse`, not `greenhouse.io`. |

Point this at a mailbox that receives nothing but forwarded verification mail,
created by a filter on your real address. An app password grants full read of
whatever mailbox it belongs to, so the narrower that mailbox is, the less the
server can see. Credentials are read from the environment and never from
`profile.json` or `campaign.json`, which are edited by hand, printed in previews
and backed up.

Only messages that arrive **after** the run clicked submit are considered: an
earlier code belongs to an earlier attempt and is already dead. When a message
yields two different candidate codes the server declines to guess, because a
wrong code is not a free retry - the board rejects it and emails a fresh one,
invalidating the code the run is waiting for.

Requires `npm install imapflow`, an optional peer dependency.
