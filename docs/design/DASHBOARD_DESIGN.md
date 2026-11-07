# Dashboard design

The visual system and the decisions behind the local dashboard (`web/`). It is an **Operate** surface: one person
uses it daily, on a laptop, to see where a job campaign stands and to steer it. Scanability, consistency, keyboard
use and clear states outrank expression; the identity lives in precise details.

Built with the impeccable design skill. Where the skill asks the user (product interview, direction choice), this
unattended build decided from the brief and the repository; every such decision is marked **Decided** below so it
can be revisited.

## Product context (inferred)

- **User.** The candidate running their own campaign: a technical senior engineer comfortable with JSON config, a
  terminal and an MCP agent. Uses the dashboard at a desk, morning and evening, often beside a terminal.
- **Purpose.** Know within seconds what changed and what is waiting on them, then act in place: answer held
  questions, approve exact packets, start and watch runs.
- **Positioning.** Deterministic and governed: the server never invents facts, approval binds to a packet hash,
  guards refuse rather than guess. The UI must make those boundaries visible, never blur them.
- **Constraints.** Loopback only; no CDNs, web fonts or tracking; no build step; demo data is synthetic.
- **Principles.** Refusing is recoverable, a wrong submission is not. Show provenance. A human decision is explicit
  and bound to exactly what was reviewed. Calm over urgency.

## Direction

**Decided:** *Station timetable and departure board.* The campaign reads as a transit line: every application is
somewhere between Discovered and Responded, and work held for the person is posted like a platform notice.

How it was chosen (skill flow, seed key `558dc1c8`, mode operate):

- **Mechanism:** a governed pipeline moving postings through gates, scoring, drafting and a hash-bound approval.
- **Scene:** one engineer at a laptop checking an overnight run, answering what is held, starting the next paced run.
- **Rut, kept out:** the KPI-card SaaS dashboard (big numbers in cards, sparklines, purple accent) and its opposite,
  the dark neon terminal.
- **Grounded candidates, by resonance:** 1. air-traffic flight progress strips; 2. shipping manifest with customs
  seal; 3. CI run view; **4. railway timetable and departure board**; 5. engineer's bound logbook; 6. Swiss grid
  typography; 7. library card catalogue. The seed assigned candidate 4.
- **Challengers weighed** (audience identification, product clarity): data-sublime barcode field (strobing and
  black-only, loses on clarity); orienteering map (spatial metaphor the product does not have); Crouwel grid
  specimen (poster scale, loses on density); Metro tiles (cropped giant type, loses on scanability); boarding pass and
  gate board (same family as the assignment, ties rather than wins; its "a changed row holds its colour" idea fits
  the world and informs the held plates); botanical folio (cream-and-serif rut, loses on density). None won both
  axes, so the assigned direction was built.
- **Stagings considered:** depth row, landmark horizon, tension commit. **Decided:** standard top bar and tables;
  a drag-to-commit control for submission would reinvent a standard affordance in an Operate surface. Wave 3
  replaced the top bar with the line-map rail (see Information architecture); the tables stayed.

The contract is recorded at the top of `web/index.html` (THESIS, OWN-WORLD, STORY, FIRST VIEWPORT, FORM).

**Decided:** light theme. The scene is daily desk use with long reading (packets, posting text) and the world is a
paper timetable; the navy rail carries the dark element. No dark theme is shipped.

## Information architecture (wave 3)

The dashboard grew from seven pages to fourteen when the after-applying features arrived (inbox, follow-ups,
interviews and offers, analytics, reports, documents, leads). Fourteen destinations do not fit a top band at laptop
widths, and a band that scrolls sideways hides pages.

**Decided:** a left rail drawn as the product's own line map, in five sections that follow the campaign:

| Section | Pages | Why together |
| --- | --- | --- |
| Pipeline | Overview, Jobs, Applications, Needs human, Documents | Everything before an application is sent. |
| After applying | Inbox, Follow-ups, Interviews and offers | What happens once the employer has it. |
| Insights | Analytics, Reports | Reading the campaign, not acting in it. |
| Sources | Companies, Leads | Where postings come from. |
| System | Runs, Health | Operating the tool itself. |

