import { decodeEntitiesOnce, htmlToText } from "../text/html.js";

/**
 * Reads LinkedIn job-alert emails.
 *
 * An alert lists postings as links to linkedin.com/jobs/view/<id>, usually
 * wrapped in tracking redirects (LinkedIn's own /comm/ paths, Outlook safe
 * links, Google redirects). The posting id is the only dependable part; the
 * title, company and location are read from the text around each link and are
 * best-effort labels. Nothing here visits LinkedIn.
 */

export type AlertJob = {
  jobId: string;
  /** Canonical https://www.linkedin.com/jobs/view/<id> */
  url: string;
  title: string;
  company: string;
  location: string;
};

export const ALERT_MAX_CHARS = 2_000_000;
const MAX_FIELD = 120;
const MAX_DEPTH = 3;

export function canonicalJobUrl(id: string): string {
  return `https://www.linkedin.com/jobs/view/${id}`;
}

function isLinkedInHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return host === "linkedin.com" || host.endsWith(".linkedin.com");
}

/** The posting id a URL points at, looking through tracking wrappers up to three levels deep. */
export function linkedInJobId(raw: string, depth = 0): string | null {
  if (depth > MAX_DEPTH) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (isLinkedInHost(url.hostname)) {
    const view = /\/(?:comm\/)?jobs\/view\/(?:[^/?#]*?-)?(\d{6,})(?:[/?#]|$)/i.exec(url.pathname);
    if (view?.[1]) return view[1];
    const current = url.searchParams.get("currentJobId");
    if (current && /^\d{6,}$/.test(current)) return current;
  }
  for (const value of url.searchParams.values()) {
    if (!/^https?:/i.test(value)) continue;
    const nested = linkedInJobId(value, depth + 1);
    if (nested) return nested;
  }
  return null;
}

const URL_PATTERN = /https?:\/\/[^\s"'<>]+/gi;
const BOILERPLATE = /^(?:view job|see job|see all jobs|see more jobs|apply now|easy apply|apply|view|actively recruiting|promoted|new|be an early applicant|\d+ (?:applicants?|connections?|alumni).*)$/i;
const MAIL_HEADER = /^(?:from|to|subject|date|reply-to|cc|bcc|sent):/i;
const SEPARATOR_LINE = /^[-=_*\u2014\u2013\u00b7.\s]{3,}$/;
/** Between company and place: a middle dot, a bullet, a pipe, or the asterisk htmlToText makes of &middot;. */
const FIELD_SEPARATOR = /\s+[\u00b7\u2022|*]\s+/;

function bounded(value: string): string {
  const clean = value.replace(/\s+/g, " ").trim();
  return clean.length > MAX_FIELD ? `${clean.slice(0, MAX_FIELD - 1).trimEnd()}\u2026` : clean;
}

function looksLikePlace(line: string): boolean {
  return /^(?:remote|hybrid|on-?site)\b/i.test(line) || /,\s*[A-Z]{2}\b/.test(line) || /\b(?:united states|canada|united kingdom|remote)\b/i.test(line) || /\((?:remote|hybrid|on-?site)\)\s*$/i.test(line);
}

/** "Acme Corp · San Francisco, CA (Hybrid)" -> company and location. */
function companyAndPlace(line: string): { company: string; location: string } {
  const parts = line.split(FIELD_SEPARATOR).map((part) => part.trim()).filter(Boolean);
  if (parts.length >= 2) return { company: bounded(parts[0]!), location: bounded(parts.slice(1).join(", ")) };
  return looksLikePlace(line) ? { company: "", location: bounded(line) } : { company: bounded(line), location: "" };
}

function titleFromSlug(raw: string, id: string): string {
  const match = new RegExp(`/jobs/view/([a-z0-9]+(?:-[a-z0-9]+)*)-${id}(?!\\d)`, "i").exec(raw);
  if (!match?.[1]) return "";
  return match[1]
    .split("-")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

function usable(line: string): boolean {
  return line.length > 0 && !BOILERPLATE.test(line) && !SEPARATOR_LINE.test(line) && !MAIL_HEADER.test(line);
}

type Found = { id: string; title: string; company: string; location: string };

function merge(into: Map<string, Found>, found: Found): void {
  const current = into.get(found.id);
  if (!current) {
    into.set(found.id, found);
    return;
  }
  into.set(found.id, {
    id: found.id,
    title: current.title || found.title,
    company: current.company || found.company,
    location: current.location || found.location,
  });
}

/**
 * Plain-text alerts put the title, company and place on the lines above each
 * link, sometimes with "Company · Place" on one line.
 */
export function parseTextAlert(text: string): Found[] {
  const body = text.replace(/=\r?\n/g, "").replace(/&amp;/g, "&");
  const lines = body.split(/\r?\n/).map((line) => line.trim());
  const found = new Map<string, Found>();
  lines.forEach((line, index) => {
    for (const [match] of line.matchAll(URL_PATTERN)) {
      const raw = match.replace(/[),.;!?\]]+$/, "");
      const id = linkedInJobId(raw);
      if (!id || found.has(id)) continue;
      const before = line.slice(0, line.indexOf(match)).replace(/[:\-\s]+$/, "").trim();
      const above: string[] = [];
      if (usable(before) && !/^https?:/i.test(before)) above.push(before);
      for (let cursor = index - 1; cursor >= 0 && above.length < 4; cursor -= 1) {
        const candidate = lines[cursor]!;
        if (candidate.length === 0) {
          if (above.length > 0) break;
          continue;
        }
        if (/https?:\/\//i.test(candidate) || MAIL_HEADER.test(candidate) || SEPARATOR_LINE.test(candidate)) break;
        if (BOILERPLATE.test(candidate)) continue;
        above.unshift(candidate);
      }
      merge(found, fieldsFrom(id, above, raw));
    }
  });
  return [...found.values()];
}

function fieldsFrom(id: string, lines: readonly string[], raw: string): Found {
  const result: Found = { id, title: "", company: "", location: "" };
  for (const line of lines) {
    if (!result.title && !looksLikePlace(line) && !FIELD_SEPARATOR.test(line)) {
      result.title = bounded(line);
      continue;
    }
    const split = companyAndPlace(line);
    if (!result.company && split.company) result.company = split.company;
    if (!result.location && split.location) result.location = split.location;
  }
  if (!result.title) result.title = titleFromSlug(raw, id);
  return result;
}

/** Lines after a posting's link: the company, then the place, sometimes as "Company · Place". */
function fieldsAfter(lines: readonly string[]): { company: string; location: string } {
  const result = { company: "", location: "" };
  for (const line of lines) {
    if (/\$\s?\d|\d+\s?k\b.*\/\s?(?:yr|year|hr|hour)/i.test(line)) continue;
    if (FIELD_SEPARATOR.test(line)) {
      const split = companyAndPlace(line);
      result.company ||= split.company;
      result.location ||= split.location;
    } else if (!result.location && looksLikePlace(line)) {
      result.location = bounded(line);
    } else if (!result.company) {
      result.company = bounded(line);
    }
    if (result.company && result.location) break;
  }
  return result;
}

const HREF = /\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i;

/** Blocks that never hold an alert's postings: comments, the head, styles and scripts. */
const HIDDEN_BLOCKS: ReadonlyArray<readonly [RegExp, string]> = [
  [/<!--/, "-->"],
  [/<head[\s>]/, "</head>"],
  [/<style[\s>]/, "</style>"],
  [/<script[\s>]/, "</script>"],
];

/**
 * Removes everything from each `open` match to the next `close` in one linear
 * pass; an unclosed block runs to the end. Lazy regexes over a message with
 * many unclosed tags take quadratic time, and a mailbox can be sent anything.
 */
function stripBetween(html: string, open: RegExp, close: string): string {
  const lower = html.toLowerCase();
  const pattern = new RegExp(open.source, "gi");
  let out = "";
  let cursor = 0;
  for (;;) {
    pattern.lastIndex = cursor;
    const match = pattern.exec(html);
    if (!match) return out + html.slice(cursor);
    out += `${html.slice(cursor, match.index)} `;
    const end = lower.indexOf(close, match.index + match[0].length);
    if (end < 0) return out;
    cursor = end + close.length;
  }
}

/** Replaces each <a ...>...</a> pair, matched in one pass; unclosed openings are left as text. */
function replaceAnchors(html: string, replace: (attributes: string, inner: string) => string): string {
  let out = "";
  let last = 0;
  let open: { start: number; attributes: string; innerStart: number } | null = null;
  for (const match of html.matchAll(/<a\b([^>]{0,4000})>|<\/a\s*>/gi)) {
    const index = match.index ?? 0;
    if (match[0][1] !== "/") {
      open = { start: index, attributes: match[1] ?? "", innerStart: index + match[0].length };
      continue;
    }
    if (!open) continue;
    out += html.slice(last, open.start) + replace(open.attributes, html.slice(open.innerStart, index));
    last = index + match[0].length;
    open = null;
  }
  return out + html.slice(last);
}

/**
 * HTML alerts put the title in the link text and the company and place in the
 * blocks that follow it, up to the next posting's link.
 */
export function parseHtmlAlert(html: string): Found[] {
  const anchors: Array<{ id: string | null; text: string; href: string }> = [];
  const cleaned = HIDDEN_BLOCKS.reduce((text, [open, close]) => stripBetween(text, open, close), html);
  const marked = replaceAnchors(cleaned.replace(/<\/(?:td|th)\s*>/gi, "$&\n"), (attributes, inner) => {
    const hrefMatch = HREF.exec(attributes);
    const href = decodeEntitiesOnce(hrefMatch?.[1] ?? hrefMatch?.[2] ?? hrefMatch?.[3] ?? "");
    anchors.push({ id: linkedInJobId(href), text: htmlToText(inner).replace(/\s+/g, " ").trim(), href });
    return `\n\u0000${anchors.length - 1}\u0000\n`;
  });
  const lines = htmlToText(marked)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  const found = new Map<string, Found>();
  // Held in an object so the loop's reassignments are visible to the type checker.
  const state: { current: Found | null; trailing: string[] } = { current: null, trailing: [] };
  const flush = () => {
    if (state.current) merge(found, { ...state.current, ...fieldsAfter(state.trailing.slice(0, 4)) });
  };
  for (const line of lines) {
    const marker = /^\u0000(\d+)\u0000$/.exec(line);
    if (marker) {
      const anchor = anchors[Number(marker[1])]!;
      if (!anchor.id) continue;
      const current = state.current;
      if (current && current.id === anchor.id) {
        if (!current.title && usable(anchor.text)) state.current = { ...current, title: bounded(anchor.text) };
        continue;
      }
      flush();
      state.current = { id: anchor.id, title: usable(anchor.text) ? bounded(anchor.text) : titleFromSlug(anchor.href, anchor.id), company: "", location: "" };
      state.trailing = [];
      continue;
    }
    if (state.current && usable(line)) state.trailing.push(line);
  }
  flush();
  return [...found.values()];
}

/** Every posting in an alert, first-seen order. HTML is preferred when both bodies are given. */
export function parseLinkedInAlert(input: { text?: string; html?: string }): AlertJob[] {
  const merged = new Map<string, Found>();
  const html = (input.html ?? "").slice(0, ALERT_MAX_CHARS);
  const text = (input.text ?? "").slice(0, ALERT_MAX_CHARS);
  if (html) for (const job of parseHtmlAlert(html)) merge(merged, job);
  if (text) {
    // A pasted alert is often HTML in the text field.
    const parsed = /<a\b[^>]*href/i.test(text) ? parseHtmlAlert(text) : parseTextAlert(text);
    for (const job of parsed) merge(merged, job);
  }
  return [...merged.values()].map((job) => ({
    jobId: job.id,
    url: canonicalJobUrl(job.id),
    title: job.title || "LinkedIn job",
    company: job.company,
    location: job.location,
  }));
}
