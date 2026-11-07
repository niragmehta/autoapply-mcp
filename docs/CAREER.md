# Interviews, offers, research and outreach

Getting an application in is half the job. These features cover what comes after: a story bank to interview from, preparation and practice for each round, debriefs, a read on red flags, company research, contacts and outreach drafts, and offers through to negotiation and the contract.

The split is the same as everywhere else in this server. **The server stores structured data and computes deterministic scaffolds; MCP prompts guide the agent through the conversational parts; nothing is ever sent.** Every message is a draft the candidate sends themselves, and every figure a draft or story states is checked against the verified profile first.

The workflows were designed after studying [career-ops](https://github.com/career-ops-hq/career-ops) (MIT); see `THIRD_PARTY_NOTICES.md`.

## Story bank

Five to ten **master stories** in STAR + Reflection form (situation, task, action, result, reflection), each built from profile facts and reused across every interview.

```
story_bank_scaffold    facts grouped by theme with their figures, competency coverage, uncited facts
save_story             create, or update with id; checks fact ids and figures
list_stories           filter by tag, skill or cited fact
delete_story
match_stories_to_job   best stories per requirement line of a stored posting, plus uncovered lines
```

**Themes.** A tag shared by two or more facts names a theme; a fact with no shared tag falls under its `category`. Each theme lists its facts with their `metrics` and the raw figures found in them.

**Competencies.** The scaffold reports which stories cover the competencies behavioral rounds probe (delivery, failure, influence, leadership, simplify, ownership, conflict, technical depth, customer) and which facts could seed a story for a gap. Tag a story with the competency id to mark it covered.

**Figure checks.** `save_story` rejects a story when any number in its result or action appears in neither the cited facts nor anywhere else in the profile, and names the offending tokens (`[unverified_figures] ... 90%, 2`). Evidence is the profile's facts (statement, metrics, evidence), experience, education, skills and headline. Compensation targets, contact details and form answers never count: a salary target is not an achievement.

The check is deliberately narrow:

- Values compare numerically: `1,200` = `1200`, and `$1.2M`, `1.2 million` and `1,200,000` all match.
- A percentage only matches a percentage: "led 40 engineers" is not evidenced by "40% faster". `40-50%` and `40 percent` are both percentages.
- Identifiers are not figures: EC2, P99, K8s, IPv6, 2FA.
- ISO dates in the profile keep only their year, so `2021-02` is evidence for "2021" but not for "2x".

Figures in the situation, task or reflection that the profile lacks produce a warning, not a rejection. So do a missing reflection, an uncited fact, a skill not in `profile.skills` and a story over about 320 words (two minutes spoken).

**Matching** is by term overlap using the shared text layer in `src/text/` (stop words, simple stemming). Tags, skills and the cited facts' tags count double. Requirement lines come from the posting's requirement and responsibility sections when it has them, otherwise from sentences that read as asks; benefits, pay and EEO text are left out. They are quoted from the posting and stay untrusted.

## Interviews

```
schedule_interview      stage, time, format, location or link, interviewers [{name, role}]
update_interview        any field, status scheduled | done | cancelled
save_interview_session  plan | practice | debrief | redflags, as Markdown
list_interviews         upcoming=true: scheduled from now on, plus ones with no time yet
interview_context       everything for prep in one read
```

Stages: `recruiter_screen`, `technical`, `system_design`, `behavioral`, `hiring_manager`, `onsite`, `other`. Times are stored as ISO 8601 UTC.

**Outcomes.** Scheduling a `recruiter_screen` records the `recruiter_screen` outcome and any other stage records `interview`, each only once per application, with an `outcome.recorded` audit event. Changing an interview's stage does the same unless it is cancelled. Recording an offer records `offer` once.

**interview_context** returns the job, its requirement lines and injection flags, the most relevant facts with metrics, the experience timeline, stories mapped to requirements (full text for the best eight), uncovered requirements, company notes, contacts, outcomes, every interview with panelist hints, the next interview and days until it, recent sessions (each capped at 4,000 characters), the stage guide, prep time blocks and the red-flag rubric. Pass `stage` to prepare for a different round and `hoursAvailable` to size the blocks in minutes.

**Panelist roles.** Interviewer titles are classified, first match wins, as executive, recruiter, hiring manager, peer or other, each with what that person tends to probe for and what to prepare. A classification is a hint; the candidate's knowledge overrides it.

| Role | Probes for |
|---|---|
| Recruiter | Motivation, compensation, location and authorization, timeline, communication |
| Hiring manager | Why this role now, scope held, first 90 days, judgment, delivery |
| Peer | Depth in the posting's core skills, applied trade-offs, quality, collaboration |
| Executive | Strategy and business impact, ownership at scale, values, long-term motivation |

**Prep blocks** split the hours available. The default (technical, system design, onsite): narrative 15%, priority domain 25%, secondary domain 20%, behavioral stories 15%, company research 10%, practice 10%, buffer 5%. A recruiter screen shifts weight to narrative, research and stories; hiring-manager and behavioral rounds shift it to stories. Studying stops 60-90 minutes before the interview.

**Red-flag rubric.** Five signals (scope ambiguity, defensive closure, evaluator competency gap, process signals, protected-grounds questions). A signal adds 1 when seen in one session and 2 in two or more, up to 10: 0-1 none, 2-3 caution, 4+ warning. These are observations, never verdicts; a question is never called illegal. `structuralSignals` adds deterministic observations: five or more rounds, repeated cancellations, an unpublished pay range, injection text in the posting, earlier red-flag notes.

## Company research

```
save_company_note   company, kind research | culture | comp | news | redflag, content, sources
company_notes       one company's notes, newest first; names match case-insensitively
```

The agent researches with its own web tools; the server keeps the result. Research, culture, comp and news notes must cite at least one source (an http(s) URL or a short citation). Content that reads like instructions to an AI agent is saved with a warning, and notes are returned to the agent marked as summaries of outside pages.

## Contacts and outreach

```
save_contact          company, name, role, kind, profileUrl, email, notes, source (required)
list_contacts         by company or kind; with applicationId, everyone relevant to it
outreach_scaffold     facts to cite, role context, structure for the recipient, limits, attachments
save_outreach_draft   enforces the channel's limits and checks every figure
list_outreach_drafts
mark_outreach         draft -> sent_by_user | discarded; discarded -> draft
```

Contacts hold only publicly found professional details, each with where it was found. Emails are never guessed from a pattern. Kinds: `recruiter`, `hiring_manager`, `peer`, `referral` (someone with a real prior relationship; a same-company stranger is a peer) and `other`. Saving the same name at the same company again updates that contact.

`contactsForApplication(db, applicationId)` returns everyone at the posting's company plus anyone an outreach draft for that application was addressed to, recruiters first.

| Channel | Hard limit | Soft limit | Subject |
|---|---|---|---|
| `linkedin_connect` | 300 characters | 200 (free accounts may be cut off there) | none |
| `linkedin_message` | 1,900 characters, 150 words | 700 | optional |
| `email` | 3,000 characters, 300 words | 1,500 | required |
| `referral_request` | 1,500 characters, 200 words | 900 | optional |
| `follow_up` | 1,500 characters, 180 words | 900 | optional |

Characters are counted as Unicode code points. Over the hard limit the draft is rejected (`too_long`); over the soft limit it is saved with a warning.

Recipient structures, three beats each: a recruiter gets fit, proof, an offer to share a resume; a hiring manager gets their team's challenge, a verified figure against it, a question about their approach; a peer gets a reference to their work, the shared space and a request for perspective, never for a job; a referral gets the shared history, the role and a direct ask.

**Figure checks for drafts.** Numbers must appear in the profile evidence above, or in the role's own records: the company name, the posting's title, id and published range, the contact's name and role, and for offers at that application or company the offer's figures and the negotiation plan's anchor, target and counter. The walk-away number is never accepted. Dates, times, links and email addresses are ignored. The candidate's phone number is accepted in email-like channels only. Warnings flag stock filler, a peer asked for a job, a referral request to someone who is not a referral, attachments promised on LinkedIn and an earlier unsent draft to the same person.

## Offers and negotiation

```
record_offer        terms, optional applicationId (fills company and title, records the offer outcome)
update_offer        patch any term or status; null clears an optional amount or date
list_offers         with normalized totals and days to the deadline
compare_offers      every active offer in the profile's currency
negotiation_plan    anchor, target, walk-away, counter, levers, expected value, risks
contract_checklist  clause walk and lawyer questions, flagged against an offer
```

Statuses: `received`, `negotiating`, `accepted`, `declined`, `expired`. Comparisons and competing-offer signals use `received`, `negotiating` (and `accepted` for comparison) unless `includeClosed` is set.

**Normalization.**

```
target bonus      = bonusTargetAmount, else base x bonusTargetPct / 100
recurring total   = base + target bonus + equityValueAnnual
first-year total  = recurring total + signOn
annualized total  = recurring total + signOn / signOnAmortizationYears   (default 4)
```

Relocation is reported separately and never counted as pay. Other currencies are converted with `campaign.compensation.fx`, never live rates; without a rate the comparison says so instead of guessing.

**compare_offers** reports each offer against `profile.compensation.targetTotal` and `minimumTotal`, against the posting's published range (position in range, base vs midpoint and top) and a salary gap after career-ops `salary-gap.mjs`: desired vs advertised vs offered, as `(to - from) / from`. Posted ranges are compared with base pay and the desired total with the annualized total. Aggregates count offers meeting the minimum and the target, and the mean and median gap between the posted midpoint and the offered base.

**negotiation_plan** works in the offer's currency:

- *Signals*: the profile's target, the total with base at the top of the posted range, and the best competing active offer.
- *Target*: the strongest signal above the offer; when the offer already beats every signal, a modest 5% ask.
- *Anchor*: the target plus 7%, capped at 25% above the offer unless the target itself is higher. Rounded to 1,000.
- *Walk-away*: the higher of the profile's minimum and the best competing offer. Private: never in a script, and never accepted by the draft figure check.
- *Counter*: base first, up to the posted range's top; anything left over becomes additional annual equity, or a sign-on covering the first year.
- *Expected value*: `EV = pImprove x captureRate x (anchor - offer) x horizonYears - pWithdraw x max(offer - best alternative, 0)`, with defaults 0.7, 0.5, 0.02 and 3 years, all overridable. These are illustrative assumptions, not data, and the plan says so; it also reports the withdrawal probability at which negotiating breaks even.
- *Levers*: base, sign-on, equity, level, start date, remote, and immigration support when the profile needs it for the posting's country (for example TN status).
- *Risks*: an offer below the minimum, a counter far above the offer, no market signal at all, a base already at the band's top, a close deadline, an accepted offer, options without strike and share details.

Proof points come from saved stories whose results carry figures, ranked by fit with the posting.

**contract_checklist** walks at-will employment, start date, notice and probation, base and bonus conditions, equity (vesting, cliff, acceleration, exercise window), sign-on and relocation clawbacks, non-compete, non-solicit, IP assignment and prior inventions, confidentiality, arbitration and class waiver, background-check contingencies, immigration support, severance, outside activities, the entire-agreement clause and benefits and location. Each clause carries neutral tags (`[commonly negotiated]`, `[ask your lawyer]`, `[standard]`), what to check and questions for a lawyer; with an offer id, clauses the offer makes relevant are flagged (a sign-on bonus flags the clawback clause). It is informational only: it never calls a clause safe, risky or unenforceable and states no law.

## Prompts

| Prompt | Arguments | Does |
|---|---|---|
| `build_story_bank` | - | Builds 5-10 master stories from the scaffold, one field at a time |
| `interview_plan` | applicationId | Time-blocked plan by days until the interview, mapped to requirements and stories |
| `interview_practice` | applicationId, stage | One question at a time with feedback, then saves the session |
| `interview_debrief` | applicationId | Structured debrief, lessons, a thank-you draft, saved session |
| `interview_red_flags` | applicationId | Rubric-scored observations, never verdicts |
| `research_company` | company | Strategy, news, culture, AI strategy and the candidate's angle, cited and saved |
| `find_contacts` | company or applicationId | Public contacts, saved, with a LinkedIn note of at most 300 characters |
| `draft_application_email` | applicationId | Subject, body and attachment checklist |
| `negotiate_offer` | offerId | Email and phone scripts on negotiation_plan numbers |
| `review_offer_contract` | offerId | Clause walk with the checklist and questions for a lawyer |

## Storage

Tables live in `src/db/schema/career.ts`: `stories`, `interviews`, `interview_sessions`, `company_notes`, `contacts`, `outreach_drafts` and `offers`. Application ids are soft references checked by the services rather than foreign keys, so pruning a job or application never cascades into interview history or an offer.

## Calling the services directly

The MCP tools are thin wrappers. The dashboard and run queue call the same functions in `src/career/`, passing a `Workspace` (or any object with `db`, `profile` and `campaign`):

```ts
storyBankScaffold(workspace)                       saveStory(workspace, input)
listStories(workspace, filter?)                    deleteStory(workspace, id)
matchStoriesToJob(workspace, jobId, perRequirement?)
interviewContext(workspace, applicationId, { stage?, hoursAvailable? })
scheduleInterview(workspace, input)                updateInterview(workspace, input)
saveInterviewSession(workspace, input)             listInterviews(workspace, { upcoming?, applicationId?, status? })
saveCompanyNote(workspace, input)                  companyNotes(workspace, company, { kind?, limit? })
saveContact(workspace, input)                      listContacts(workspace, filter?)
contactsForApplication(db, applicationId)
outreachScaffold(workspace, input)                 saveOutreachDraft(workspace, input)
listOutreachDrafts(workspace, filter?)             markOutreach(workspace, id, status)
recordOffer(workspace, input)                      updateOffer(workspace, input)
listOffers(workspace, filter?)                     compareOffers(workspace, options?)
negotiationPlan(workspace, offerId, assumptions?)  contractChecklist(context?) / contractChecklistFor(workspace, offerId?)
```

Invalid input fails with `invalid_input`; other stable error codes include `application_not_found`, `job_not_found`, `story_not_found`, `unknown_fact`, `unverified_figures`, `interview_not_found`, `interview_mismatch`, `sources_required`, `invalid_source`, `contact_not_found`, `too_long`, `subject_required`, `subject_not_allowed`, `outreach_not_found`, `invalid_transition` and `offer_not_found`.
