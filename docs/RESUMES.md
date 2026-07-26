# Resumes

The server uploads a real file to the employer's form. That file is validated before an application can be approved, so a missing, empty or mislabelled resume fails loudly instead of producing a submission with no attachment.

## What the validator requires

`prepare_application` and the submission guard both run `validateResumeFile`:

| Check | Result if it fails |
|---|---|
| Path configured in `profile.resumes[].path` | `resume_unusable` |
| File exists and is a file, not a directory | `resume_unusable` |
| File is non-empty | `resume_unusable` |
| `.pdf` files begin with the `%PDF-` signature | `resume_unusable` |
| `.docx` files are valid zip containers | `resume_unusable` |
| Under 25 MB | `resume_unusable` |
| Under 5 MB | warning only - many ATS reject larger uploads |

A failure sets the application to `needs_human` and reports `resumeBlocker`. Submission is refused with `resume_unusable`, and an upload failure during an assisted or auto run aborts rather than continuing.

PDF is the right choice. It is what ATS parsers handle most reliably, and it preserves LaTeX typesetting exactly.

## Variants

`profile.resumes` binds a file to one or more campaign tracks:

```json
{
  "id": "ai-security",
  "label": "AI Security",
  "path": "C:/Users/you/autoapply-mcp/config/resumes/ai-security.pdf",
  "tracks": ["ai-security"],
  "isDefault": true
}
```

`selectResume` picks the variant whose `tracks` contains the matched track, falling back to `isDefault`, then to the first entry. Pointing several variants at the same file is valid - it just means every track uploads the same document.

Use absolute paths. Forward slashes work on Windows and avoid JSON escaping.

## Building variants from LaTeX

One LaTeX source with a switch is easier to maintain than three diverging files.

```latex
% resume.tex
\documentclass[letterpaper,10pt]{article}
% Set with: \def\variant{aisecurity}
\providecommand{\variant}{software}

\begin{document}
\ifx\variant\undefined\fi

\ifnum\pdfstrcmp{\variant}{aisecurity}=0
  \input{sections/summary-ai-security}
\else\ifnum\pdfstrcmp{\variant}{cloudsecurity}=0
  \input{sections/summary-cloud-security}
\else
  \input{sections/summary-software}
\fi\fi

\input{sections/experience}
\input{sections/education}
\end{document}
```

Build each variant by overriding the macro:

```bash
pdflatex -jobname=ai-security    "\def\variant{aisecurity}\input{resume.tex}"
pdflatex -jobname=cloud-security "\def\variant{cloudsecurity}\input{resume.tex}"
pdflatex -jobname=software       "\def\variant{software}\input{resume.tex}"
```

Then copy the three PDFs into `config/resumes/` and point `profile.resumes[].path` at them.

### If you build on Overleaf

Overleaf has no local toolchain requirement. Either keep three projects, or keep one project and change the `\variant` line before each download. Download as PDF and drop the files into `config/resumes/`.

### If you want to build locally

[Tectonic](https://tectonic-typesetting.github.io/) is a single self-contained binary that downloads packages on demand, which is far lighter than a full TeX Live install:

```bash
winget install TectonicProject.Tectonic
tectonic resume.tex
```

## Keeping resumes out of git

`config/` is gitignored. Resumes contain personal contact details and should not be committed to a repository you intend to open source. Keep the LaTeX sources wherever you already keep them and treat `config/resumes/` as build output.

## What to tailor per variant

Only the parts that change the reader's first impression:

- The headline and summary
- Bullet ordering, so the most relevant work appears first
- Which technologies are named in the skills line

Do not change facts, dates, titles, employers or metrics between variants. The match report's `claimsToAvoid` list exists to keep tailoring honest: emphasis may shift, substance may not.