- Each section is a line; each page is a stop on it; the current page is the lit stop (a larger signal-yellow dot on
  a board-2 row). The motif is the Overview's route line turned vertical, so navigation and content share one world.
- **Badges.** Needs human keeps the only yellow count: it is the one thing held for the person before anything can
  move. Replies to review, follow-ups due, interviews this week and board proposals use a quiet board-2 count, so
  they inform without competing. Every count carries a screen-reader phrase ("3 replies to review").
- **Keyboard.** Every page keeps a `g` chord; new keys follow the noun where free (`d`ocuments, `i`nbox,
  `f`ollow-ups, `l`eads, `e`valuation reports) and a distinctive letter otherwise (`v` for interviews, `s` for
  stats). `registerView` refuses a duplicate key. The `?` dialog lists keys grouped by section.
- **Narrow screens. Decided:** below 1024 px the rail is replaced by a top bar (Menu, wordmark, live runs, and the
  yellow "N need you" chip, so held work stays one tap away) and the same map opens as a modal sheet that traps focus
  and closes on Escape, a choice or the backdrop.
- **Run types.** Ten run types do not fit a tab row either. The Runs page lists them in the same four sections as
  radio rows with a one-line purpose; below 1024 px the list becomes a grouped select so the form stays in view.

## Colour

Strategy: restrained neutrals, one action blue, one signal yellow for "held for you", and muted status tints.
Colour never carries meaning alone: every plate has text.

| Token | Value | Role | Contrast |
| --- | --- | --- | --- |
| `--paper` | `#f3f4f1` | Page ground | ink 16.2:1 |
| `--surface` | `#ffffff` | Tables, panels, inputs | ink-2 9.8:1, ink-3 6.2:1 |
| `--surface-2` | `#e9ece7` | Filter bars, toolbars, muted plates | ink-3 5.2:1 |
| `--rule` / `--rule-strong` | `#d6dad3` / `#80877e` | Hairlines / control boundaries | rule-strong 3.7:1 on white, 3.1:1 on surface-2 |
| `--ink`, `--ink-2`, `--ink-3` | `#121820`, `#3c4450`, `#59626e` | Primary, secondary, meta text | all at least 5.2:1 on every ground |
| `--board` | `#0b2545` | Rail, route line, tier A, meters | white 15.4:1, board-ink-2 9.8:1 |
| `--rail-line` | `#3a5679` | The rail's line under its stops (decorative, not text) | n/a |
| `--live` | `#7fd09a` | Running-run dot beside "N running" (always with text) | n/a |
| `--accent` | `#1f4fbf` | Primary buttons, links, selection, focus ring, progress | white on accent 7.2:1; on paper 6.5:1 |
| `--signal` | `#ffd31a` | Held for a person: needs-human plates, the needs-human count, the lit stop, held stations and rows | signal-ink 12.6:1; on board 10.7:1 |
| ok / bad / warn / info / muted | tint + ink pairs | Submitted, succeeded, accepted / failed, rejected / interrupted, review / running, queued, approved / cancelled, skipped | 7.2 to 8.2:1 |
| Log | `#10161e` ground | Run log, like a terminal pane beside the timetable; a "posting closed" tag is pink on deep red | text 13.8:1, time 6.5:1, tag 10.3:1 |

Status to tone mapping lives in `web/lib/format.js` (`tone()`), so every view agrees.

## Type

- **Family. Decided:** the system UI stack (`Segoe UI Variable`, Segoe UI, system-ui, SF, Helvetica Neue, Arial).
  Segoe is a Frutiger relative, the face of transit signage, so the world arrives without a web font.
- **Mono** (`Cascadia Mono`, ui-monospace, Consolas) only for ids, packet hashes, board slugs, paths, the packet
  preview and the run log: data, never decoration.
