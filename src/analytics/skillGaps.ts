import type { Db } from "../db/database.js";
import type { Profile } from "../domain/profile.js";
import { skillBearingText } from "../text/jobDescription.js";
import { findKnownTerms } from "../text/techTerms.js";
import { SKILL_TERMS, type TechCategory } from "../text/techVocabulary.js";
import { DAY_MS, rate, type Rate } from "./stats.js";

/**
 * Skills the campaign's own target postings keep asking for that the profile
 * does not show. Counted once per posting, over the accepted postings, newest
 * first, so a skill that is both common and rising stands out; benefits, pay,
 * legal and company copy never count. A term is "covered" when any spelling
 * of it appears in the profile's skills, aliases, facts or experience; the
 * report never suggests claiming it.
 */

type GapTrend = "rising" | "falling" | "steady" | "insufficient-data";

type SkillGap = {
  term: string;
  category: TechCategory;
  postings: Rate;
  recent: Rate;
  prior: Rate;
  trend: GapTrend;
};

export type SkillGapReport = {
  postingsAnalyzed: number;
  window: { from: string; to: string } | null;
  recentWindowDays: number;
  gaps: SkillGap[];
  /** The most requested terms the profile already covers. */
  strengths: Array<{ term: string; postings: Rate }>;
};

type SkillGapOptions = {
  since: string | null;
  now: Date;
  /** Newest accepted postings read; bounds the work on large campaigns. */
  maxPostings?: number;
  top?: number;
  recentWindowDays?: number;
};

/** Each window needs this many postings before its share is compared. */
const TREND_MIN_WINDOW_N = 20;
const TREND_DELTA = 0.05;

type Row = Record<string, unknown>;

/** The names of the skills a text mentions. */
function skillsIn(text: string): Set<string> {
  return new Set(findKnownTerms(text).map((entry) => entry.term.term));
}

function profileSkills(profile: Profile): Set<string> {
  return skillsIn(
    [
      ...profile.skills.flatMap((skill) => [skill.name, ...skill.aliases, ...skill.tags]),
      ...profile.facts.flatMap((fact) => [fact.statement, ...fact.tags]),
      ...profile.experience.flatMap((role) => [role.title, ...role.highlights]),
    ].join("\n"),
  );
}

function trendOf(recent: Rate, prior: Rate): GapTrend {
  if (recent.n < TREND_MIN_WINDOW_N || prior.n < TREND_MIN_WINDOW_N || recent.rate === null || prior.rate === null) {
    return "insufficient-data";
  }
  const delta = recent.rate - prior.rate;
  if (delta >= TREND_DELTA) return "rising";
  if (delta <= -TREND_DELTA) return "falling";
  return "steady";
}

export function skillGaps(db: Db, profile: Profile, options: SkillGapOptions): SkillGapReport {
  const maxPostings = options.maxPostings ?? 500;
  const recentWindowDays = options.recentWindowDays ?? 30;
  const rows = db
    .prepare(
      `SELECT j.title, j.description_text, j.first_seen_at FROM evaluations e JOIN jobs j ON j.id = e.job_id
       WHERE e.decision = 'accept' AND (? IS NULL OR e.evaluated_at >= ?)
       ORDER BY j.first_seen_at DESC LIMIT ?`,
    )
    .all(options.since, options.since, maxPostings) as Row[];
  const cutoff = new Date(options.now.getTime() - recentWindowDays * DAY_MS).toISOString();
  const postings = rows.map((row) => ({
    skills: skillsIn(`${String(row.title ?? "")}\n${skillBearingText(String(row.description_text ?? ""))}`),
    recent: String(row.first_seen_at ?? "") >= cutoff,
    seenAt: String(row.first_seen_at ?? ""),
  }));
  const recentCount = postings.filter((posting) => posting.recent).length;
  const priorCount = postings.length - recentCount;
  const known = profileSkills(profile);

  const counted = SKILL_TERMS.map((definition) => {
    const hits = postings.filter((posting) => posting.skills.has(definition.term));
    const recentHits = hits.filter((posting) => posting.recent).length;
    return {
      definition,
      covered: known.has(definition.term),
      postings: rate(hits.length, postings.length),
      recent: rate(recentHits, recentCount),
      prior: rate(hits.length - recentHits, priorCount),
    };
  }).filter((entry) => entry.postings.count > 0);

  const top = options.top ?? 15;
  const byFrequency = (a: { postings: Rate }, b: { postings: Rate }) => b.postings.count - a.postings.count;
  const seen = postings.map((posting) => posting.seenAt).filter((value) => value.length > 0).sort();
  return {
    postingsAnalyzed: postings.length,
    window: seen.length > 0 ? { from: seen[0]!, to: seen[seen.length - 1]! } : null,
    recentWindowDays,
    gaps: counted
      .filter((entry) => !entry.covered)
      .sort(byFrequency)
      .slice(0, top)
      .map((entry) => ({
        term: entry.definition.term,
        category: entry.definition.category,
        postings: entry.postings,
        recent: entry.recent,
        prior: entry.prior,
        trend: trendOf(entry.recent, entry.prior),
      })),
    strengths: counted
      .filter((entry) => entry.covered)
      .sort(byFrequency)
      .slice(0, 10)
      .map((entry) => ({ term: entry.definition.term, postings: entry.postings })),
  };
}
