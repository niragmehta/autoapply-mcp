# Batch applications

Preparing a hundred applications one at a time does not work in practice. The batch tools handle volume without weakening the approval boundary: every per-application guard still runs, and approval binds to a manifest hash covering the whole set.

## The flow

```
prepare_batch   select from the queue, prepare a packet for each
preview_batch   review the set and the grouped blocking questions
approve_batch   one decision authorizing the whole manifest
submit_batch    submit the set, honouring daily limit and pacing
list_batches    track progress
```

## prepare_batch

Selects queued jobs matching a filter and prepares each one through the same code path as `prepare_application`.

| Filter | Meaning |
|---|---|
| `tiers` | Quality tiers. Defaults to `["A","B"]` |
| `trackIds` | Campaign tracks to include |
| `locationClasses` | e.g. `["bay-area","canada","remote-canada"]` |
| `companies` | Restrict to named employers |
| `minScore` | Minimum score |
| `minCompensation` | Minimum annualized top-of-range pay, campaign currency |
| `allowUnknownCompensation` | Include postings with no published pay. Default false |
| `limit` | Max applications to prepare. Default 50, max 300 |

Applications split into two states:

- **ready** - every question is answered from verified data or a pre-approved answer
- **needs_human** - at least one question needs a decision, or the resume is unusable

Only `ready` applications enter the manifest. `blockingReasons` groups the outstanding questions by category so one profile edit can clear many applications at once.

## Why a manifest hash

Single approval binds to one packet hash. Batch approval binds to a hash of every packet in the set, sorted by application id. If any application changes, or one is added or removed, the manifest no longer matches and approval is refused.

`approve_batch` also requires `expectedCount`. Passing the hash alone would let a batch that silently grew be approved by replay; requiring the count means the number is confirmed by a person who has seen it.

## Reducing what needs a human

The lever is `profile.answers` and `profile.personal`. Every question you pre-answer removes that question from every future application.

After a `prepare_batch` run, read `blockingReasons`:

```json
{ "general": 45, "sponsorship": 17, "work-authorization": 12, "essay": 7, "contact": 9 }
```

Then add matching entries to `profile.answers`:

```json
{
  "key": "based-in-bay-area",
  "label": "Are you currently based in the Bay Area?",
  "patterns": ["currently based in", "do you live in"],
  "answer": "No - I am based in Vancouver, Canada and am willing to relocate.",
  "allowAutoFill": true
}
```

Run `reload_config`, then `prepare_batch` again. The count drops.

`essay` questions are deliberately never pre-answered: a generic answer to "why do you want to work here" is worse than none.

## Work authorization

Three lists describe where you can work, and they mean different things:

```json
"workAuthorization": {
  "citizenships": ["Canada"],
  "authorizedIn": ["CA"],
  "noSponsorshipRequiredIn": ["US"],
  "requiresSponsorshipIn": [],
  "statement": "...",
  "alwaysReviewManually": false
}
```

| Field | Meaning | Effect |
|---|---|---|
| `authorizedIn` | Authorized today, no employer action | Gate passes; full scoring credit |
| `noSponsorshipRequiredIn` | Can obtain authorization without employer sponsorship, e.g. a Canadian using TN under USMCA | Gate passes even when the posting says it will not sponsor; 90% scoring credit |
| `requiresSponsorshipIn` | Employer must petition | Gate rejects postings that rule out sponsorship |

Separating the middle case matters. A blanket "authorized" claim is inaccurate for someone who has not yet entered on TN, while treating TN as ordinary sponsorship discards employers who simply will not file an H-1B.

Citizenship and clearance requirements still gate out regardless: no visa route satisfies "must be a U.S. citizen" or "must hold TS/SCI".

### Answering sponsorship questions

Set `alwaysReviewManually: false` and add matching entries to `profile.answers` with `allowAutoFill: true`.

Employers phrase this several ways and the phrasings do not mean the same thing. Real examples from live boards:

| Question | Consideration |
|---|---|
| "Do you require visa sponsorship?" | TN needs no petition or lottery, so "No" is defensible |
| "...require sponsorship (e.g., H-1B, E-3, **TN**, O-1...) requiring a written submission to a government agency?" | This definition **includes TN**. "No" would be false here |
| "Are you a U.S. Person (Citizen, LPR, Refugee, Asylee)?" | A separate factual question, usually export-control related |
| "Are you legally authorized to work in the country where the job is located?" | Country-relative; the answer changes with the posting |

