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

The answer policy engine can produce an answer from exactly two sources:

1. A verified field in `profile.json`, cited by path (for example `identity.email`).
2. A pre-approved answer in `profile.answers` whose pattern matches the question.

Everything else is returned with `source: "blocked"` and an empty answer. The server has no fallback that guesses, infers or generates a plausible response.

Match reports include a `claimsToAvoid` list: requirements the posting asks for that your profile cannot support. An agent writing your cover letter is told explicitly not to claim them.

## Questions that always require a human

By default these categories never auto-fill, regardless of what is in your profile:

`work-authorization`, `sponsorship`, `citizenship`, `clearance`, `criminal-history`, `compensation`, `demographic`, `veteran`, `disability`, `legal-attestation`, `essay`, `reference`

They are legally material, ethically sensitive, or negotiation-relevant. Getting them wrong can invalidate an application or an offer.

For work authorization the server *suggests* your verified statement so you can see it, but still marks the answer as requiring a human while `workAuthorization.alwaysReviewManually` is true. Have immigration counsel review that wording before you rely on it.

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
