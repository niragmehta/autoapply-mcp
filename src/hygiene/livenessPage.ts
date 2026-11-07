import type { PostingCheck } from "../sources/types.js";
import { htmlToText } from "../text/html.js";
import { extractJobPostings } from "./jsonLd.js";

/**
 * Classifies a fetched posting page as open, closed or unknown.
 *
 * Pure, so every rule is testable without the network. The asymmetry is
 * deliberate: a false "closed" stops an application the candidate should have
 * sent, while a false "unknown" only costs a look. So closure needs positive
 * evidence (a gone status, a redirect to the board's index, or the page saying
 * so), "open" needs the page to show this posting, and everything else —
 * blocked requests, bot walls, client-rendered shells — is unknown.
 *
 * Phrase rules follow career-ops' liveness classifier (MIT).
 */

export type PageEvidence = {
  status: number;
  requestedUrl: string;
  finalUrl: string;
  /** Raw page body (HTML, or JSON from an API-like host). */
  body: string;
  /** The stored posting's title, to recognise the posting on the page. */
  title: string;
  /** The board's index page, when the posting's ATS has one. */
  boardUrl?: string | null;
};

/** Statements a page makes about this posting being gone. */
const CLOSED_PATTERNS: readonly RegExp[] = [
  /\bjob (?:is )?no longer available\b/i,
  /\bthis (?:job|position|role|posting|opening|vacancy)(?: posting| listing)? (?:is )?no longer (?:available|open|active|accepting)/i,
  /\bno longer accepting (?:new )?applications\b/i,
  /\b(?:not|no longer) accepting applications for this (?:job|position|role)\b/i,
  // "has been filled", but not "once the form has been filled out".
  /\b(?:job|position|role|posting|opening|vacancy|requisition)\b[^.\n]{0,60}?(?<!\b(?:application|form)\s)has been filled\b(?!\s+out)/i,
  /\b(?:this|the) (?:job|posting|position)(?: posting)? has expired\b/i,
  /\bjob posting has expired\b/i,
  // "closed-loop" and "closed-form" are prose, not closures.
  /\bthis (?:job|role|position)(?: listing| posting)? is (?:now )?closed\b(?!-)/i,
  /\bjob (?:listing |posting )?not found\b/i,
  /\bsorry,? this job (?:was|has been) removed\b/i,
  /\bthe (?:job|position) you are (?:looking for|trying to (?:view|apply (?:for|to))) (?:is no longer|has been|was)\b/i,
  /\bthe page you are looking for (?:doesn'?t|does not|no longer) exists?\b/i,
  /\bapplications? (?:(?:have|are|is) )?(?:now )?closed\b(?!-)/i,
  /\bwe(?:'re| are) no longer (?:hiring|recruiting|accepting applications) for this\b/i,
];

/**
 * A closure phrase inside a condition describes how the posting will end, not
 * that it has: "applications are accepted until the position has been filled".
 */
const CONDITION_CLAUSE =
  /\b(?:until|till|once|when|whenever|after|before|unless|if|whether|as soon as) (?:[^\s.,;:!?|]+ ){0,9}[^\s.,;:!?|]+$/i;

/** Anti-bot interstitials render a tiny challenge page instead of the posting. */
const BOT_WALL_PATTERNS: readonly RegExp[] = [
  /\bjust a moment\b/i,
  /\bchecking your browser\b/i,
  /\bverify (?:that )?you are (?:a |not a )?(?:human|robot)\b/i,
  /\benable javascript and cookies to continue\b/i,
  /\battention required\b[\s\S]{0,40}\bcloudflare\b/i,
  /\bplease complete the security check\b/i,
  /\bperforming security verification\b/i,
];

const LISTING_PATTERNS: readonly RegExp[] = [/\b\d+\s+(?:open\s+)?(?:jobs?|positions?|openings?|roles?)\s+(?:found|available)\b/i];

/** An apply control: a link or button whose text or target says apply. */
const APPLY_CONTROL =
  /<(?:a|button)\b[^>]*>(?:(?!<\/(?:a|button)>)[\s\S]){0,200}?\b(?:apply|submit (?:your )?application|start (?:your )?application)\b|<(?:a|button)\b[^>]*\b(?:href|data-[\w-]+|aria-label|id|class)\s*=\s*["'][^"']*\bapply\b/i;

/** Requisition ids and UUIDs: what a posting URL carries and a board index lacks. */
const POSTING_ID_TOKEN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|\d{4,}/gi;

function normalizeText(value: string): string {
  return value
    .replace(/[\u2018\u2019\u02bc\u2032`]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "");
}

function statedClosure(lines: string): string | null {
  const flat = lines.replace(/\n/g, " ");
  for (const pattern of CLOSED_PATTERNS) {
    for (const match of flat.matchAll(new RegExp(pattern.source, `${pattern.flags.replace("g", "")}g`))) {
      const end = (match.index ?? 0) + match[0].length;
      if (CONDITION_CLAUSE.test(lines.slice(0, end))) continue;
      return match[0];
    }
  }
  return null;
}

function words(value: string): string[] {
  return normalizeText(value)
    .toLowerCase()
    .split(/[^a-z0-9+#]+/)
    .filter((word) => word.length >= 2);
}

const TITLE_FILLER = new Set(["and", "or", "of", "the", "for", "in", "at", "to", "with", "remote", "hybrid", "onsite"]);

/** Whether every meaningful word of the title appears on the page. */
export function pageMentionsTitle(pageText: string, title: string): boolean {
  const wanted = words(title).filter((word) => !TITLE_FILLER.has(word));
  if (wanted.length === 0) return false;
  const present = new Set(words(pageText));
  return wanted.every((word) => present.has(word));
}

function stripUrl(raw: string): { host: string; path: string; query: string } | null {
  try {
    const url = new URL(raw);
    return { host: url.hostname.toLowerCase(), path: url.pathname.replace(/\/+$/, "").toLowerCase(), query: url.search };
  } catch {
    return null;
  }
}

function postingIdTokens(raw: string): string[] {
  return [...raw.matchAll(POSTING_ID_TOKEN)].map((match) => match[0].toLowerCase());
}

/**
 * A redirect lands on the board's index when the final URL is the board page,
 * or is a shorter path on the same host that dropped the posting's id.
 */
function redirectedToIndex(requested: string, final: string, boardUrl: string | null | undefined): boolean {
  const from = stripUrl(requested);
  const to = stripUrl(final);
  if (!from || !to) return false;
  if (/[?&]error=true\b/i.test(to.query)) return true;
  const board = boardUrl ? stripUrl(boardUrl) : null;
  if (board && board.host === to.host && board.path === to.path) return true;
  const ids = postingIdTokens(`${from.path}${from.query}`);
  const lostId = ids.length > 0 && !ids.some((id) => final.toLowerCase().includes(id));
  return lostId && from.host === to.host && to.path.length < from.path.length && from.path.startsWith(to.path);
}

export function classifyPostingPage(evidence: PageEvidence): PostingCheck {
  const page = (detail: string, status: PostingCheck["status"]): PostingCheck => ({ status, via: "page", detail });
  const { status } = evidence;

  if (status === 404 || status === 410) return page(`posting page answers HTTP ${status}`, "closed");
  if (status === 401 || status === 403 || status === 429 || status === 451) {
    return page(`posting page refused the request (HTTP ${status}); not evidence either way`, "unknown");
  }
  if (status >= 500) return page(`posting page had a server error (HTTP ${status})`, "unknown");
  if (status < 200 || status >= 300) return page(`posting page answered HTTP ${status}`, "unknown");

  const redirected = evidence.finalUrl.length > 0 && evidence.finalUrl !== evidence.requestedUrl;
  if (redirected && redirectedToIndex(evidence.requestedUrl, evidence.finalUrl, evidence.boardUrl)) {
    return page(`posting URL now redirects to the board index (${evidence.finalUrl})`, "closed");
  }

  const lines = normalizeText(htmlToText(evidence.body));
  if (BOT_WALL_PATTERNS.some((pattern) => pattern.test(lines))) {
    return page("an anti-bot check answered instead of the posting", "unknown");
  }

  const closure = statedClosure(lines);
  if (closure) return page(`posting page says "${closure.slice(0, 120)}"`, "closed");

  const mentionsTitle = pageMentionsTitle(lines, evidence.title);
  const postings = extractJobPostings(evidence.body);
  if (postings.some((posting) => pageMentionsTitle(posting.title, evidence.title))) {
    return page("posting page publishes this posting's schema.org JobPosting", "open");
  }

  // A permalink that now lands somewhere without its id is not the posting,
  // and Apply buttons there belong to other postings. Only a search page that
  // lacks this posting counts as closure; a portal migration redirects live
  // postings too.
  const ids = postingIdTokens(evidence.requestedUrl);
  const lostId = redirected && ids.length > 0 && ids.every((id) => !evidence.finalUrl.toLowerCase().includes(id));
  if (lostId) {
    if (!mentionsTitle && LISTING_PATTERNS.some((pattern) => pattern.test(lines))) {
      return page(`posting URL now redirects to a job search page without it (${evidence.finalUrl})`, "closed");
    }
    return page(`posting URL redirected away from the posting (${evidence.finalUrl})`, "unknown");
  }
  if (mentionsTitle && APPLY_CONTROL.test(evidence.body)) {
    return page("posting page shows the posting's title and an apply control", "open");
  }
  if (lines.trim().length < 300) {
    return page("posting page has too little content to judge (likely rendered in the browser)", "unknown");
  }
  return page("posting page does not clearly show the posting", "unknown");
}
