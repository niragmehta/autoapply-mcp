import type { FontRole, FontSet } from "../fonts.js";
import type { ContactItem, ResumeHeader, ResumeTheme } from "../resumeSource.js";

/**
 * Pieces both document templates share: escaping, the header block and the
 * CSS that gives a resume and its cover letter the same design.
 */

const DEFAULT_MARGINS = "0.5in 0.64in 0.45in 0.64in";
const FALLBACK_SERIF = '"Latin Modern Roman", "CMU Serif", "Times New Roman", Times, serif';

/** Escapes text content. Quotes are left alone: they are safe in text and print the same. */
export function escapeText(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttribute(value: string): string {
  return escapeText(value).replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

/** Hyphenated or slashed terms ("STIG/CIS", "end-to-end"), which must never break across lines. */
const KEEP_WHOLE = /[A-Za-z0-9.#+]+(?:[-/][A-Za-z0-9.#+]+)+/g;

/** Keeps each hyphenated or slashed term on one line, so the ATS text layer holds it whole. */
export function keepWhole(html: string): string {
  return html.replace(KEEP_WHOLE, '<span class="nw">$&</span>');
}

/** Bullet markup: escaped, terms kept whole, and only [[figures]] in bold. */
export function markup(text: string): string {
  return keepWhole(escapeText(text)).replace(/\[\[(.+?)\]\]/g, "<b>$1</b>");
}

/** The terms in `text` that `keepWhole` protects. */
export function keepWholeTerms(text: string): string[] {
  return text.match(KEEP_WHOLE) ?? [];
}

const FACES: Array<{ role: FontRole; family: string; descriptors: string }> = [
  { role: "regular", family: "LMR10", descriptors: "font-weight: 400; font-style: normal;" },
  { role: "bold", family: "LMR10", descriptors: "font-weight: 700; font-style: normal;" },
  { role: "italic", family: "LMR10", descriptors: "font-weight: 400; font-style: italic;" },
  { role: "display", family: "LMR12B", descriptors: "font-weight: 700;" },
  { role: "small", family: "LMR9", descriptors: "font-weight: 400;" },
];

function fontFaceCss(fonts: FontSet): string {
  return FACES.flatMap(({ role, family, descriptors }) => {
    const data = fonts.faces[role];
    return data ? [`@font-face { font-family: "${family}"; src: url(data:font/ttf;base64,${data}) format("truetype"); ${descriptors} }`] : [];
  }).join("\n  ");
}

type FontStacks = { body: string; display: string; small: string };

/**
 * Font stacks for the body, the name and the contact line. With the fonts
 * present these are exactly the original's; a missing face falls back to the
 * body face and then to a serif stack.
 */
function fontStacks(fonts: FontSet): FontStacks {
  const body = fonts.faces.regular ? '"LMR10", serif' : FALLBACK_SERIF;
  return {
    body,
    display: fonts.faces.display ? '"LMR12B", serif' : body,
    small: fonts.faces.small ? '"LMR9", serif' : body,
  };
}

function pageMargins(theme: ResumeTheme): string {
  const margins = theme.margins;
  return margins ? `${margins.top} ${margins.right} ${margins.bottom} ${margins.left}` : DEFAULT_MARGINS;
}

/** CSS shared by every document: page, base type, header block and two-column rows. */
export function baseCss(theme: ResumeTheme, fonts: FontSet): string {
  const stacks = fontStacks(fonts);
  return [
    fontFaceCss(fonts),
    `@page { size: ${theme.pageSize}; margin: ${pageMargins(theme)}; }`,
    `* { hyphens: none; -webkit-hyphens: none; font-variant-ligatures: none; font-feature-settings: "liga" 0, "clig" 0, "dlig" 0; }`,
    `body { font-family: ${stacks.body}; font-size: 10pt; line-height: 1.19; color: #111; margin: 0; }`,
    `.accent { color: ${theme.accent}; }`,
    `.nw { white-space: nowrap; }`,
    `a { color: ${theme.linkColor}; text-decoration: none; }`,
    `.name { font-family: ${stacks.display}; font-weight: 700; font-size: 29.7pt; text-align: center; line-height: 1.0; }`,
    `.headline { text-align: center; font-size: 16.2pt; line-height: 1.22; color: ${theme.accent}; margin-top: 3px; }`,
    `.rule { width: 92%; margin: 15px auto 14px; border-top: 1.1pt solid #444; }`,
    `.contact { font-family: ${stacks.small}; font-size: 9pt; text-align: center; white-space: nowrap; margin-bottom: 11px; }`,
    `.contact .sep { margin: 0 2px; }`,
    `.row { display: flex; justify-content: space-between; align-items: baseline; }`,
    `.row.org > span:first-child { font-weight: 700; font-size: 10.5pt; }`,
    `.row.title > span:first-child { font-style: italic; }`,
  ]
    .filter((rule) => rule.length > 0)
    .join("\n  ");
}

/** A line with text on the left and an accent-coloured detail on the right. */
export function row(left: string, right: string, cls = ""): string {
  return `<div class="row ${cls}"><span>${left}</span><span class="accent">${right}</span></div>`;
}

function contactItem(item: ContactItem): string {
  return item.href ? `<a href="${escapeAttribute(item.href)}">${escapeText(item.text)}</a>` : escapeText(item.text);
}

/** Centred name, accent headline, rule and contact line. */
export function headerHtml(header: ResumeHeader): string {
  const lines = [`<div class="name">${escapeText(header.name)}</div>`];
  if (header.headline) lines.push(`<div class="headline">${escapeText(header.headline)}</div>`);
  lines.push(`<div class="rule"></div>`);
  if (header.contact.length > 0) {
    lines.push(`<div class="contact">${header.contact.map(contactItem).join(' <span class="sep">|</span> ')}</div>`);
  }
  return lines.join("\n  ");
}

export function documentHtml(title: string, css: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${escapeText(title)}</title><style>
  ${css}
  </style></head><body>
  ${body}
  </body></html>`;
}