- **Numerals:** tabular everywhere (`font-variant-numeric: tabular-nums` on body) so counts and times align.
- **Scale** (fixed rem, ratio about 1.2): 12 meta and column heads, 13 secondary, **14 table and control body**
  (justified density for an operator console), 16 prose and posting text, 18 section titles, 22 page titles, 28
  station counts. Weights: 400 text, 600 labels and headings, 700 only for the wordmark and nav counts.
- Prose is held to 75ch (posting text, guidance); tables run wide.

## Space, shape, depth

- Spacing scale on a 4px base: 4, 8, 12, 16, 24, 32, 48. Groups are tight (4 to 12), sections separate at 32, more
  space above a heading than below.
- Radii: 2px for plates, buttons and inputs (crisp signage plates), 4px for panels.
- Depth only where an element floats: the drawer, toasts and the shortcut dialog, each an offset soft shadow.
  Everything else is flat with hairlines.

## Layout

- **Rail** (14rem, sticky, full height): wordmark and campaign; the line map in five sections with counts; at the
  foot, live runs, the local clock and a Shortcuts button. Below 1024px a top bar (Menu, wordmark, live runs, the
  yellow "N need you" chip) replaces it and the map opens as a sheet.
- **Page frame:** title, one line of context, page actions right. Then the page's working area, up to 100rem wide.
- **Drawer:** detail opens in a panel beside the table (36rem, 48rem for packets, logs, reports and interviews) so
  the list stays usable. It is URL state (`?job=`, `?app=`, `?run=`, `?interview=`, `?report=`), so it survives
  reloads and Back closes it.
- **Tabs** for pages with several views of one subject (Interviews and offers, Reports, the Inbox's reply
  statuses), kept in the URL (`?tab=`, `?status=`), with arrow, Home and End keys. They scroll sideways inside
  themselves on phones instead of widening the page.
- **Responsive:** at 1200px two-column splits stack; below 1024px the rail becomes the top bar and sheet, the drawer
  goes full screen, the run-type list becomes a select and analytics runs in one column; at 720px the route line
  turns vertical and filters stack. Mobile is secondary but complete.

## Components

| Component | Notes |
| --- | --- |
| Line-map rail | Sections as lines, pages as stops on a 2px line; the current page is a larger yellow dot on a board-2 row (no side stripe). Needs human's count is yellow; other counts are quiet board-2 plates. |
| Route line | The funnel as stations on a navy line: count above, dot, label, and notes below (tiers, "n not prepared", "n need you" in signal yellow, "n ready", today against the limit, "n replies to review", response kinds counted as nouns). A station with held work gets a yellow stop. Vertical on narrow screens. |
| Info rows | The Overview's after-applying timetable: a label column, the value with the numbers in bold, a chevron; held rows get the route line's yellow stop. Zero is said in words ("None due"). |
| Timetable | Ruled table, sticky header, sortable header buttons with `aria-sort`, rows focusable with j/k and Enter, selected row in accent tint (never a coloured side bar), skeleton rows while loading, a teaching empty state. The jobs table adds row checkboxes. |
| Bulk bar | Appears when rows are selected: count, the eligible actions with only the eligible count (jobs: reason field, Dismiss n..., Restore n; leads: Ignore n, Restore n to new), and why the rest are not eligible. Each refusal is reported. Resolved leads have no checkbox: they keep their status. |
| Dismiss confirmation | Dismissing is two steps in the list and the drawer: Dismiss... opens a held notice that takes the bulk bar's place (sticky in the list) and lists what happens, in words: the role and its copies leave the queue; an unsent application is set to skipped with a rejection on its current packet, so an earlier approval no longer lets it be sent, and it leaves prepared batches; restoring brings back the role, not the application. Focus moves into it, Escape keeps the role, and focus returns to the trigger. The toast repeats what the server reports it did (applications skipped, batches left). |
| Plates | Small rectangular status labels in tone tints; tier plates are navy (A), lighter navy (B), grey (C). "Posting closed" and "Closed" are bad-tone plates wherever a submit result or verdict appears. |
| Rates | "25% 3 of 12": the share in weight 600, the count beside it. Under ten cases the share loses its weight and reads "small sample". No rate is ever shown without its count. |
| Replies | A reply row: subject, sender and time, the snippet as plain text, what it reads as (kind, confidence, quoted evidence), which application (or the candidates), why it waits, then the decision form (outcome, application with likely candidates first, Record outcome, Dismiss). |
| Drafts | Follow-ups and outreach: the draft as wrapped text on paper, then Copy, "I sent it", Skip or Discard, Snooze. Copying never sends; "I sent it" records that you did. A skipped follow-up is never shown as sent: Recently handled lists each one with a Sent (ok) or Skipped (muted) plate, and Skip's tooltip and toast say it does not count as contact. |
| Run picker | Run types as radio rows in four sections with a one-line purpose; the form beside it. Close-stale opens as a dry run and needs an explicit confirmation to record. |
| Markdown reader | Reports and prep notes are rendered from text into elements (headings, lists, tables, code, quotes, http(s) links only); no HTML is ever inserted. |
| Buttons | Primary (blue), secondary (outlined), danger (outlined red text, for cancel and recording ghosted), ghost (link-like). Busy shows a verb ("Saving...") and `aria-busy`, not a spinner. |
| Controls | 32px inputs and selects with a 3:1 boundary, toggles for small multi-selects (tiers, tracks, statuses), segmented single choices, a switch for pausing boards, native checkboxes in accent colour. |
| Action rows | "Needs you" and check lists: count, label, detail, chevron. Held counts sit on a yellow plate. |
| Notices | Info, ok, bad, held. Held notices guard consequential steps (approval blocked, submit-run confirmation, recording ghosted, dismissing a role); bad notices explain a closed posting and the ways forward. |
| Run log | Dark pane, `role="log"`, time column, SENT green, SKIP, CLOSED and warnings amber, FAIL red, a "posting closed" tag on lines whose data carries `code: "posting_closed"` (never inferred from wording); follows the tail until the user scrolls up. |
| Toasts | Navy, polite live region, optional link ("Watch it", "Download"); failures stay twice as long. |

