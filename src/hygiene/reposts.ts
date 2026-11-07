import type { Db } from "../db/database.js";
import { jsonOrDefault } from "../db/database.js";
import type { Job } from "../domain/job.js";

/**
 * Repost detection: the same role listed again under a new posting id.
 *
 * A role an employer keeps closing and re-listing is a weak ghost-job signal
 * (an evergreen pipeline, a req that never fills) and a strong hint that an
 * application may sit unread. Three rules keep sibling requisitions from being
 * mistaken for reposts (after career-ops' detect-reposts, MIT):
 *
 * 1. Same source. Only postings from the same ATS board are compared; the same
 *    opening seen on two boards is a duplicate, not a repost.
 * 2. Title identity, not similarity. Titles must reduce to the same set of
 *    words, so word order and punctuation churn are tolerated but a different
 *    city, team, specialty or level word keeps two titles apart.
 * 3. Different days. Postings first seen on the same day were listed side by
 *    side - parallel headcount - so a cluster needs at least two distinct
 *    first-seen dates.
 *
 * What the title identity removes: bracketed segments (locations, workplace
 * and requisition notes such as "(Remote - US)"), requisition ids
 * ("R12345", "JR2021915", "REQ-1234", "Job ID: 123"), workplace words
 * (remote, hybrid, onsite) and punctuation. Abbreviations are expanded
 * (Sr -> senior, Jr -> junior, Mgr -> manager).
 *
 * Level numerals are canonicalized but never removed: "Engineer II" and
 * "Engineer 2" are one identity, while "Engineer II" and "Engineer III" are
 * different grades - different requisitions - and stay apart. Dropping the
 * numeral would change the role's seniority, and merging grades would
 * fabricate a repost.
 */

export type RepostMember = {
  jobId: string;
  externalId: string;
  title: string;
  firstSeenAt: string;
  lastSeenAt: string;
  postedAt: string | null;
  url: string;
  locations: string[];
};

export type RepostCluster = {
  company: string;
  ats: string;
  board: string;
  titleIdentity: string;
  sampleTitle: string;
  /** Distinct posting ids in the window. */
  postings: number;
  /** Distinct UTC dates on which those postings were first seen. */
  distinctDates: number;
  /** When the earliest and the most recent of these postings were first seen. */
  earliestSeenAt: string;
  latestSeenAt: string;
  spanDays: number;
  /** Meets both thresholds: enough postings, seen on at least two dates. */
  reposted: boolean;
  members: RepostMember[];
};

export type RepostOptions = {
  windowDays: number;
  minPostings: number;
  now?: Date;
  /** Restrict to one employer (case-insensitive). */
  company?: string;
};

export type RepostSignal = RepostCluster;

const ABBREVIATIONS: Readonly<Record<string, string>> = {
  sr: "senior",
  snr: "senior",
  jr: "junior",
  mgr: "manager",
  engr: "engineer",
};

const ROMAN_LEVELS: Readonly<Record<string, string>> = { i: "1", ii: "2", iii: "3", iv: "4", v: "5", vi: "6" };

