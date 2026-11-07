import type { FontSet } from "../fonts.js";
import type { ResumeHeader, ResumeTheme } from "../resumeSource.js";
import { baseCss, documentHtml, escapeText, headerHtml, keepWhole, row } from "./shared.js";

/**
 * The cover letter template, in the resume's design: the same centred header,
 * then the recipient set like a resume role row (company and date, role and
 * location), the letter body and a sign-off.
 */

type CoverLetterDocument = {
  header: ResumeHeader;
  theme: ResumeTheme;
  /** Already formatted for print, e.g. "November 6, 2026". */
  date: string;
  recipient: { company: string; role: string; location?: string };
  salutation: string | null;
  paragraphs: string[];
  closing: string;
  signature: string;
};

type LetterParts = {
  salutation: string | null;
  paragraphs: string[];
  closing: string | null;
  signature: string | null;
};

const SALUTATION = /^(?:dear|hello|hi|greetings|to whom it may concern)\b.{0,80}$/i;
const CLOSING =
  /^(?:sincerely|yours sincerely|yours truly|best regards|kind regards|warm regards|warmest regards|regards|best|best wishes|respectfully|with appreciation|with gratitude|thank you|thanks|cheers)[,.!]?$/i;

/**
 * Splits letter text into salutation, body paragraphs and sign-off, so a
 * letter written with its own "Dear ..." and "Sincerely," is not printed with
 * a second set. Paragraphs are separated by blank lines.
 */
export function splitLetter(text: string): LetterParts {
  const notEmpty = (lines: string[]) => lines.length > 0;
  const blocks = text
    .replace(/\r\n?/g, "\n")
    .split(/\n\s*\n/)
    .map((block) => block.split("\n").map((line) => line.trim()).filter((line) => line.length > 0))
    .filter(notEmpty);

  const [head, ...afterHead] = blocks;
  const salutation = head && SALUTATION.test(head[0] ?? "") ? (head[0] ?? null) : null;
  const body = head && salutation !== null ? [head.slice(1), ...afterHead].filter(notEmpty) : blocks;

  const last = body.at(-1) ?? [];
  const at = last.findIndex((line) => CLOSING.test(line));
  // Only a sign-off in the last few lines counts; "Thanks," opening a long paragraph is prose.
  const signsOff = at >= 0 && last.length - at <= 3;
  const paragraphs = signsOff ? [...body.slice(0, -1), last.slice(0, at)].filter(notEmpty) : body;

  return {
    salutation,
    paragraphs: paragraphs.map((lines) => lines.join(" ")),
    closing: signsOff ? (last[at] ?? null) : null,
    signature: signsOff ? last.slice(at + 1).join(", ") || null : null,
  };
}

/** The letter's date line, e.g. "November 6, 2026". */
export function formatLetterDate(date: Date): string {
  return new Intl.DateTimeFormat("en-US", { year: "numeric", month: "long", day: "numeric" }).format(date);
}

function letterCss(theme: ResumeTheme, fonts: FontSet): string {
  return [
    baseCss(theme, fonts),
    `.recipient { margin-top: 18px; }`,
    `.letter { margin-top: 16px; font-size: 10.5pt; line-height: 1.3; }`,
    `.letter p { margin: 0 0 9px; text-align: ${theme.align}; text-wrap: pretty; }`,
    `.letter p.salutation { margin-bottom: 11px; }`,
    `.signoff { margin-top: 14px; }`,
    `.signature { margin-top: 3px; font-weight: 700; }`,
  ].join("\n  ");
}

export function renderCoverLetterHtml(letter: CoverLetterDocument, fonts: FontSet): string {
  const { recipient } = letter;
  const recipientHtml = [
    `<div class="recipient">`,
    row(escapeText(recipient.company), escapeText(letter.date), "org"),
    row(escapeText(recipient.role), escapeText(recipient.location ?? ""), "title"),
    `</div>`,
  ].join("");
  const body = [
    letter.salutation ? `<p class="salutation">${escapeText(letter.salutation)}</p>` : "",
    ...letter.paragraphs.map((paragraph) => `<p>${keepWhole(escapeText(paragraph))}</p>`),
    `<div class="signoff">${escapeText(letter.closing)}<div class="signature">${escapeText(letter.signature)}</div></div>`,
  ].join("\n  ");
  return documentHtml(
    `${letter.header.name} - Cover Letter`,
    letterCss(letter.theme, fonts),
    [headerHtml(letter.header), recipientHtml, `<div class="letter">\n  ${body}\n  </div>`].join("\n  "),
  );
}
