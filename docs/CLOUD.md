# Moving your workspace to another machine

`AUTOAPPLY_HOME` holds everything personal: the profile, campaign, companies, resume source, resume PDFs, fonts, generated documents and the application database. To run the server somewhere else, such as a cloud sandbox, move it as one encrypted bundle:

```bash
# On the machine you are leaving
export AUTOAPPLY_BUNDLE_PASSPHRASE="$(openssl rand -base64 32)"   # keep it; the bundle is useless without it
npm run home -- export --out ~/autoapply-home.aahb

# On the new machine, after cloning, npm ci and npm run build
export AUTOAPPLY_HOME="$HOME/.autoapply"
export AUTOAPPLY_BUNDLE_PASSPHRASE="..."                          # the same passphrase
npm run home -- import --in ~/autoapply-home.aahb
node dist/cli/doctor.js
```

The passphrase is read only from `AUTOAPPLY_BUNDLE_PASSPHRASE`, never from an argument, so it stays out of shell history and process lists. It must be at least 20 characters.

## What travels

| Carried | Not carried |
|---|---|
| `profile.json`, `campaign.json`, `companies.json`, `resume.json` | The secrets file (`.env`) and every environment variable |
| The resume files `profile.resumes` names, and the fonts (`.ttf`, `.otf`, `.woff`, `.woff2`) | Browser profiles: their cookies are signed-in sessions |
| Generated documents and saved evaluation reports (`--no-documents` leaves documents out) | Screenshots and other artifacts |
| The database's full history: applications, approvals, events, batches, follow-ups, outcomes, interviews, offers, contacts, stories and notes | Backups, tracker exports and anything else in the folder |
| The postings that history refers to, with their evaluations | Every other posting: the next `discover_jobs` brings them back with the same ids |

Only the files in the left column are read; nothing else in the folder is opened.

## What changes on the way

- **Paths.** Paths under the old home travel as a placeholder and are written under the new home on import, on any platform. A Windows workspace opens on Linux and back.
- **Approvals do not travel.** Each application that was approved arrives `awaiting_approval`, with an `application.approval_voided` event. Its packet names files at a new location, and an approval belongs to the machine where it was given. Nothing is submitted from the new machine until you approve it there.
- **Events.** Export records `home.exported` in the source database; import records `home.imported`.

## Keeping it safe

- The bundle is gzip inside AES-256-GCM with a scrypt-derived key. A wrong passphrase, or any change to the file, is refused before anything is written.
- Import refuses a home that already has a profile or database. `--force` replaces it after copying the replaced files to `backups/pre-import-<time>/`.
- Bundle entries are relative paths only; an entry that would land outside the home is refused.
- `*.aahb` is git-ignored, and `scripts/check-no-user-data.mjs` fails CI if one is ever tracked. Even encrypted, a bundle is personal data; never commit it.
- Move the bundle over a private channel and delete every copy you no longer need. If you host it briefly, for example in a secret gist, delete it once the import succeeds. Send the passphrase separately.

## Run from one machine at a time

The two databases do not sync. While both machines run discovery and submissions, each can apply to a posting the other already applied to, and each counts only its own applications toward `maxPerCompany`. Pick one machine to submit from. To move back, export from that machine and import with `--force` on the other.

## On a cloud sandbox

- **Browser.** Install it with `npx playwright install --with-deps chromium`. The career-site walkers (Google, Meta, Apple, Amazon) default to Chrome; set `AUTOAPPLY_BROWSER_CHANNEL=chromium` unless Chrome is installed.
- **Secrets.** Provide them as environment secrets of the sandbox, never in a file in the repository: `AUTOAPPLY_ATS_PASSWORD` for Workday-style accounts, and the `AUTOAPPLY_OTP_IMAP_*` mailbox for emailed verification codes. See [CONFIGURATION.md](CONFIGURATION.md).
- **Signing in again.** Browser sessions do not travel, so accounts on employer sites sign in again on the new machine.
- **CAPTCHAs.** Data-centre addresses are challenged and spam-flagged more often than a home connection. Expect more boards to need a person.
