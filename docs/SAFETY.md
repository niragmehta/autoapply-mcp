# Safety model

This server automates a process that has real consequences: a bad submission reaches a real employer under your name and cannot be recalled. The design assumes that refusing to act is always cheaper than acting wrongly.

## The approval boundary

Discovery, gating, scoring and drafting are fully automated. Submission is not.

`submit_application` re-checks every one of these before anything reaches an employer:

| Guard | Refusal code |
|---|---|
| Application already sent | `already_submitted` |
| Requested mode exceeds the campaign's configured mode | `mode_not_permitted` |
| No recorded human approval | `not_approved` |
| Content changed since approval | `packet_changed` |
| A question needing a human is still unanswered | `unresolved_questions` |
| Destination host is not allowlisted | `destination_not_allowed` |
| Auto mode for a company that is not allowlisted | `company_not_allowlisted` |
| Daily submission cap reached | `daily_limit_reached` |
| Minimum interval between submissions not elapsed | `pacing` |

Approval binds to a SHA-256 hash of the exact packet: job, apply URL, resume, cover letter and every answer. Change one character and the previous approval no longer applies.

## Truthfulness

The answer policy engine can produce an answer from exactly four sources:

1. A verified field in `profile.json`, cited by path (for example `identity.email`).
2. A pre-approved answer in `profile.answers` whose pattern matches the question.
3. A field in `profile.personal` that the candidate marked `autoFill: true`.
4. A `profile.narratives` template, rendered from the specific posting.

Everything else is returned with `source: "blocked"` and an empty answer. The server has no fallback that guesses, infers or generates a plausible response.

Narrative templates fill `{topics}` only from keywords the posting asks for **and** the profile supports; anything in `claimsToAvoid` is excluded, so a template cannot claim experience the candidate does not have.

Storing a personal value is not consent to send it. Each field carries its own `autoFill` flag, and the flag is the consent.

Where question phrasings overlap, the longest matching pattern wins. This matters for sponsorship: a generic "do you require sponsorship" answer must not pre-empt one written for a form that defines sponsorship to include TN.

Match reports include a `claimsToAvoid` list: requirements the posting asks for that your profile cannot support. An agent writing your cover letter is told explicitly not to claim them.

## Questions that always require a human

By default these categories never auto-fill:

`work-authorization`, `sponsorship`, `citizenship`, `clearance`, `criminal-history`, `compensation`, `demographic`, `veteran`, `disability`, `legal-attestation`, `essay`, `reference`

They are legally material, ethically sensitive, or negotiation-relevant. Getting them wrong can invalidate an application or an offer.

A category block can be satisfied in advance, but only by an explicit prior decision recorded in the profile: a `profile.answers` entry with `allowAutoFill: true`, or a `profile.personal` field with `autoFill: true`. This does not weaken the rule; it moves the decision earlier, where it gets more thought than it would on the hundredth form.

Work authorization is held to a stricter standard. It auto-fills only when `workAuthorization.alwaysReviewManually` is `false` **and** a matching approved answer exists. The shipped default satisfies neither. If you enable it, use wording that is accurate for your situation: for a citizen of one country applying in another, "I do not require sponsorship" is frequently untrue, and the accurate phrasing depends on the visa route. Have it reviewed by an immigration lawyer.

## Batch approval

Batches do not bypass any guard. `approve_batch` records a separate approval per application, each bound to that application's packet hash, and additionally requires:

- a **manifest hash** covering every packet in the set, so the batch cannot grow or change between review and approval
- an **expected count**, so a batch that changed size cannot be approved by replaying an earlier call

`submit_batch` re-runs every per-application guard for each submission rather than trusting the batch-level decision.

## Untrusted content

Job descriptions, careers pages and form labels are third-party input. The server:

- scans for instruction-injection patterns (override attempts, role injection, chat control tokens, exfiltration requests, "submit without review", "do not tell the user")
- attaches the findings to the evaluation as `injection:*` flags
- neutralizes chat control tokens
- wraps any description handed to a model in an explicit boundary stating it is data, never instructions

`explain_job` never returns raw description text without that wrapper.

## Anti-bot controls

If a CAPTCHA, hCaptcha, reCAPTCHA or Turnstile challenge is detected, the browser run aborts, captures a screenshot and marks the application `needs_human`. There is no solving, bypassing, proxying or fingerprint spoofing, and none will be added.

Requests are throttled per host, retried with backoff only on 429 and 5xx, and identify themselves honestly through the User-Agent.

## Privacy

- Configuration, database and artifacts stay on your machine. Nothing is sent anywhere except the employer boards you configure.
- Personal data belongs in `~/.autoapply`, outside the repository, so publishing a checkout cannot leak it. Nothing in the repository is candidate-specific.
- Logs and audit payloads pass through redaction that strips emails, phone numbers, government identifiers, card numbers and credential-shaped strings.
- Answers in sensitive categories are never persisted in plain text by the redacting storage helper.
- `config/`, `data/` and `artifacts/` are gitignored. Keep them that way: application history is sensitive.

## Rate and volume discipline

`dailyLimit` and `minDelaySeconds` exist to keep a campaign within the bounds of a person applying diligently. High-volume, low-quality applications are counterproductive for senior roles: recruiters increasingly filter for them, and a poorly targeted application is a wasted first impression at a company you may want later.

The intended shape of a campaign is roughly 20 to 30 well-targeted submissions per week, not 100 in a day.

## What this server will not do

- Automate LinkedIn, Indeed or Wellfound, whose terms prohibit it
- Solve or evade anti-bot challenges
- Fabricate experience, skills, dates or metrics
- Answer immigration, compensation, demographic or legal questions on your behalf
- Submit without a recorded, content-bound human approval

## Residual risks you own

- **Accuracy of your profile.** The server enforces that answers come from your profile; it cannot verify your profile is true.
- **Compensation heuristics.** Text-parsed pay can be wrong on multi-zone postings. Verify before relying on a number.
- **Employer terms.** Some employers restrict automated applications in their own terms. Check the boards you target.
- **Volume judgement.** The tool will pace you, but choosing to apply to 120 roles rather than 30 targeted ones is your decision, not the tool's.