const REQUISITION_PATTERNS: readonly RegExp[] = [
  /\b(?:req(?:uisition)?|job)\s*(?:id|no\.?|number|#)?\s*[:#-]?\s*[a-z]*\d[\w-]*/gi,
  /#\s*\d[\w-]*/g,
  /\b[a-z]{0,4}\d{4,}[\w-]*\b/gi,
];

const WORKPLACE_WORDS = new Set(["remote", "hybrid", "onsite", "on-site", "in-office"]);

/** Order-insensitive identity of a job title; see the module notes for what it ignores. */
export function titleIdentity(title: string): string {
  let value = title.normalize("NFKD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  value = value.replace(/\([^)]*\)|\[[^\]]*\]|\{[^}]*\}/g, " ");
  for (const pattern of REQUISITION_PATTERNS) value = value.replace(pattern, " ");
  const words = value
    .replace(/on-site/g, "onsite")
    .replace(/[^a-z0-9+#]+/g, " ")
    .split(" ")
    .filter((word) => word.length > 0 && !WORKPLACE_WORDS.has(word))
    .map((word) => ABBREVIATIONS[word] ?? ROMAN_LEVELS[word] ?? word)
    .map((word) => (/^[1-6]$/.test(word) ? `level-${word}` : word));
  const unique = [...new Set(words)].sort();
  return unique.length > 0 ? unique.join(" ") : title.trim().toLowerCase();
}

type Row = Record<string, unknown>;

function rowToMember(row: Row): RepostMember & { ats: string; board: string; company: string } {
  return {
    jobId: String(row.id),
    externalId: String(row.external_id),
    title: String(row.title),
    firstSeenAt: String(row.first_seen_at),
    lastSeenAt: String(row.last_seen_at),
    postedAt: row.posted_at === null || row.posted_at === undefined ? null : String(row.posted_at),
    url: String(row.url),
    locations: jsonOrDefault<string[]>(row.locations_raw, []),
    ats: String(row.ats),
    board: String(row.board),
    company: String(row.company_name),
  };
}

function windowStart(options: RepostOptions): string {
  const now = options.now ?? new Date();
  return new Date(now.getTime() - options.windowDays * 86_400_000).toISOString();
}

function buildCluster(members: ReadonlyArray<ReturnType<typeof rowToMember>>, options: RepostOptions): RepostCluster | null {
  const first = members[0];
  if (!first) return null;
  const ordered = [...members].sort((a, b) => a.firstSeenAt.localeCompare(b.firstSeenAt));
  const postings = new Set(ordered.map((member) => member.externalId)).size;
  const distinctDates = new Set(ordered.map((member) => member.firstSeenAt.slice(0, 10))).size;
  const earliestSeenAt = ordered[0]!.firstSeenAt;
  const latestSeenAt = ordered[ordered.length - 1]!.firstSeenAt;
  const spanDays = Math.round((Date.parse(latestSeenAt) - Date.parse(earliestSeenAt)) / 86_400_000);
  return {
    company: first.company,
    ats: first.ats,
    board: first.board,
    titleIdentity: titleIdentity(first.title),
    sampleTitle: ordered[ordered.length - 1]!.title,
    postings,
    distinctDates,
    earliestSeenAt,
    latestSeenAt,
    spanDays: Number.isFinite(spanDays) ? spanDays : 0,
    reposted: postings >= options.minPostings && distinctDates >= 2,
    members: ordered.map(({ ats: _ats, board: _board, company: _company, ...member }) => member),
  };
}

function groupRows(rows: readonly Row[]): Map<string, Array<ReturnType<typeof rowToMember>>> {
  const groups = new Map<string, Array<ReturnType<typeof rowToMember>>>();
  for (const row of rows) {
    const member = rowToMember(row);
    const key = `${member.ats}|${member.board.toLowerCase()}|${titleIdentity(member.title)}`;
    groups.set(key, [...(groups.get(key) ?? []), member]);
  }
  return groups;
}

/** Every repost cluster among postings first seen inside the window, largest first. */
export function findRepostClusters(db: Db, options: RepostOptions): RepostCluster[] {
  const rows = db
    .prepare(`
      SELECT id, ats, board, company_name, external_id, title, first_seen_at, last_seen_at, posted_at, url, locations_raw
      FROM jobs WHERE first_seen_at >= ? AND ats != 'external'
    `)
    .all(windowStart(options)) as Row[];
  const wanted = options.company?.trim().toLowerCase();
  const scoped = wanted ? rows.filter((row) => String(row.company_name).toLowerCase() === wanted) : rows;
  return [...groupRows(scoped).values()]
    .map((members) => buildCluster(members, options))
    .filter((cluster): cluster is RepostCluster => cluster !== null && cluster.reposted)
    .sort((a, b) => b.postings - a.postings || b.distinctDates - a.distinctDates || a.company.localeCompare(b.company));
}

/** The repost cluster this posting belongs to, whether or not it meets the thresholds. */
export function repostSignalFor(db: Db, job: Pick<Job, "id" | "ats" | "board" | "title">, options: RepostOptions): RepostSignal | null {
  if (job.ats === "external") return null;
  const rows = db
    .prepare(`
      SELECT id, ats, board, company_name, external_id, title, first_seen_at, last_seen_at, posted_at, url, locations_raw
      FROM jobs WHERE ats = ? AND board = ? AND (first_seen_at >= ? OR id = ?)
    `)
    .all(job.ats, job.board, windowStart(options), job.id) as Row[];
  const identity = titleIdentity(job.title);
  const members = rows.map(rowToMember).filter((member) => titleIdentity(member.title) === identity);
  return buildCluster(members, options);
}
