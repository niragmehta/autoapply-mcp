# Onboarding

Setting up autoapply-mcp takes three commands and one conversation. Nothing has
to be configured by hand except personal and demographic details, which stay
hand-edited on purpose.

```bash
npm install && npm run build
npm run init
npm run init -- --print-config vscode   # or copilot-cli, claude-desktop, claude-code, codex, cursor
```

Then run the `onboard` prompt in your MCP client.

## 1. `npm run init`

`init` scaffolds `AUTOAPPLY_HOME` (default `~/.autoapply`) and never overwrites a
file that already exists, so it is safe to re-run. `--force` is refused.

| Creates | From |
|---|---|
| `profile.json` | `examples/profile.example.json` |
| `campaign.json` | `examples/campaign.example.json` |
| `companies.json` | `presets/ai-security-us-canada.json` |
| `resume.json` | `examples/resume.example.json`, when the checkout ships it |
| `resumes/`, `resumes/fonts/`, `documents/`, `reports/`, `exports/`, `artifacts/`, `data/` | empty directories |
| `.env` (the secrets file, `AUTOAPPLY_SECRETS`) | a template of commented `KEY=` lines |

The secrets template lists `AUTOAPPLY_ATS_PASSWORD`, `AUTOAPPLY_OTP_IMAP_USER`,
`AUTOAPPLY_OTP_IMAP_PASSWORD`, `AUTOAPPLY_OTP_IMAP_HOST`,
`AUTOAPPLY_FOORILLA_API_KEY` and `AUTOAPPLY_DASHBOARD_TOKEN`, all commented out.
Keep the file private: never commit, share or paste it. The CLIs and the
dashboard read it; the MCP server receives its variables from the client's
`env` block instead.

`init` finishes by printing ready-to-paste MCP configuration for GitHub Copilot
CLI, VS Code, Claude Desktop, Claude Code, Codex and Cursor, with the absolute
path of this checkout's `dist/index.js` and your `AUTOAPPLY_HOME` filled in.
`--print-config <client>` prints one client's snippet alone on stdout (guidance
goes to stderr), so it can be redirected into a file. See
[CLIENTS.md](CLIENTS.md) for where each one goes.

## 2. The `onboard` prompt

`onboard` (optional argument `focus`, e.g. `work authorization`) walks the
agent through the profile section by section, writing each confirmed answer as
it goes:

1. `profile_status` - readiness and the prioritized next steps.
2. Target roles and tracks, then locations (`update_campaign`).
3. Compensation floor and target, read back before writing.
4. Work authorization for every country the campaign targets - asked, never
   assumed or inferred.
5. Dealbreakers and do-not-apply companies (`campaign.exclusions`,
   `campaign.hygiene.blacklist`).
6. CV import: the candidate pastes resume text, `import_resume_text` returns a
   scaffold, and the confirmed entries are appended with `update_profile`.
7. Facts with metrics, recurring application answers and resume files.
8. `profile_status` again to confirm readiness.

`campaign_setup` (optional argument `goal`) tunes tracks, keywords, thresholds,
exclusions and pace afterwards.

## Tools

### `profile_status`

Reads profile.json and campaign.json straight from disk, so it answers even
when a file is missing or invalid. It reports:

- required fields and whether they still hold example placeholders
  (`REVIEW`, `TODO`, `example.com`, `555-01`, `YYYY-MM-DD`, `Alex Candidate`, and
  the example profile's own "Your ..." / `path/to` stand-ins), by JSON pointer;
- each resume file, validated as a real PDF or DOCX;
- recurring answers that are blank or flagged `REVIEW`;
- work-authorization coverage of every country the campaign's locations
  target - an uncovered country is a blocker;
- compensation sanity (minimum at most target, no placeholder totals);
- counts of experience, education, skills, facts and narratives;
- campaign checks: each track's `resumeId`, the submission mode, an empty
  `allowedCompanies` (nothing can be submitted automatically), and
  `inbox.enabled` without IMAP credentials;
- `nextSteps`, blockers first, each naming the tool that fixes it.

Email and phone are masked (`a***@example.com`, `***-**00`); date of birth and
address are reported only as set or empty.

### `update_profile` and `update_campaign`

Each call takes up to 50 operations:

```json
{ "ops": [
  { "op": "set", "path": "/identity/phone", "value": "+1 604 555 2368" },
  { "op": "append", "path": "/skills", "value": { "name": "Go", "level": "strong" } },
  { "op": "remove", "path": "/answers/12" }
] }
```

- Paths are JSON pointers, limited to an allowlist. Profile: `identity`,
  `preferences`, `compensation`, `workAuthorization`, `skills`, `facts`,
  `experience`, `education`, `answers`, `narratives`, `resumes`. Campaign:
  `tracks`, `locations`, `compensation`, `exclusions`, `scoring/thresholds`,
  `freshnessDays`, `submission/mode`, `submission/dailyLimit`,
  `submission/maxPerCompany`, `submission/allowedCompanies`, `hygiene`,
  `documents`, `inbox`, `followUps`, `runner`.
- `personal` (date of birth, address, demographics) and the submission guard
  settings (allowed ATS domains, blocked question categories, batch size,
  delays) are not reachable: edit those by hand.
- The whole file is validated against its schema before anything is written.
  A failing edit writes nothing and returns the failing paths, never values.
- The file is patched as written, not as parsed, so schema defaults are not
  spelled out in a hand-maintained file. Writes are atomic, with a dated
  `.bak-` copy alongside.
- The configuration reloads immediately and an audit event records the changed
  paths.

Work authorization may only be written when the candidate states it
explicitly; `submission.mode` and `allowedCompanies` only when the candidate
asks.

### `import_resume_text`

A deterministic scaffold from pasted resume text: experience entries (company,
title, location, start and end as `YYYY-MM`, `YYYY` or `present`, highlights),
education, skills, and the bullets that carry metrics as proposed facts quoted
verbatim. Fields the heuristics cannot place are left empty and listed in
`needsConfirmation`. Contact details are reported only as detected or not. It
never writes; the agent confirms each item and saves it with `update_profile`.

## 3. Keeping up to date: `npm run update`

For a git checkout:

1. refuses to start while any file under `src/` has uncommitted changes, and
   lists them;
2. `git pull --ff-only`;
3. `npm ci` (or `npm install` when there is no lockfile);
4. `npm run build`;
5. `node dist/cli/doctor.js` against your existing configuration.

It never reads or writes `AUTOAPPLY_HOME`, apart from doctor's read-only
checks, and warns if `AUTOAPPLY_HOME` sits inside the checkout. Restart the MCP
client afterwards to load the new build. A checkout installed from npm is
updated with `npm install -g autoapply-mcp@latest` instead.
