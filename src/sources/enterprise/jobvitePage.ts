import { decodeEntitiesOnce } from "../../text/html.js";
import { attribute, elementInner, inlineText, innerHtmlOf } from "./markup.js";

/**
 * Parsers for Jobvite's public pages: the hosted board on jobs.jobvite.com
 * and the company XML feed on app.jobvite.com. The feed is scanned with
 * indexOf rather than regexes because it runs to megabytes and a lazy pattern
 * over an unterminated tag would backtrack across the whole document.
 */

export type JobviteFeedJob = {
  id: string;
  title: string;
  locations: string[];
  date: string;
  category: string;
  jobType: string;
  descriptionHtml: string;
  salary: { currency: string; frequency: string; min: string; max: string };
};

export type JobviteListRow = { id: string; title: string; location: string };

export const JOBVITE_JOB_ID = /^[A-Za-z0-9]{4,20}$/;

/** The text of `<name>…</name>` inside one block, CDATA unwrapped and XML entities decoded. */
function tagText(block: string, name: string): string {
  const open = `<${name}>`;
  const start = block.indexOf(open);
  if (start === -1) return "";
  const end = block.indexOf(`</${name}>`, start + open.length);
  if (end === -1) return "";
  const value = block.slice(start + open.length, end).trim();
  return value.startsWith("<![CDATA[") && value.endsWith("]]>")
    ? value.slice(9, -3).trim()
    : decodeEntitiesOnce(value);
}

/**
 * Jobs in a `CompanyJobs/Xml.aspx` feed. One posting open in several places
 * arrives as several `<job>` rows with the same id; they are merged, keeping
 * the first row's fields and every location.
 */
export function parseJobviteFeed(xml: string): JobviteFeedJob[] {
  const byId = new Map<string, JobviteFeedJob>();
  let cursor = 0;
  for (;;) {
    const start = xml.indexOf("<job>", cursor);
    if (start === -1) break;
    const end = xml.indexOf("</job>", start + 5);
    if (end === -1) break;
    cursor = end + 6;
    const block = xml.slice(start + 5, end);
    const id = tagText(block, "id");
    const title = inlineText(tagText(block, "title"));
    if (!JOBVITE_JOB_ID.test(id) || !title) continue;
    const location = inlineText(tagText(block, "location"));
    const known = byId.get(id);
    if (known) {
      if (location && !known.locations.includes(location)) byId.set(id, { ...known, locations: [...known.locations, location] });
      continue;
    }
    byId.set(id, {
      id,
      title,
      locations: location ? [location] : [],
      date: tagText(block, "date"),
      category: inlineText(tagText(block, "category")),
      jobType: inlineText(tagText(block, "jobtype")),
      descriptionHtml: tagText(block, "description"),
      salary: {
        currency: tagText(block, "salarycurrency"),
        frequency: tagText(block, "salaryfrequency"),
        min: tagText(block, "salarymin"),
        max: tagText(block, "salarymax"),
      },
    });
  }
  return [...byId.values()];
}

/** The opaque company id the XML feed is keyed on, embedded in the board page's script. */
export function jobviteCompanyId(html: string): string | null {
  return /companyEId\s*[:=]\s*['"]([A-Za-z0-9_-]{4,40})['"]/.exec(html)?.[1] ?? null;
}

/** Postings on the hosted board's job list (`/<slug>/jobs`), one row each. */
export function parseJobviteList(html: string, slug: string): JobviteListRow[] {
  const rows: JobviteListRow[] = [];
  const seen = new Set<string>();
  for (const match of html.matchAll(/<td\b[^>]*class\s*=\s*["'][^"']*\bjv-job-list-name\b[^"']*["'][^>]*>/gi)) {
    const cellStart = match.index ?? 0;
    const nameCell = elementInner(html, cellStart) ?? "";
    const anchor = /<a\b[^>]*>([\s\S]*?)<\/a>/i.exec(nameCell);
    const href = anchor ? attribute(anchor[0], "href") ?? "" : "";
    const id = new RegExp(`^/(?:careers/)?${slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/job/([A-Za-z0-9]{4,20})/?$`, "i").exec(href)?.[1];
    const title = inlineText(anchor?.[1] ?? "");
    if (!id || !title || seen.has(id)) continue;
    seen.add(id);
    const rest = html.slice(cellStart, cellStart + nameCell.length + 2_000);
    const locationCell = /<td\b[^>]*class\s*=\s*["'][^"']*\bjv-job-list-location\b[^"']*["'][^>]*>([\s\S]*?)<\/td>/i.exec(rest)?.[1] ?? "";
    const location = /\bjv-meta\b/.test(locationCell) ? "" : inlineText(locationCell);
    rows.push({ id, title, location });
  }
  return rows;
}

export type JobviteDetail = { title: string; locations: string[]; descriptionHtml: string; notes: string[] };

/**
 * A posting page, or null when it carries no job description. The meta line
 * reads "Category | City, State" followed by `<br>`-separated notes such as
 * "Salary: CAD 110000.00 - 140000.00 Annually".
 */
export function parseJobviteDetail(html: string): JobviteDetail | null {
  const description = innerHtmlOf(html, /<div\b[^>]*class\s*=\s*["'][^"']*\bjv-job-detail-description\b[^"']*["'][^>]*>/i);
  if (description === null) return null;
  const title = inlineText(/<h2\b[^>]*class\s*=\s*["'][^"']*\bjv-header\b[^"']*["'][^>]*>([\s\S]*?)<\/h2>/i.exec(html)?.[1] ?? "");
  const meta = /<p\b[^>]*class\s*=\s*["'][^"']*\bjv-job-detail-meta\b[^"']*["'][^>]*>([\s\S]*?)<\/p>/i.exec(html)?.[1] ?? "";
  const [main = "", ...notes] = meta.split(/<br\s*\/?>/i);
  const place = inlineText(main.split(/<span\b[^>]*jv-inline-separator[^>]*><\/span>/i).pop() ?? "");
  return {
    title,
    locations: place && !/^\d+\s+locations?$/i.test(place) ? [place] : [],
    descriptionHtml: description,
    notes: notes.map(inlineText).filter((note) => note.length > 0),
  };
}

/** The board's "The job listing no longer exists." page, where Jobvite sends a removed posting. */
export function isJobviteMissing(html: string): boolean {
  return /\bjv-page-error\b/.test(html) && /no longer exists/i.test(html);
}
