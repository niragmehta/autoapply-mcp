# After applying: replies, follow-ups and analytics

Submitting is half of a campaign. The other half is knowing what happened next:
which employers answered, which went quiet, and which tiers, tracks and ATS
channels actually turn into conversations. This loop closes that gap.

```
scan_inbox / classify_reply  ->  classify + match  ->  record, propose or set aside
review_replies               ->  confirm_reply / dismiss_reply
followups_due                ->  draft_follow_up (prompt)  ->  mark_followup
close_stale_applications     ->  ghosted after long silence
campaign_analytics           ->  weekly_review (prompt)
export_tracker, interview_calendar_file
```

Nothing in this loop sends anything. Drafts are drafts; the candidate sends
them. The workflows are adapted from career-ops (MIT): reply-watch,
paste-reply, follow-up cadence, close-stale, pattern analysis, funnel
velocity, calibration, discard analytics and upskill.

## Mailbox setup

Reading replies is off by default. Turn it on in `campaign.json`:

```json
"inbox": {
  "enabled": true,
  "lookbackDays": 30,
  "autoRecord": ["acknowledged", "rejected"]
}
```

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `false` | `scan_inbox` refuses to run until this is true. |
| `lookbackDays` | `30` | How far back the first scan of each folder reads. Later scans resume where the last one stopped. |
| `autoRecord` | `["acknowledged", "rejected"]` | Outcome kinds that may be recorded without a person confirming them (see [Auto-record policy](#auto-record-policy)). |

The mailbox itself is configured in the environment only, never in
`profile.json` or `campaign.json`. By default the reply scanner reuses the
verification-code mailbox (see `docs/CONFIGURATION.md`):

| Variable | Meaning |
|---|---|
| `AUTOAPPLY_OTP_IMAP_USER`, `AUTOAPPLY_OTP_IMAP_PASSWORD` | The verification mailbox, used when no separate reply mailbox is set. |
| `AUTOAPPLY_OTP_IMAP_HOST`, `AUTOAPPLY_OTP_IMAP_PORT`, `AUTOAPPLY_OTP_MAILBOX` | Its host (`imap.gmail.com`), port (`993`) and folders (`INBOX,[Gmail]/All Mail,[Gmail]/Trash`). |
| `AUTOAPPLY_INBOX_IMAP_USER`, `AUTOAPPLY_INBOX_IMAP_PASSWORD` | A separate mailbox for replies. Taken as a pair: setting one without the other disables reading rather than mixing one mailbox's user with another's password. |
| `AUTOAPPLY_INBOX_IMAP_HOST`, `AUTOAPPLY_INBOX_IMAP_PORT`, `AUTOAPPLY_INBOX_IMAP_MAILBOX` | Override the host, port and comma-separated folder list individually, for either mailbox. |

`AUTOAPPLY_OTP_FROM` does not apply to replies. Variables may also live in the
workspace secrets file (`~/.autoapply/.env`); the scanner reads it for each
scan without copying the values into the server's environment. Reading needs
the optional `imapflow` package (`npm install imapflow`).

Use a mailbox that receives only forwarded hiring mail, created by a filter on
the real address. An app password reads everything in its mailbox, so the
narrower the mailbox, the less the server can see. A Gmail filter such as
`from:(greenhouse-mail.io OR myworkday.com OR workday.com OR lever.co OR ashbyhq.com OR smartrecruiters.com OR icims.com OR calendly.com OR hackerrank.com OR codesignal.com)`
forwarding to that mailbox covers most ATS mail; add the domains of employers
whose recruiters write directly.

Without a mailbox, paste replies in instead: `classify_reply` gives the same
classification, match and proposal with no IMAP at all.

## Privacy: exactly what is read and stored

**Reading is read-only.** Folders are opened with EXAMINE, message bodies are
fetched with `BODY.PEEK`, and the client the scanner uses has no command to
set a flag, move, copy or delete. Nothing is marked seen.

**Envelopes first.** The scanner reads each new message's envelope (sender,
Reply-To, subject, date, Message-ID). Only a message that passes this filter
has its source downloaded:

- the sender or Reply-To is an applicant tracking system, scheduling service,
  assessment platform or job network (Greenhouse, Workday, Lever, Ashby,
  SmartRecruiters, iCIMS, Jobvite, SuccessFactors, Taleo, Oracle Cloud,
  BambooHR, Breezy, Rippling, Gem, Dover, Teamtailor, Personio, HiBob, JazzHR,
  Workable, Calendly, GoodTime, HackerRank, CodeSignal, Codility, Karat,
  LinkedIn and others; the full list is `src/inbox/senders.ts`);
- the sender's domain belongs to a company with an application (derived from
  company names, board tokens, Workday tenants and career-site hosts; free
  mail providers never count); or