## States

Every interactive component has hover, `:focus-visible` (2px accent ring with a 2px surface gap; yellow ring inside
the navy rail, top bar and sheet), active, disabled (50% opacity, not-allowed cursor) and busy. Data regions have
loading (skeletons), empty (what will appear here and how to get it), error (what failed and Try again) and, for 401,
a signed-out screen pointing at the terminal link.

## Motion

State only, 150 to 250ms, exponential ease-out: hover tints, the drawer sliding in, toasts rising, progress fills
scaling. No page-load choreography. `prefers-reduced-motion` removes animations and transitions, and skeletons stop
shimmering.

## Accessibility

Semantic landmarks (header, nav, main, aside), a skip link, page titles per view, focus moved to `main` on navigation
and into the drawer heading on open (and back to the opener on close), keyboard shortcuts that ignore typing, form
labels on every control, `aria-pressed` toggles and segmented choices, `role="switch"`, `role="tablist"` with arrow,
Home and End keys, native radio groups for run types, nav lists labelled by their section, counts with a spoken
meaning, a modal menu sheet that keeps focus inside, live regions for toasts and the run log, and WCAG AA contrast
for all text and 3:1 for control boundaries. Reply text and posting text are untrusted and always rendered as text.

## Voice

Plain and specific, in the product's own words: "Approve packet", "Start submit run", "Answer 5 applications",
"Nothing is held for you", "I sent it", "Copy draft", "Preview (dry run)". Consequences are stated before
consequential actions ("Starting this run approves 3 packets exactly as stored and submits them"; "This records
'ghosted' on every application it lists"; "Tailoring makes it the file this application uploads; any approval is
void"; "Its unsent application is set to skipped and a rejection is recorded against its current packet"). Defaults
that matter are said plainly ("Dry run by default: it records nothing"). A label with "..." asks before it acts.

## Extending

A new page reuses the frame (PageHead, filters bar or tabs, DataTable, Drawer), the plate tones, rates with their
counts, and the action-row, info-row and notice patterns; it should not introduce new colours or type sizes.
Register it in `web/views/index.js` with a rail section and a free `g` key (see DASHBOARD.md).

## Verification log

### Wave 1 (seven pages)

- Two screenshot rounds at 1440x900, 1280x800 and 390x844 against a throwaway home with synthetic data. No console
  errors, no failed requests, no horizontal overflow in either round.
- Round 1 fixes: run ids wrapping in the overview board (compact board without the host note), drawer heading focus
  ring, form fields stretching in multi-column grids, check plates stretching, panel content spreading vertically,
  run forms running the full page width, location column order, 12-hour clock padding, mobile brand alignment and
  needs-human link wrapping.
- Round 2 confirmed each fix. Afterwards, without a further screenshot round: control boundary token darkened from
  `#aeb5ab` to `#80877e` to reach 3:1 (WCAG 1.4.11), and the stylesheet split into `web/styles/*.css` with no rule
  changes.
- The impeccable detector found no issues over `web/`. Interactive flows checked in a browser: `g n` navigation, the
  shortcut dialog, bulk answering (badge 8 to 4), approval from the drawer, Escape closing the drawer.

### Wave 3 (fourteen pages, line-map rail)

- Round r3: 32 views at 1440x900 and 1280x800 and 14 at 390x844 (including the menu sheet, the shortcut dialog and
  bulk selection), against a throwaway home with synthetic after-applying data and no-network stand-ins for the new
  run types. No console errors and no failed requests; four horizontal overflows at 390px.
- Fixed in one batch: a home-folder path (with the account name) in a document's next step, and in error messages
  generally, now shortened to `~`; tab rows wrapping and widening the page on phones (they scroll inside themselves);
  the rail's foot clipped at 800px tall (tighter stops); the Today panel stretching into an empty box; "2 interview"
  (counted nouns); a duplicated calibration notice and a missing space; "-13% up the range" (now "below the posted
  range"); a closed-posting notice pointing an unsent application at "withdrawn" (now "skip"), and Start submit run
  disabled while the posting reads closed; follow-up exclusions reading "1 a reply is awaiting review"; Markdown
  headings keeping the browser's bottom margin; redundant visible legends; camelCase labels ("ResumeSource"); Health
  repeating the home path on every row; on phones, the run-type list pushing the form below the fold (now a select);
  a one-posting "repost" shown as reposted; track ids instead of track labels in analytics; Copy beside the other
  draft actions.
- Round r3-confirm: no console errors, failed requests or overflow at any width; each fix checked on its screenshot.
  The impeccable detector found no issues over `web/`.
- The skill's separate finish-reviewer and documenter agents were not available to this sub-agent; their passes were
  done in-thread and this file is the documenter's record.

### Wave 3b (service gaps closed: follow-up skip, lead status, dismissal, closed-posting codes)

- Round r4: the touched views at 1440x900, 1280x800 and 390x844 (follow-ups with Recently handled, leads with a
  mixed selection, the jobs and drawer dismiss confirmations, a liveness run with closed postings, a submit run with a
  closed posting), then a real dismissal of a role with an approved application and its application read back. No
  console errors, failed requests or overflow.
- Fixed in one batch: the packet preview printed the resume's full path, home folder included (packet text, and the
  manual packet, now shorten it to `~` like every other path); the closed-posting notice still offered "skip this
  application" once it was skipped; a missing full stop after a quoted dismissal reason; raw event types in History
  ("application.prepared", now "Application prepared"); below 1024px the sticky selection bar and dismiss
  confirmation slid under the top bar (they now stop below it); Recently handled cut off its note column on phones
  (the note now sits under the outcome).
- Round r4-confirm: no console errors, failed requests or overflow; each fix checked on its screenshot. The impeccable
  detector found no issues over `web/`.

## Open items

- Filters take a full screen on phones; a collapsible filter bar would help mobile.
- No dark theme.
- Dense tables show 50 rows per page; virtualised scrolling was not needed at current volumes.
- Company proposals are read from the latest propose run's summary; proposals from earlier runs are not listed.
- The rail is 14rem; at 1280px wide the jobs table is dense but fits. A collapsible rail would help 1024 to 1280.
