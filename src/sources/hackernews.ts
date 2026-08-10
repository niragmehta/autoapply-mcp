import type { AtsKind } from "../domain/campaign.js";
import { AppError } from "../util/errors.js";
import { fetchJson } from "./http.js";

/**
 * Hacker News "Ask HN: Who is hiring?" as a lead source.
 *
 * This is deliberately not a job source. The thread is freeform prose written
 * by whoever posted it, so compensation, location and seniority cannot be read
 * from it with anything like the confidence the campaign gates need. What it
 * does carry reliably is a link to the employer's own board, and that is the
 * valuable part: a board slug feeds the existing ATS adapters, which then
 * return properly structured postings for every role at that company, not just
 * the one that happened to be advertised.
 *
 * So this module answers "which companies should I be watching?" and leaves
 * "which roles do I want?" to the pipeline that already does it well.
 */

const ALGOLIA = "https://hn.algolia.com/api/v1";

/** Posted by the same account every month, which is what makes it findable. */
const HIRING_AUTHOR = "whoishiring";
const HIRING_TITLE = /ask hn:?\s*who\s*is\s*hiring/i;

type AlgoliaHit = { objectID: string; title?: string | null; created_at?: string | null };
type AlgoliaSearch = { hits?: AlgoliaHit[] };
type AlgoliaItem = {
  id?: number;
  title?: string | null;
  created_at?: string | null;
  children?: AlgoliaComment[];
};
type AlgoliaComment = { text?: string | null; author?: string | null; children?: AlgoliaComment[] };

export type HiringThread = { id: string; title: string; postedAt: string };

/**
 * Finds the most recent monthly thread.
 *
 * Searched by author and title rather than hardcoded, because a new thread
 * appears on the first of every month and a pinned id would silently go stale.
 */
export async function findLatestHiringThread(): Promise<HiringThread> {
  const url = `${ALGOLIA}/search_by_date?tags=story,author_${HIRING_AUTHOR}&hitsPerPage=20`;
  const search = await fetchJson<AlgoliaSearch>(url);
  const hit = (search.hits ?? []).find((candidate) => HIRING_TITLE.test(candidate.title ?? ""));
  if (!hit) {
    throw new AppError("hn_thread_not_found", "no recent 'Ask HN: Who is hiring?' thread found");
  }
  return { id: hit.objectID, title: hit.title ?? "", postedAt: hit.created_at ?? "" };
}

/**
 * HN stores comment bodies as HTML with the slashes inside hrefs escaped, so a
 * URL pattern finds nothing until the entities are turned back into characters.
 */