- the subject names a company with an application *and* reads as hiring mail
  (a manual forward, for example).

Everything else stays unread. A downloaded source is capped at 256 KB, at most
300 messages are downloaded per folder per scan, and the body is decoded in
memory only.

**What is stored**, per candidate message, in `inbox_messages`:

| Column | Content |
|---|---|
| `message_id`, `mailbox`, `uid` | The Message-ID (unique: a message seen in two folders is stored once), folder and UID. Pasted replies use `pasted:<hash>` and folder `pasted`. |
| `received_at` | The message's date. |
| `from_address`, `from_name` | The sender. |
| `subject` | Up to 300 characters. |
| `snippet` | The first ~500 characters of the body, whitespace collapsed, links replaced with `[link]`, email addresses and phone numbers redacted. Withheld entirely for verification-code and sign-in mail. |
| `classification`, `class_confidence` | The classifier's verdict. |
| `matched_application_id`, `match_confidence` | The application it answers, when one is certain. |
| `evidence_json` | Why: the phrases that decided the kind, the match reasons and up to three candidate applications, the decision and its reasons, and any prompt-injection patterns found. |
| `status`, `processed_at` | `recorded`, `proposed` or `dismissed`, and when. |

Never stored: the body, attachments, other headers, or the mailbox password.
An outcome recorded from a reply quotes its subject, sender domain, date and
the deciding phrase in the outcome's `detail`. `inbox_state` keeps, per
folder, the last UID read, the newest message date and the folder's
UIDVALIDITY. Logs and audit events carry counts, ids and confidences, never
message text. Deleting rows from `inbox_messages` is safe; recorded outcomes
stay in `outcomes`.

## Classification

`src/inbox/classify.ts` is deterministic: weighted phrase rules
(`src/inbox/rules.ts`), combined as independent evidence
(`1 - prod(1 - weight)`), so two moderate cues outweigh one and no pile of weak
cues reaches certainty.

| Kind | Typical wording |
|---|---|
| `rejected` | "not moving forward", "unable to move forward", "decided to move forward with other candidates", "position has been filled", "not selected", "regret to inform", "not the right fit", "unable to offer you" |
| `acknowledged` | "thank you for applying", "we have received your application", "our team will review your application" |
| `assessment` | HackerRank, CodeSignal, Codility, Karat, "online assessment", "take-home", "coding challenge" |
| `recruiter_screen` | "phone screen", "30-minute call", "schedule a call", "quick chat", scheduling links with availability language, "we'd like to move forward" |
| `interview` | "invite you to interview", "onsite", "virtual onsite", "panel interview", "final round", "next round" |
| `offer` | "offer letter", "pleased to extend an offer", "compensation package" |
| `withdrawn` | "you have withdrawn your application" |
| `noise` | job alerts, newsletters, webinars, "is hiring", verification codes, account and password mail |
| `unknown` | nothing decisive |

Positive wording is checked for negation in its own clause, so "we'd like to
move forward" is a screen and "we are not able to move forward" a rejection;
"move forward with other candidates" is never read as progress. Combined
rejection or offer evidence of 0.6 or more decides the message. Confidence is
the winning kind's evidence, reduced when a conflicting kind also has real
evidence (a rejection that also invites to interview stays below the
auto-record threshold). Thanks and acknowledgements conflict with nothing:
rejections and invitations both open with them.

## Matching

`src/inbox/match.ts` scores every application at a company that the message
identifies:

| Signal | Weight |
|---|---|
| Sender or Reply-To domain is the company's (or a Workday sender is its tenant, `acme@myworkday.com`) | 0.6 |
| Company named in the sender name or subject | 0.5 (0.4 for a short form such as "Nimbus" for Nimbus AI) |
| Company named in the body (one-word names must be capitalised) | 0.3 |
| Two or more of the above, or an ATS sender writing in the company's name | +0.1 |
| Job title named exactly | +0.3 (partial: up to 0.25) |
| Requisition number quoted (`R123456`, a Workday URL's `_2012996`) | +0.25 |
| The only application at that company | +0.15 |
| Sent through the application's own ATS | +0.05 |
| Application submitted / not submitted | +0.05 / -0.1 |

A message dated more than a day before an application went out cannot be
about it. Below 0.5 nothing matches. Two applications within 0.1 of each
other are a tie, and a tie is no match: the reply is proposed with the
candidates listed, and the person picks the application.

## Auto-record policy

A scanned reply is recorded without a person only when all of these hold:

1. its kind is listed in `campaign.inbox.autoRecord`;
2. the classifier's confidence is at least **0.85**;
3. it matched one application with confidence at least **0.8**;
4. that application is `submitted`;
5. the message contains no instruction-like text (prompt-injection patterns);
6. the outcome moves the application on or ends it: never a repeat, never a
   step back (no `acknowledged` after a screen), never anything after a
   rejection or withdrawal. An application closed as `ghosted` is reopened by
   a later reply.

Recording writes the outcome through the same path as `record_outcome` and
appends an `outcome.auto_recorded` event. Everything else is **proposed** for
review, with the reasons it was not recorded. Noise is **dismissed**, and so
is an acknowledgement for an application that already has one or has moved
past it: it carries no decision. Pasted replies are always proposed.

Review with `review_replies` (status `proposed` by default), then
`confirm_reply` (optionally with `kind` to correct the classification and
`applicationId` to settle an ambiguous match) or `dismiss_reply`. The
`review_replies` prompt walks the candidate through this one reply at a time.

## Follow-up cadence

`campaign.followUps`:

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | `followups_due` returns nothing when false. |
| `firstAfterDays` | `7` | First follow-up due this many days after submission. |
| `secondAfterDays` | `14` | Second and last follow-up. Never earlier than the first, and never sooner after the first was sent than the gap between the two. |
| `ghostAfterDays` | `45` | Days after submission before a silent application is closed as `ghosted`. A follow-up sent late pushes closing back to at least 7 days after that follow-up. |

Only submitted applications with no reply beyond an acknowledgement are in the
cadence. One with a recorded screen, assessment, interview, offer or
rejection, one closed as ghosted or withdrawn, or one with a matched reply
still awaiting review, is left out (and counted under `excluded`).

`followups_due` lists what is due now, oldest first, with a draft, a suggested
channel and what falls due in the next week. Reminder rows are seeded in the
`followups` table (`application_id, kind, due_at, done_at, snoozed_until,
note, skipped`) as a side effect. `mark_followup` records a follow-up as sent
(`done`), resolves it without sending (`skip`: it does not count as contact, so
it neither spaces out the next reminder nor delays closing), or pushes it back
(`snooze`, 3 days by default). Once an application passes its close date, the
follow-ups it never got are moot: the next step listed is closing it, the same
set `close_stale_applications` would close, unless a snooze holds it. The
channel comes from the contacts saved with the career tools (a recruiter,
hiring manager or referral linked to the application or at the company, with an
email or profile link); otherwise it reads "no contact on file". The
`draft_follow_up` prompt turns the draft into a short message from verified
profile facts; it is never sent.

`close_stale_applications` records `ghosted` for applications that reached
that point with no reply beyond an acknowledgement. It is a dry run unless
`dryRun` is false; snoozed applications are skipped, and each closure is
tagged `no response in N days since <last contact> (auto-closed <date>)` with
an `outcome.auto_closed` event, so it is never confused with a rejection.

## Analytics definitions

`campaign_analytics {since?}` reads; it never changes anything.

- **Every rate is `{n, count, rate}`**, `rate = count / n`, `null` when `n` is
  0. A rate is never shown without its sample.
- **Cohort**: applications with status `submitted`, submitted on or after
  `since` when given.
- **Stages are cumulative** ("ever reached"): an application rejected after an
  interview counts as having reached the interview, and `acknowledged` counts
  everything that reached acknowledgement or later.
- **Funnel**: discovered (postings first seen), accepted (by tier), prepared,
  approved, submitted, acknowledged, screen or assessment, interview, offer,
  each with the rate from the previous stage and from submitted; plus
  replied, rejected, ghosted, withdrawn and in flight.
- **replied**: any reply beyond an automatic acknowledgement, rejections
  included. **advanced**: reached a screen, assessment or later.
  **in flight**: no reply, not closed, and younger than `ghostAfterDays`;
  not yet a failure.
- **Conversion** by tier, track, ATS kind, company tier, score band (`<70`,
  `70-79`, `80-89`, `90+`), location class, submission mode and ISO week
  submitted: submitted, replied, advanced, interviewed, offered, rejected and
  in flight per slice.
- **Response times**: days from submission to the first reply of each kind,
  median and 75th percentile with `n`. A reply that came through the inbox is
  dated by the email; otherwise by when the outcome was recorded.
- **Velocity**: submissions and first replies per ISO week (last 12 weeks),
  submissions in the last 7 and 30 days, and median days between stages
  (zero-length hops are catch-up entries and are excluded).
- **Rejection patterns**: rejections by the stage they ended at, the slices
  (at least 5 applications) rejected most often, and the gate rules that reject
  the most postings.
- **Calibration**: reply and advance rates by score band over *resolved*
  applications only (a reply, a closure, or older than `ghostAfterDays`;
  in-flight applications and withdrawals without a reply are excluded), and
  Spearman's rank correlation between score and the furthest stage reached
  (0 none, 1 acknowledged, 2 screen, 3 assessment, 4 interview, 5 offer). The
  correlation is withheld (`insufficientData: true`, with the reason) below
  30 resolved applications, below 3 that advanced, or when fewer than two
  score bands hold 5 or more.
- **Skill gaps**: terms from the shared technical vocabulary
  (`src/text/techVocabulary.ts`) found in the skill-bearing parts of the newest
  500 accepted postings (benefits, pay and legal sections are skipped), counted
  once per posting, that no spelling of appears in the profile's skills,
  aliases, facts or experience. `trend` compares the last 30 days with the
  period before, once each has 20 postings: rising or falling at a change of
  5 points or more. `strengths` lists the most requested terms the profile
  covers. The report never suggests claiming a skill.
- **Discards**: gate decisions (accepted, review, rejected), rejections by
  gate rule with share and up to three example reasons, by ATS, and per week.
- **Caveat**: tier, track and score are each posting's current evaluation; a
  re-scored campaign changes them retroactively.

The `weekly_review` prompt reads this and reports what is working, at most
three concrete changes, and skill gaps worth closing, never comparing slices
of fewer than 5 applications.

## Tracker export

`export_tracker {format: "csv" | "markdown"}` writes every application to
`<exports>/tracker-<YYYYMMDD-HHMMSS>.csv` (or `.md`), never overwriting an
earlier export. Columns: company, title, ats, track, tier, score, status,
submitted_at, latest_outcome, latest_outcome_at, url. CSV follows RFC 4180
(CRLF, quoted separators and quotes, UTF-8 with a byte order mark), and any
text cell that starts with `=`, `+`, `-`, `@`, a tab or a carriage return
(also behind leading spaces) is prefixed with `'`, so a company name or title
taken from a job board cannot run as a spreadsheet formula.

## Interview calendar files

`interview_calendar_file {start, durationMinutes?, title?, applicationId?, location?, url?, description?}`
writes `<exports>/interview-<title>-<start>.ics`: one RFC 5545 event with CRLF
line endings, escaped text, lines folded at 75 octets, times in UTC and a
30-minute reminder. `start` must carry a zone (`2026-11-10T10:00:00-08:00`);
a time without one is refused rather than guessed. With `applicationId` and no
title, the title is built from the posting.

## Tools and prompts

| Tool | Purpose |
|---|---|
| `scan_inbox {lookbackDays?, dryRun?}` | Read the mailbox for replies; record, propose or set aside each. |
| `review_replies {status?, limit?}` | Stored replies with evidence, match and reasons. |
| `confirm_reply {replyId, kind?, applicationId?}` | Record a reviewed reply as an outcome. |
| `dismiss_reply {replyId}` | Mark a reply as not an outcome. |
| `classify_reply {text, subject?, from?, applicationId?}` | Classify a pasted reply into a proposal. |
| `followups_due {horizonDays?}` | Follow-ups due now and soon, with drafts. |
| `mark_followup {applicationId, kind, action, days?, note?}` | Mark a follow-up sent (`done`), skipped (`skip`) or snoozed (`snooze`). |
| `close_stale_applications {dryRun}` | Close long-silent applications as ghosted. |
| `campaign_analytics {since?}` | The analytics above. |
| `export_tracker {format}` | CSV or Markdown tracker. |
| `interview_calendar_file {...}` | An .ics file for an interview. |
| `record_outcome` | Now also accepts `assessment`. |

Prompts: `review_replies`, `draft_follow_up {applicationId}`,
`weekly_review {since?}`.
