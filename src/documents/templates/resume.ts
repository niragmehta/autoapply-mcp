import type { FontSet } from "../fonts.js";
import type { ResumeDocument } from "../model.js";
import type { AdditionalEntry, BulletGroup, ExperienceEntry, ResumeBullet, ResumeEducation, ResumeRole, SkillCategory } from "../resumeSource.js";
import { baseCss, documentHtml, escapeText, headerHtml, markup, row } from "./shared.js";

/**
 * The resume template, after the candidate's LaTeX original ("Jake's Resume"
 * style): Latin Modern, coral headline and section titles, centred header,
 * role rows with right-aligned location and dates, italic group labels and
 * hanging bullets. Every value comes from the document; all text is escaped
 * and nothing is fetched, so the HTML prints the same anywhere.
 */

function resumeCss(document: ResumeDocument, fonts: FontSet): string {
  const { theme } = document;
  return [
    baseCss(theme, fonts),
    `h2 { font-weight: 400; font-size: 13.4pt; line-height: 1.22; color: ${theme.accent}; margin: 18px 0 9px; padding-bottom: 2px; border-bottom: 0.6pt solid #8a8a8a; }`,
    `.group { font-style: italic; margin: 9px 0 2px; }`,
    `ul { margin: 0; padding-left: 12.5pt; list-style: none; }`,
    `li { margin: 0; text-align: ${theme.align}; text-wrap: pretty; }`,
    // A hanging bullet without positioning: positioned boxes paint last and
    // would move every bullet glyph to the end of the PDF text layer.
    `li::before { content: "\\2022\\0020"; white-space: pre; display: inline-block; width: 9.5pt; margin-left: -9.5pt; }`,
    `.after-title { margin-top: 7px; }`,
    `.block { margin-top: 14px; }`,
    `.role { margin-top: 9px; }`,
    `.sub { font-weight: 700; font-size: 10.5pt; margin-top: 13px; }`,
    `ul.intern { margin-top: 6px; }`,
    `ul.intern li { text-align: left; display: flex; align-items: baseline; }`,
    `ul.intern li::before { flex: none; }`,
    `ul.intern li > .row { flex: 1; }`,
    `.skills { margin-top: 2px; text-align: ${theme.align}; text-wrap: pretty; }`,
    `.skills .dot { margin: 0 2px; }`,
    `.skills .label { font-style: italic; }`,
  ].join("\n  ");
}

function bulletList(bullets: readonly ResumeBullet[], cls = ""): string {
  return `<ul class="${cls}">${bullets.map((bullet) => `<li>${markup(bullet.text)}</li>`).join("")}</ul>`;
}

function groupHtml(group: BulletGroup): string {
  return group.label
    ? `<div class="group">${escapeText(group.label)}</div>${bulletList(group.bullets)}`
    : bulletList(group.bullets, "after-title");
}

function roleHtml(role: ResumeRole): string {
  return `${row(escapeText(role.title), escapeText(role.dates), "title")}${role.groups.map(groupHtml).join("")}`;
}

function entryHtml(entry: ExperienceEntry): string {
  const [first, ...rest] = entry.roles;
  return [
    row(escapeText(entry.organization), escapeText(entry.location), "org"),
    first ? roleHtml(first) : "",
    ...rest.map((role) => `<div class="role">${roleHtml(role)}</div>`),
  ].join("");
}

/** The first entry sits directly under the section title; later ones get a gap. */
function experienceHtml(entries: readonly ExperienceEntry[]): string {
  return entries.map((entry, index) => (index === 0 ? entryHtml(entry) : `<div class="block">${entryHtml(entry)}</div>`)).join("\n  ");
}

function additionalHtml(entries: readonly AdditionalEntry[], title: string): string {
  if (entries.length === 0) return "";
  const items = entries.map((entry) => {
    const where = entry.location ? `, ${escapeText(entry.location)}` : "";
    const left = `<b>${escapeText(entry.organization)}</b>${where} \u2014 ${escapeText(entry.title)}`;
    return `<li>${row(left, escapeText(entry.dates))}</li>`;
  });
  return `<div class="sub">${escapeText(title)}</div>\n  <ul class="intern">\n    ${items.join("\n    ")}\n  </ul>`;
}

function educationHtml(entries: readonly ResumeEducation[]): string {
  return entries
    .map((entry, index) => {
      const inner = `${row(escapeText(entry.institution), escapeText(entry.location), "org")}${row(escapeText(entry.credential), escapeText(entry.dates))}`;
      return index === 0 ? inner : `<div class="block">${inner}</div>`;
    })
    .join("\n  ");
}

function skillsHtml(categories: readonly SkillCategory[]): string {
  return categories
    .map((category) => {
      const label = category.label ? `<span class="label">${escapeText(category.label)}:</span> ` : "";
      return `${label}${category.terms.map((term) => `<span class="nw">${escapeText(term)}</span>`).join(", ")}`;
    })
    .join(' <span class="dot">\u2022</span> ');
}

export function renderResumeHtml(document: ResumeDocument, fonts: FontSet): string {
  const titles = document.sectionTitles;
  const sections = [
    headerHtml(document.header),
    `<h2>${escapeText(titles.experience)}</h2>`,
    experienceHtml(document.experience),
    additionalHtml(document.additional, titles.additional),
  ];
  if (document.education.length > 0) {
    sections.push(`<h2>${escapeText(titles.education)}</h2>`, educationHtml(document.education));
  }
  if (document.skills.length > 0) {
    sections.push(`<h2>${escapeText(titles.skills)}</h2>`, `<div class="skills">${skillsHtml(document.skills)}</div>`);
  }
  return documentHtml(
    `${document.header.name} - Resume`,
    resumeCss(document, fonts),
    sections.filter((section) => section.length > 0).join("\n  "),
  );
}