function decodeEntities(html: string): string {
  return html
    .replace(/&#x2F;/gi, "/")
    .replace(/&#x27;/gi, "'")
    .replace(/&quot;/g, '"')
    .replace(/&gt;/g, ">")
    .replace(/&lt;/g, "<")
    .replace(/&#x3D;/gi, "=")
    .replace(/&amp;/g, "&");
}

function toPlainText(html: string): string {
  return decodeEntities(html)
    .replace(/<p>/gi, " \n")
    .replace(/<[^>]+>/g, " ")
    .replace(/[ \t]+/g, " ")
    .trim();
}

/**
 * Board slug patterns, ordered so the more specific embed form is tried before
 * the plain board path it would otherwise be mis-read as.
 */
const BOARD_PATTERNS: Array<{ pattern: RegExp; ats: AtsKind }> = [
  { pattern: /job_board\?for=([a-z0-9_-]+)/gi, ats: "greenhouse" },
  { pattern: /job_app\?for=([a-z0-9_-]+)/gi, ats: "greenhouse" },
  { pattern: /(?:job-)?boards\.greenhouse\.io\/([a-z0-9_-]+)/gi, ats: "greenhouse" },
  { pattern: /jobs\.lever\.co\/([a-z0-9_.-]+)/gi, ats: "lever" },
  { pattern: /jobs\.ashbyhq\.com\/([a-z0-9_.-]+)/gi, ats: "ashby" },
];

/** Path segments that are part of the URL shape rather than a board name. */
const NOT_A_SLUG = new Set(["www", "jobs", "embed", "job", "job_app", "job_board", "api", "boards"]);

export type HnLead = {
  ats: AtsKind;
  board: string;
  /** Company name as written by the poster, used only as a label. */
  companyName: string;
  /** The posting's first line, kept so a human can sanity-check the match. */
  headline: string;
};

/**
 * Posts follow a loose "Company | Role | Location | Type" convention, so the
 * text before the first separator is usually the name. Usually is not always:
 * plenty of posts lead with a location, or with a sentence, and that text
 * would become a permanent label in the config.
 *
 * The board slug is the more dependable identifier, since it comes from the
 * employer's own URL rather than a poster's formatting. So the headline is
 * only trusted when it looks like a name, and the slug is the fallback.
 */
function companyNameFrom(headline: string, board: string): string {
  const firstLine = headline.split("\n")[0] ?? "";
  const beforeSeparator = firstLine.split(/[|(]/)[0] ?? "";
  const cleaned = beforeSeparator
    .replace(/https?:\/\/\S+/g, "")
    .replace(/[^\w&.\- ]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const looksLikeName =
    cleaned.length >= 2 && cleaned.length <= 30 && cleaned.split(" ").length <= 4 && corroborates(cleaned, board);
  return looksLikeName ? cleaned : prettifySlug(board);
}

/**
 * A headline field is only a company name if the employer's own board slug
 * agrees with it. That distinguishes "Baton" on boards/baton from a leading
 * location like "NYC" on jobs/norm-ai, which no length or word-count rule can
 * tell apart.
 */
function corroborates(name: string, board: string): boolean {
  const normalise = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, "");
  const normalisedName = normalise(name);
  const normalisedBoard = normalise(board);
  if (normalisedName.length === 0 || normalisedBoard.length === 0) return false;
  return normalisedBoard.includes(normalisedName) || normalisedName.includes(normalisedBoard);
}

/** Turns a board slug into a presentable name: "turquoise-health" -> "Turquoise Health". */
function prettifySlug(board: string): string {
  return board
    .replace(/[._-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/** Flattens the comment tree; replies advertise roles as often as top-level posts do. */
function flatten(comments: readonly AlgoliaComment[] | undefined): AlgoliaComment[] {
  const out: AlgoliaComment[] = [];
  for (const comment of comments ?? []) {
    out.push(comment);
    out.push(...flatten(comment.children));
  }
  return out;
}

/**
 * Pulls every distinct ATS board advertised in a thread.
 *
 * Deduplicated on ats+slug, because one company often links its board several
 * times in a single post, once per open role.
 */
export function extractLeads(item: AlgoliaItem): HnLead[] {
  const leads = new Map<string, HnLead>();

  for (const comment of flatten(item.children)) {
    if (!comment.text) continue;
    const decoded = decodeEntities(comment.text);
    const headline = toPlainText(comment.text).slice(0, 200);

    for (const { pattern, ats } of BOARD_PATTERNS) {
      // A global regex carries lastIndex between uses, so it is rebuilt per
      // comment rather than shared.
      for (const match of decoded.matchAll(new RegExp(pattern.source, pattern.flags))) {
        const board = match[1]?.toLowerCase().replace(/[.]+$/, "") ?? "";
        if (!board || NOT_A_SLUG.has(board)) continue;
        const key = `${ats}:${board}`;
        if (leads.has(key)) continue;
        leads.set(key, { ats, board, companyName: companyNameFrom(headline, board), headline });
      }
    }
  }

  return [...leads.values()];
}

export async function fetchThread(threadId: string): Promise<AlgoliaItem> {
  return await fetchJson<AlgoliaItem>(`${ALGOLIA}/items/${threadId}`);
}

/** Scans a thread, defaulting to the latest, and returns the boards it advertises. */
export async function scanHiringThread(threadId?: string): Promise<{ thread: HiringThread; leads: HnLead[] }> {
  const thread = threadId
    ? { id: threadId, title: "", postedAt: "" }
    : await findLatestHiringThread();
  const item = await fetchThread(thread.id);
  return {
    thread: { ...thread, title: thread.title || (item.title ?? ""), postedAt: thread.postedAt || (item.created_at ?? "") },
    leads: extractLeads(item),
  };
}
