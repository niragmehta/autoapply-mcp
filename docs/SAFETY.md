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
| Configured daily submission cap reached | `daily_limit_reached` |
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

A generic work-authorization answer cannot establish permission for any/all
employers, unrestricted authorization, or indefinite/permanent authorization.
Those qualifiers require a matching explicit approval in the answer bank.
Drafting and live-form fallbacks apply the same scope check; a generic
sponsorship fallback cannot bypass it. Existing profile facts are not changed.

A derived residence-country value can fill a country/address-country control,
not a legal-age, citizenship, documentation or work-permission attestation that
merely mentions "country". Those questions need their own supported answers.

Recruiting-source questions only match answers about the recruiting source.
A personal website or LinkedIn URL cannot answer "How did you hear about this
job?", even when a checkbox is named `website` or offers a LinkedIn option.
Without an explicit source answer, the question remains unresolved.

Lever controls are associated with their enclosing question, not just a generic
choice such as "Yes" or "No". The complete question is retained up to 2,000
characters so trailing sponsorship definitions and consent terms are not lost.
When Lever is still analyzing the uploaded resume, field filling waits for its
native processing indicator to finish so late autofill cannot overwrite reviewed
answers. A processing timeout is surfaced rather than silently ignored.
Lever's current-location autocomplete is selected through its native suggestions
and verified against both the visible label and its native selected-location
record. Searching by a shorter city name never authorizes selecting a different
country, and the browser does not manufacture hidden location data or CAPTCHA
tokens. An interactive challenge during lookup stops the run.

Job-location classification does not treat office floor markers such as `FL 7`
as Florida, while retaining state abbreviations followed by real ZIP codes.
`NL` alone cannot establish a Canadian location because it also denotes the
Netherlands; Canadian city names, full province names, or explicit country
context still identify Newfoundland and Labrador. Check the actual role's
geography before submission rather than relying on a short location code alone.

An employer-impression rating cannot answer a candidate skill self-assessment.
Shared wording such as "how would you rate" does not authorize a new personal
qualification claim.

Institutional or technical uses of "state", such as state-owned enterprises and
state machines, do not resolve to the candidate's postal province or address.
Unanswered political-exposure and experience questions remain blocked.

Workday employment month/year and education year controls are distinguished by
their native history identifiers, so two fields labelled "From" cannot exchange
values. Month-level history does not invent a day, current employment does not
invent an end date, and `MM/YYYY` or `YYYY` placeholders are not completed answers.

Workday resumes saved drafts, so a prompt can still hold a value from an earlier
run. That value is kept only when no approved answer is on offer. When one is on
offer but will not select, or a probe's selection cannot be undone, the run stops
even if the question is optional, because the form would otherwise be sent with
a claim nobody approved. A selection is confirmed by reading the widget back; a
single-select's unchanged "1 item selected" announcement is not evidence. The
Review-page check does not count the employer's own name as confirming an
answer, since it appears on every page.

A bare "Yes" or "No" option stands only for an answer that opens with that word
followed by punctuation, on every board. "Not Applicable/No Driving
Requirements" therefore never selects "No", and a refusal never selects either.
When several options match equally, one that says exactly what was approved
beats a shorter one contained in it.

A question that residence or relocation both satisfy ("Do you currently live
in, or plan to relocate to...") is answered from the relocation decision, not
from the residence denial. When the options are spelled out, only an option
that commits to relocating without claiming a residence may be chosen, and a
person decides when no single option does. Free text keeps the qualified
residence answer, which states the relocation itself.

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

Challenge detection checks every matching iframe, not just the first one, because
providers may retain hidden frames alongside a visible puzzle. The browser
rechecks after uploads, while filling, before reporting a prepared form, and
immediately before a submit click. A late challenge must not be reported as a
successfully prepared form. Hidden frames and passive badges alone are not
interactive challenges.

Requests are throttled per host, retried with backoff only on 429 and 5xx, and identify themselves honestly through the User-Agent.

## Privacy

- Configuration, database and artifacts stay on your machine. Nothing is sent anywhere except the employer boards you configure.
- Personal data belongs in `~/.autoapply`, outside the repository, so publishing a checkout cannot leak it. Nothing in the repository is candidate-specific.
- Logs and audit payloads pass through redaction that strips emails, phone numbers, government identifiers, card numbers and credential-shaped strings.
- Answers in sensitive categories are never persisted in plain text by the redacting storage helper.
- `config/`, `data/` and `artifacts/` are gitignored. Keep them that way: application history is sensitive.

## Rate and volume discipline

`dailyLimit` is a configurable campaign preference, not a universal employer or
ATS requirement. Positive integers impose a daily ceiling; `null` explicitly
disables it. The finite default remains 25 when the setting is omitted.

Unlimited daily mode does not remove `minDelaySeconds`, per-company limits,
per-batch limits, employer restrictions, duplicate protection, or the approval
boundary. It also does not override employer rate limits or anti-bot controls.
Choose volume deliberately and keep every application relevant and truthful;
removing a daily ceiling does not guarantee a particular number of successful
submissions.

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
