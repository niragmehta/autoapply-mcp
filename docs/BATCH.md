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
    "disabilityStatus": { "value": "I do not wish to answer", "autoFill": true }
  }
}
```

US self-identification questions are voluntary. "Decline to self-identify" is a legitimate answer and a safe default; supplying real values is equally valid and entirely your choice. Either way the decision is recorded once rather than being asked a hundred times.

`personal` is redacted from logs and audit payloads, and `config/` is gitignored.

## Work authorization stays deliberate

Work authorization, sponsorship and citizenship questions are not covered by `personal`. They are legal attestations, and a wrong answer can void an offer.

They only auto-fill when **both** are true:

1. `profile.workAuthorization.alwaysReviewManually` is `false`
2. A `profile.answers` entry matches the question with `allowAutoFill: true`

The default configuration satisfies neither, so these questions stop for a decision. If you set an answer, set the one that is true for you: for a citizen of one country applying in another, "I do not require sponsorship" and "I am authorized to work here" are usually not accurate, and the accurate phrasing depends on the visa route. Confirm the wording with an immigration lawyer before enabling auto-fill.

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
