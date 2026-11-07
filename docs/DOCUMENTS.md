# Tailored resumes and cover letters

autoapply-mcp can render the resume it uploads from a structured source instead of using one fixed PDF per track:

- **Tailored resume**: for each application, the bullet groups, bullets and skills are reordered by relevance to that posting, the candidate's own reserve bullets and skills come in where the posting calls for them, and the result is printed to a verified PDF that replaces the track's variant on the application.
- **Fixed variants**: the same source renders the per-track PDFs that `profile.resumes` points at.
- **Cover letters**: the agent writes the letter from a server-built scaffold; the server fact-checks it, stores it on the application and can render it as a PDF in the resume's design.

Nothing here writes content. Tailoring reorders, swaps in reserve content the candidate wrote into the source, and only when the page overflows, drops; the agent's prose (a headline, a letter) must pass a fact check against the candidate's own evidence. The approach follows [career-ops](https://github.com/career-ops-hq/career-ops) (MIT): a CV rendered per job from the candidate's own material, with a fact check in code.

## Turning it on

Everything is off by default. In `campaign.json`:

```json
"documents": {
  "tailorResume": true,
  "coverLetterPdf": false,
  "minBulletsPerRole": 2,
  "maxSwaps": 2,
  "maxAddedSkills": 4
}
```

| Field | Default | Effect |
|---|---|---|
| `tailorResume` | `false` | `prepare_application` ends by rendering a tailored resume and attaching it. A failure keeps the track variant and is reported in the result's `documents.warning`; it never blocks a preparation. |
| `coverLetterPdf` | `false` | `save_cover_letter` also renders a PDF unless the call says `renderPdf: false`. |
| `minBulletsPerRole` | `2` | Fewest bullets a role keeps when bullets are dropped to fit the page. |
| `maxSwaps` | `2` | Most [reserve bullets](#reserve-bullets-and-skills) a tailored resume swaps in for different printed work. Upgrades don't count. `0` allows upgrades only. |
| `maxAddedSkills` | `4` | Most reserve skill terms a tailored resume adds because the posting names them. |

`prepare_batch` prepares through the drafting layer directly and does not tailor; run `tailor_resume` on each application, or the `tailor_application_documents` prompt, when a batch should carry tailored resumes.

## Tools and prompt

| Tool | What it does |
|---|---|
| `tailor_resume {applicationId, headline?}` | Renders, verifies and attaches a tailored resume; returns the change log. An optional headline must pass the fact check. |
| `cover_letter_scaffold {applicationId}` | Company, role, the posting's top requirements paired with proof points, gaps, keywords safe to mirror, structure and word budget. |
| `save_cover_letter {applicationId, text, renderPdf?}` | Fact-checks and stores the letter (voiding approval); optionally renders the PDF. |
| `render_resume_variant {resumeId}` | Rebuilds a fixed track variant into `documents/variants/<resumeId>.pdf`. |
| `document_status {applicationId}` | Which resume will be uploaded and whether it is tailored, the letter and whether its PDF matches the text, and the document history. |

The `tailor_application_documents` prompt (argument `applicationId`) walks an agent through all of it: tailor, optionally propose a headline, write the letter from the scaffold, save it, then `preview_application`. Approval stays with the candidate.

## resume.json

The source lives at `AUTOAPPLY_HOME/resume.json` (override with `AUTOAPPLY_RESUME_SOURCE`). Start from [`examples/resume.example.json`](../examples/resume.example.json), which renders a complete one-page resume for a fictional candidate.

```json
{
  "version": 1,
  "header": {
    "name": "Alex Candidate",
    "headline": "Software Engineer",
    "contact": [
      { "text": "Toronto, Canada" },
      { "text": "alex@example.com", "href": "mailto:alex@example.com" }
    ]
  },
  "theme": { "accent": "#FF6A3D", "linkColor": "#3A95D7", "pageSize": "A4", "align": "left" },
  "sectionTitles": { "additional": "Previous Internships" },
  "maxPages": 1,
  "experience": [
    {
      "organization": "Northwind Logistics",
      "location": "Toronto, Canada",
      "roles": [
        {
          "title": "Senior Software Engineer \u2013 Platform",
          "dates": "Mar 2021 \u2013 Present",
          "groups": [
            {
              "id": "platform",
              "label": "Developer platform",
              "bullets": [
                {
                  "id": "k8s-migration",
                  "text": "Led the migration of [[120+]] services to Kubernetes.",
                  "factIds": [],
                  "tags": ["migration"]
                }
              ]
            }
          ]
        }
      ]
    }
  ],
  "additional": [{ "organization": "Bluefin Analytics", "location": "Boston, USA", "title": "Software Engineer Intern", "dates": "Jun 2019 \u2013 Aug 2019" }],
  "education": [{ "institution": "University of Example", "location": "Toronto, Canada", "credential": "BASc, Software Engineering", "dates": "Sep 2015 \u2013 Apr 2020" }],
  "skills": { "categories": [{ "id": "infrastructure", "terms": ["Kubernetes", "Terraform", "AWS"] }] },
  "variants": {
    "platform": { "headline": "Platform Engineer", "groupOrder": ["platform"], "skillOrder": ["infrastructure"] }
  }
}
```

| Field | Notes |
|---|---|
| `header` | `name`, `headline` (accent line under the name) and `contact` items. An item with `href` (`https://`, `mailto:` or `tel:`) prints as a link. |
| `theme` | `accent` and `linkColor` are hex colours; `pageSize` is `A4` or `Letter`; `align` is `left` or `justify` (justify stretches lines, since hyphenation is always off); optional `margins` `{top, right, bottom, left}` as CSS lengths (`0.5in`, `12mm`, `36pt`). Defaults reproduce the original design: margins `0.5in 0.64in 0.45in 0.64in`. |
| `sectionTitles` | `experience`, `additional`, `education`, `skills`; defaults "Experience", "Previous Roles", "Education", "Technical Skills". |
| `maxPages` | `1` or `2`. Rendering fails verification above it. |
| `experience[]` | An organization with one or more roles. A role holds bullet groups; a group with a `label` prints the label in italics, one without prints its bullets straight under the title. The first entry sits under the section title; later entries get a gap. |
| bullet `id` | Unique across the file; the change log and variants refer to bullets by id. |
| bullet `text` | Printed as written. Wrap figures in `[[...]]` to set them in bold, the only bold a bullet carries. |
| bullet `factIds`, `tags` | Never printed. They add matching terms (a fact's tags count too) and link a bullet to `profile.facts` for cover-letter proof. |
| bullet `keep` | Tailoring never swaps this bullet out or drops it to fit the page, and it stays ahead of the bullets in its group that aren't kept. Its upgrade may still restate it. |
| bullet `reserve`, `replaces`, `upgrade` | A reserve bullet stays off every fixed variant; tailoring may print it instead of a printed bullet. See [Reserve bullets and skills](#reserve-bullets-and-skills). |
| `additional[]` | One-line entries such as earlier internships: **Organization**, location — title, dates. |
| `skills.categories[]` | Terms print comma-separated, categories separated by a bullet. An optional `label` prints in italics before the terms. Optional `reserve` terms print only on a tailored resume whose posting names them. |
| `variants` | Keyed by `profile.resumes` id. `headline` replaces the header headline; `groupOrder` and `skillOrder` list ids to print first (the rest follow in source order); `includeBullets` keeps only the listed bullets (a reserve it lists prints like any other bullet); `excludeBullets` drops bullets and keeps a reserve from being offered. Groups left empty disappear. |

Validation names every problem by path: duplicate ids, a variant referring to an id that does not exist, an unclosed `[[`, a colour or length that is not a plain value (theme values are written into CSS, so nothing else is accepted), a link with another scheme, and reserve fields used where they cannot apply.

### Reserve bullets and skills

A resume that fits one page leaves out work that matters to some postings. Write that work into the source as reserve bullets: they never print on a fixed variant, so the PDFs `profile.resumes` points at stay exactly as they are, and tailoring brings a few in where a posting calls for them.

```json
"bullets": [
  { "id": "k8s-migration", "text": "Led the migration of [[120+]] services to Kubernetes.", "keep": true },
  { "id": "ci-pipeline", "text": "Maintained the CI pipeline for the platform team." },
  {
    "id": "ci-pipeline-figures",
    "text": "Rebuilt the CI pipeline on GitHub Actions, cutting median build time from [[14]] to [[5]] minutes.",
    "reserve": true,
    "upgrade": true,
    "replaces": ["ci-pipeline"]
  },
  {
    "id": "fraud-model",
    "text": "Shipped a fraud-scoring service handling [[3,000]] requests a second at p99 under [[40 ms]].",
    "reserve": true,
    "tags": ["machine learning", "low latency"]
  }
]
```

- **Upgrade** (`upgrade: true`, naming exactly one printed bullet in its own group in `replaces`): the same work, stated more strongly. A tailored resume prints it in that bullet's place whenever it suits the posting at least as well, and it doesn't count against `maxSwaps`.
- **Swap** (any other reserve): different work. It may displace a printed bullet in its own role, only the ones it names in `replaces` when it names any, and never one marked `keep`.
- **Reserve skills** (`skills.categories[].reserve`): terms added to their category when the posting names them by a phrase of the skill, or by the word itself for a one-word skill. "Azure Data Explorer" needs "data explorer", not just "data".

Upgrades and swaps cost the page nothing they don't earn: if a longer reserve overflows it, the usual page fitting drops the least relevant bullet that may go.

Validation refuses a reserve marked `keep`, `replaces` naming anything but a printed bullet in the same role, a swap naming a kept bullet, an upgrade that doesn't name exactly one printed bullet in its own group, and a reserve skill already printed in its category.

## Design and fonts

The template reproduces the candidate's original LaTeX resume in the style of "Jake's Resume": Latin Modern Roman, coral headline and section titles, a centred name, headline and contact line with a rule under the header, role rows with the location and dates right-aligned, italic group labels and hanging bullets. Hyphenation and ligatures are off and every hyphenated or slashed term (`CI/CD`, `zero-downtime`) is kept on one line, so the PDF's text layer carries each term whole for an ATS. The HTML embeds everything it needs and loads nothing.

Given the same content, the repository template prints a PDF identical to the original script's, byte for byte apart from the creation date.

### Fonts

Latin Modern is not bundled. Put these TrueType files in `AUTOAPPLY_HOME/resumes/fonts` (or point `AUTOAPPLY_FONTS` at another folder):

| File | Used for |
|---|---|
| `lmroman10-regular.ttf`, `lmroman10-bold.ttf`, `lmroman10-italic.ttf` | Body, bold and italic text |
| `lmroman12-bold.ttf` | The name |
| `lmroman9-regular.ttf` | The contact line |

**They must have TrueType outlines.** Chromium embeds a font with CFF (PostScript) outlines as Type3, and ATS parsers read Type3 text poorly. The Latin Modern distribution ships `.otf` files with CFF outlines, so convert them once:

1. Download the `lm` package from [CTAN](https://ctan.org/pkg/lm) or [GUST](https://www.gust.org.pl/projects/e-foundry/latin-modern) and take `lmroman10-regular.otf`, `lmroman10-bold.otf`, `lmroman10-italic.otf`, `lmroman12-bold.otf` and `lmroman9-regular.otf` from `fonts/opentype/public/lm/`.
2. Convert each to TrueType, keeping the base name, with [fontTools](https://github.com/fonttools/fonttools) (`pip install fonttools`, then its `otf2ttf.py` snippet from `Snippets/`) or with FontForge: `fontforge -lang=ff -c 'Open($1); Generate($2)' lmroman10-regular.otf lmroman10-regular.ttf`.

Latin Modern is distributed under the [GUST Font License](https://www.gust.org.pl/projects/e-foundry/licenses), which permits converting the fonts for your own use; if you ever redistribute converted files, follow its conditions for modified versions. A file that is missing or still has CFF outlines is skipped with a warning, and the face falls back to a serif stack (`Latin Modern Roman`, `CMU Serif`, `Times New Roman`).

## How tailoring decides

`tailorResume(source, variantId, job, profile, options)` is deterministic: the same inputs always give the same resume and the same change log.

1. Start from the application's track variant (its `resumeId`). A variant the source does not define starts from the source order, and the log says so.
2. Extract the posting's terms: single words and two- or three-word phrases. A term is worth the weight of the most important section it appears in (title 3, requirements 2, responsibilities 1.5, preferred and unlabelled text 1, company and benefits boilerplate 0), half as much again for each further line that repeats it (up to four), and half as much again when it is a phrase, so where a term appears matters more than how often. Stop words, generic posting vocabulary ("experience", "years", "issues") and verbs or adjectives ("strong", "operating") never count on their own. A profile skill's aliases fold onto its name, so `k8s` and `Kubernetes` match; a hyphen between letters reads as a space, so `least-privilege` and `least privilege` match; and a slashed compound names its parts (`Python/Go` is evidence of Python).
3. Score each bullet by the weighted overlap between those terms and the bullet's text, tags and linked facts' tags; a phrase match counts once, not again for each of its words.
4. Bring in reserves. Each printed bullet with an upgrade gets the most relevant one that scores at least as well as it does. Then, up to `maxSwaps`, a reserve worth at least 4 (about two requirement terms) displaces a printed bullet that is not kept, in its role, when it beats that bullet's strongest statement (its upgrade, if it has one) by at least 2. The biggest gains go first, no bullet is swapped twice and no group is emptied. An upgrade prints where the bullet it restates stood; a swap joins its own group. Then add up to `maxAddedSkills` reserve skills the posting names, the most relevant first.
5. Within each role, order bullets inside each group by score, kept bullets first, and the groups by their best bullet plus their mean plus their label's score. Order skill categories and the terms inside them the same way; skill terms are never removed. Ties keep the variant's order, so a posting that shares nothing with the resume leaves the variant exactly as it was, apart from its upgrades and its kept bullets moving to the front of their groups.
6. Render. While the PDF exceeds `maxPages`, drop the least relevant bullet that may go (the later one among equals) and render again. A kept bullet never goes, a role never falls below `minBulletsPerRole` and a group never loses its last bullet; if the page still overflows, verification fails and the variant stays attached.
7. Headline: the variant's, or an agent-supplied one that passes the fact check. The headline check gets no posting context, so the target job's title cannot become the candidate's headline unless they have held it.

Every change is logged, for example `moved group "platform" from 3 to 1 in Northwind Logistics / Senior Software Engineer – Platform because of terms [platform, ci/cd pipeline, github actions]`, `swapped reserve "fraud-model" in for "ci-pipeline" (relevance 14 vs 3.5) because of terms [machine learning, low latency]` or `replaced "ci-pipeline" with reserve "ci-pipeline-figures", a stronger statement of the same work (relevance 6 vs 4)`, along with each added skill and each dropped bullet and its score. The `tailor_resume` result also lists the swaps (`in`, `out`, `upgrade`, both scores) and the added skills. Only upward moves are logged; an item pushed down by another has nothing to explain.

## The fact check

`checkFacts(text, corpus)` reports, and `assertFacts` refuses with `fact_check_failed`, any claim the evidence does not hold. The corpus is every string in resume.json plus the profile's identity, work-authorization statement, relocation targets, skills with aliases, facts (statements, metrics, tags, evidence), experience and education.

| Checked | Rule |
|---|---|
| Figures | Every count, percentage, sum of money and "N+" figure must appear in the corpus. A magnitude is part of the number: `40k`, `40,000` and `40 thousand` are one value, and none of them matches a source that says 40. A percentage or a sum must match one of its own kind; a bare count may match any. |
| Named terms | Stylized names (`TypeScript`, `GCP`, `C#`, `.NET`, `Node.js`, `CI/CD`), common technology names in any case (`terraform`) and capitalized words not starting a sentence must be in the corpus. Adjacent names form one phrase; a hyphen's lowercase part belongs to the sentence (`Kubernetes-based` names Kubernetes); `APIs` is the plural of `API`. A Title Case headline is checked word by word. |
| Employers | "worked at X", "my internship at X", "joined X", "At X, I ..." must name an organization or school from the source or profile; a short form of a real name passes. |
| Titles | Capitalized job titles ("Senior Software Engineer II") must be a title or headline from the source or profile. "Hiring Manager" and similar letter conventions are ignored. |
| Dates | Month-year and season-year dates must appear in the source or profile. |

A cover letter is checked with the posting as context:

- The employer's name and initials, the role's title and the posting's locations may be named.
- What the posting says outside its requirements (the employer's products, teams and places) may be named too. A technical name from there passes only in a sentence that is not about the candidate: "your team's Kafka platform" passes, "my Kafka experience" needs evidence. A skill that appears only in the requirements never passes on the posting's word.
- A title introduced with "the" that is part of the job's title ("the Staff Engineer, Platform role") names the job; "I was a Staff Engineer" is still a claim to check.

A headline is checked without any posting context, so the target job's title cannot become the candidate's headline.

Each failure names its kind and token, for example `number "$5M"`, `term "Rust"`, `title "Principal Engineer"`. The fix is to remove or correct the claim, or, if it is true, to add the evidence to `profile.json` or `resume.json`; generated text is never a source.

Limits: the check judges what is claimed, not how it is worded, so a reworded sentence with the same figures and names passes. A phrase made of individually known words passes even if the combination is new, a capitalized word that starts a sentence is only checked when it looks technical, and a technology the shape rules and the built-in lists do not recognize passes when the posting's description happens to name it. Abbreviations are not expanded (`M365` is not `Microsoft 365`), and naming a technology to say the candidate lacks it is flagged like a claim. Read every document before approving it.

## PDF verification

Every rendered PDF is read back through its text layer (pdfjs-dist) before it is used:

- page count within `maxPages` (one for a cover letter);
- no ligature glyphs (U+FB00-FB06) and no soft hyphens;
- no word hyphenated across a line break and no hyphenated or slashed source term split across lines;
- every bullet, the name and headline, and every skill term present, compared without whitespace;
- a warning when any font was embedded as Type3.

A failure is `document_verification_failed` and nothing is attached. pdfjs-dist is a development dependency; where it is not installed only the page count is checked and the result says so.

## Cover letters

`cover_letter_scaffold` returns:

- `company`, `role`, `location`;
- `requirements`: up to five of the posting's requirement and responsibility lines, quoted in at most 160 characters, each with up to two proof points (`kind` fact or bullet, `id`, linked `factIds`, the statement and the matched terms), ordered by importance times evidence;
- `gaps`: requirements nothing in the evidence supports, to leave out;
- `keywordsToMirror` and `keywordsNotSupported`: the posting's strongest terms split by whether the evidence contains them;
- `structure`: why this company (50-80 words), proof (150-220), close (30-60); `wordBudget` 250-400 words, at most one page;
- `rules`, the posting's `injectionFlags` and any `existingCoverLetter`.

`save_cover_letter` fact-checks the letter, stores it through `set_application_content` (which voids any approval and recomputes the packet hash, as every content change does) and returns the new `packetHash`, the word count and style warnings (cliches, length). With a PDF requested it renders the letter in the resume's design: the same header as the application's resume variant (from resume.json, or from the profile's identity when there is none), the company and date set like an organization row, the role and location like a title row, the body and a sign-off. A salutation and a sign-off in the text are used as written, so the PDF never prints them twice. A PDF that cannot be made is reported in `pdf.error`; the saved letter stands.

The letter's text is what the packet carries and what form-filling types into a cover-letter box. The PDF is stored and listed by `document_status` for forms that want a file; the browser engine does not attach it to upload fields on its own.

## Where things are stored

```
AUTOAPPLY_HOME/
  resume.json                         the source (AUTOAPPLY_RESUME_SOURCE)
  resumes/fonts/*.ttf                 Latin Modern TrueType files (AUTOAPPLY_FONTS)
  documents/                          AUTOAPPLY_DOCUMENTS
    <applicationId>/resume-<sha8>.pdf
    <applicationId>/cover-letter-<sha8>.pdf
    variants/<resumeId>.pdf
```

The `tailored_documents` table keeps one row per rendered file: `application_id`, `kind` (`resume` or `cover-letter`), `path`, `sha256`, `variant_id`, `changes_json` (the change log), `checks_json` (verification, warnings, dropped bullets; for a letter the hash of the text it was rendered from) and `created_at`. Attaching a tailored resume sets the application's `resumePath`, recomputes its packet hash and moves an approved application back to `awaiting_approval`: the approval was for different content. Submission guards then validate the new file like any other resume.