Because these overlap, the longest matching pattern wins rather than the first, so a specific answer is never pre-empted by a generic one. Write a distinct entry for each phrasing you care about.

These are legal attestations on a document you sign. Confirm your wording with an immigration lawyer, and remember that Form I-9 verifies status at onboarding.

## Narrative templates

`profile.narratives` answers open-ended questions such as "Why this company?" and cover-letter fields without either storing boilerplate or letting a model invent something.

```json
"narratives": [{
  "key": "why-company",
  "label": "Why this company?",
  "patterns": ["why {company}", "why do you want to work", "cover letter"],
  "template": "I have spent five years building security infrastructure... {company}'s work on {topics} lines up with that, and {role} is where I would apply it.",
  "allowAutoFill": true,
  "minTopics": 1
}]
```

| Placeholder | Filled with |
|---|---|
| `{company}` | Employer name |
| `{role}` | Job title |
| `{topics}` | Keywords the posting asks for **that your profile actually supports** |
| `{location}` | Posting location |

`{company}` also works inside `patterns`, so one entry matches "Why Anthropic?", "Why Stripe?" and the generic phrasings.

`topics` is drawn from the match report and excludes anything in `claimsToAvoid`, so a template cannot claim experience you do not have. `minTopics` declines to render when the posting produced too little to say something specific — a handed-back question is better than a generic paragraph.

A template is not a substitute for a real cover letter on roles you care most about. It is a reasonable floor for volume.

## Personal and demographic data

`profile.personal` caches the details most forms require. Every field has its own `autoFill` flag, and **nothing is sent unless that flag is true**. Storing a value is not consent to send it.

```json
"personal": {
  "dateOfBirth": { "value": "1990-01-01", "autoFill": false },
  "address": { "street": "...", "city": "...", "region": "...", "postalCode": "...", "country": "..." },
  "addressAutoFill": true,
  "legalAgeConfirmation": { "value": "Yes", "autoFill": true },
  "previousEmployment": { "value": "No", "autoFill": false },
  "demographics": {
    "gender": { "value": "Decline to self-identify", "autoFill": true },
    "pronouns": { "value": "", "autoFill": false },
    "raceEthnicity": { "value": "Decline to self-identify", "autoFill": true },
    "hispanicLatino": { "value": "Decline to self-identify", "autoFill": true },
    "veteranStatus": { "value": "I am not a protected veteran", "autoFill": true },
    "disabilityStatus": { "value": "I do not wish to answer", "autoFill": true },
    "sexualOrientation": { "value": "Decline to self-identify", "autoFill": true },
    "transgenderIdentity": { "value": "Decline to self-identify", "autoFill": true }
  }
}
```

US self-identification questions are voluntary. "Decline to self-identify" is a legitimate answer and a safe default; supplying real values is equally valid and entirely your choice. Either way the decision is recorded once rather than being asked a hundred times.

`personal` is redacted from logs and audit payloads, and `config/` is gitignored.

## Deliberately blank answers

Optional free-text fields such as "Additional Information" are often better empty than filled with something generic. Recording that as a decision stops them blocking every application:

```json
{ "key": "additional-information", "patterns": ["additional information"], "answer": "", "skip": true }
```

`skip` is the difference between "I decided to leave this blank" and "nobody has looked at this yet". A blank answer without `skip` still stops for a human.

## Submission

`submit_batch` re-runs every guard per application and respects `dailyLimit` and `minDelaySeconds`. When the daily cap is hit it stops cleanly and marks the rest `deferred`; call it again the next day to continue.

| Mode | Result |
|---|---|
| `manual` | Returns apply URLs and packets for you to submit, then call `record_submission` |
| `assisted` | Fills each hosted form in a visible browser for you to review and submit |
| `auto` | Fills and submits. Requires campaign mode `auto` and an allowlisted company |

A CAPTCHA, an unfillable required field, or an off-allowlist redirect marks that application `needs_human` and the batch continues.

## Realistic volume

Batch size is limited by your queue, not the tool. Before promising yourself a number, measure it:

```
list_queue with your filter and limit 200 -> count
```

If the count is far below your target, the honest fixes are: add more company boards, widen `locationClasses`, lower `minCompensation`, or include tier C with review. Lowering the bar to hit a number is a choice worth making consciously.
