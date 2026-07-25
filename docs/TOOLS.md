# Tool reference

All tools return JSON text. Failures return a structured message beginning with a stable error code in brackets, for example `[not_approved] no recorded human approval for this application`.

## Discovery and ranking

### `discover_jobs`
Fetches every configured board, normalizes postings, applies gates, scores survivors and stores results. Read-only with respect to employers.

| Input | Type | Notes |
|---|---|---|
| `companies` | `string[]?` | Restrict to named companies; defaults to all active boards |
| `includeIssues` | `boolean?` | Include per-board fetch failures (default true) |

Returns counts of postings fetched, new versus refreshed, and an evaluation summary with the top gate rejection reasons. A board that fails never aborts the run.

### `resolve_company_board`
Probes Greenhouse, Lever and Ashby for a company's public board slug. Board tokens are not published centrally, so verify rather than guess.

| Input | Type |
|---|---|
| `companyName` | `string` |
| `extraSlugs` | `string[]?` |

### `list_queue`
The ranked, de-duplicated shortlist. Roles already applied to are excluded by role fingerprint, so the same posting on a second board does not reappear.

| Input | Type |
|---|---|
| `minScore` | `number?` (defaults to the tier C threshold) |
| `tiers` | `("A"\|"B"\|"C")[]?` |
| `trackId` | `string?` |
| `limit` | `number?` (max 200) |

### `explain_job`
Full gate result and score breakdown with quoted evidence, plus the posting text wrapped as untrusted data.

| Input | Type |
|---|---|
| `jobId` | `string` |
| `includeDescription` | `boolean?` |

### `campaign_status`
Progress toward target, pipeline counts by status, tier distribution, top rejection reasons, queue depth, and track allocation (intended share versus what is actually queued).

## Drafting

### `prepare_application`
Builds the match report, loads the employer's application questions, drafts only the answers verified profile data supports, and selects the resume variant for the matched track. Creates a local draft; nothing is sent.

| Input | Type | Notes |
|---|---|---|
| `jobId` | `string` | |
| `force` | `boolean?` | Prepare even if the job failed the gates |

Returns the application id, status, packet hash, the match report, the questions needing a human, and the answers that were auto-filled with their citations.

Status will be `needs_human` when any question requires your decision, otherwise `awaiting_approval`.

### `set_application_content`
Records a cover letter and answers to questions the policy engine would not fill. Invalidates any prior approval, because approval is bound to content.

| Input | Type |
|---|---|
| `applicationId` | `string` |
| `coverLetter` | `string?` |
| `answers` | `{ questionKey, answer }[]?` |
| `notes` | `string?` |

### `preview_application`
Renders the exact submission packet - every field, its value, and where the value came from - plus the packet hash to approve. Unresolved required answers are listed explicitly.

## Approval and submission

### `approve_application`
Records the human decision authorizing submission.

| Input | Type | Notes |
|---|---|---|
| `applicationId` | `string` | |
| `packetHash` | `string` | Must match current content exactly |
| `decision` | `"approved" \| "rejected"` | Defaults to approved |
| `note` | `string?` | |

A mismatched hash fails with `packet_hash_mismatch`.

### `submit_application`
Runs every guard, then acts according to mode.

| Input | Type | Notes |
|---|---|---|
| `applicationId` | `string` | |
| `mode` | `"manual" \| "assisted" \| "auto"` | Cannot exceed the campaign's configured mode |
| `headless` | `boolean?` | Ignored in assisted mode |
| `keepOpenSeconds` | `number?` | Assisted mode: how long to leave the filled form open |

- `manual` returns the packet and apply URL for you to submit.
- `assisted` fills the hosted form in a visible browser, screenshots it, and leaves it open for you to review and submit.
- `auto` fills and clicks submit. Requires campaign mode `auto`, an allowlisted company, every required field fillable, and no unresolved questions.

### `record_submission`
Marks an application submitted after you sent it manually, keeping counts, pacing and duplicate checks accurate.

## Tracking

### `record_outcome`
Appends an outcome: `acknowledged`, `recruiter_screen`, `interview`, `offer`, `rejected`, `ghosted`, `withdrawn`.

### `list_applications`
Applications with status, target role and outcome history. Optional `status` and `limit` filters.

### `audit_log`
Recent recorded events with redacted payloads. Event types include `discovery.run`, `application.prepared`, `application.updated`, `application.approval`, `submission.manual_packet`, `submission.prepared`, `submission.submitted`, `submission.aborted`, `submission.blocked`, `submission.recorded` and `outcome.recorded`.

### `reload_config`
Re-reads all three configuration files so edits apply without restarting the server.
