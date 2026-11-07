import type { Campaign } from "../domain/campaign.js";
import type { Job } from "../domain/job.js";
import type { Profile } from "../domain/profile.js";
import { readJdLines, splitSentences, type SectionKind } from "../text/jobDescription.js";

/**
 * Years of experience: what a posting requires and what the candidate has.
 *
 * Titles say little about this - "Lead" roles ask for four years and plain
 * "Analyst" roles for ten - so the number is read from the description, by
 * rules only. The reading is conservative because a wrong rejection costs a
 * real job: the gating figure is the LOWEST required floor stated (the most
 * lenient honest reading), preferred figures never gate, and a bar the posting
 * offers a way around ("or an equivalent combination of education and
 * experience") is reported but never rejects. Every figure carries the
 * sentence it came from. Rules after career-ops' jd-years (MIT).
 */

export type YearsKind = "required" | "preferred" | "unclear";

export type YearsMention = {
  min: number;
  max: number | null;
  kind: YearsKind;
  /** overall: experience in general; skill: with one technology; sub: part of a larger bar ("including 2 leading"). */
  scope: "overall" | "skill" | "sub";
  sentence: string;
  /** What decided the kind: the cue word in the sentence, or the section heading. */
  cue: string;
};

export type RequiredYears = {
  /** Lowest required floor, or null when the posting states none. */
  minYears: number | null;
  maxYears: number | null;
  sentence: string | null;
  status: "stated" | "unclear" | "preferred-only" | "none";
  /** True when the floor is a hard bar: stated as required, with no equivalent route. */
  confident: boolean;
  mentions: YearsMention[];
};

const WORD_NUMBERS: Readonly<Record<string, number>> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, twenty: 20,
};
const NUM = `(?:\\d{1,2}(?:\\.\\d)?|${Object.keys(WORD_NUMBERS).join("|")})`;
const RESTATED = String.raw`(?:\s*\(\s*\d{1,2}\s*\+?\s*\))?`;
const PLUS = String.raw`(?:\s*\+|[\s-]*plus\b)?`;
const OR_MORE = String.raw`(?:\s+or\s+(?:more|greater|longer))?`;
const MENTION = new RegExp(
  String.raw`\b(between\s+)?(${NUM})${RESTATED}${PLUS}${OR_MORE}(?:\s*(?:-|\u2013|\u2014|to|and)\s*(${NUM})${RESTATED}${PLUS})?[\s-]*(?:years?|yrs?)\b`,
  "gi",
);

/** What may follow "years" for the figure to be about experience. */
const EXPERIENCE_TRAIL =
  /^(?:'s|')?\s*(?:\+\s*)?(?:of\b|in\b|as\b|at\b|on\b|across\b|within\b|working|leading|managing|building|developing|designing|delivering|running|operating|owning|supporting|(?:[\w/&+#.-]+\s+){1,3}(?:experience|exp)\b|experience|exp\b|professional|relevant|related|direct|hands|industry|work\b|progressive|combined|total|post|full[- ]time|practical|prior|previous|demonstrated|proven|minimum|or more|plus\b|[),;:.]|$|and\b|with\b|using\b|required|preferred)/i;
const NON_EXPERIENCE_OF = /^(?:'s|')?\s*of\s+(?:age|college|university|school|schooling|education|study|studies|service|history|data|operations?|growth|existence|tenure|employment with us)\b/i;
const WINDOW_LEAD = /\b(?:within|after|every|per|ago|the (?:first|next|last|past)|(?:first|next|last|past)|in the|for the|over the|up to the|aged?|age of)\s*$/i;
const CEILING_LEAD = /\b(?:up to|less than|fewer than|no more than|not more than|under|at most|maximum of|max(?:imum)?\.?)\s*$/i;
const CEILING_TRAIL = /^(?:'s|')?\s*(?:\+\s*)?(?:of\s+)?(?:[\w/&-]+\s+){0,4}?(?:experience\s+)?(?:or (?:less|fewer|under)|maximum|max\b|at most)/i;
const NOT_A_REQUIREMENT =
  /\b(?:year[- ]over[- ]year|years? old|years? of age|founded|anniversary|in business|vest(?:s|ed|ing)?\b|contract (?:term|length|duration)|warranty|retention bonus|sabbatical|parental leave|\d+[- ]year (?:degree|program|programme|course|plan|contract|term|appointment)|(?:four|two|three)[- ]year (?:degree|college|university|program))/i;
const THIRD_PARTY_LEAD =
  /\b(?:engineers|experts|colleagues|peers|leaders|mentors|teammates|team members|veterans|specialists|founders|people)\s+(?:with|who have|who bring|having)\s+(?:over\s+|more than\s+|a combined\s+)?$|\b(?:a\s+)?combined\s+(?:total of\s+)?$/i;
const THIRD_PARTY_SENTENCE = /\b(?:alongside|learn from|mentored by|surrounded by|led by|team (?:that )?averag)/i;
const SUB_LEAD = /\b(?:including|incl\.?|of which|of those|within that|out of which)\s*(?:at least\s+|a minimum of\s+)?$/i;
const SKILL_TRAIL =
  /^(?:'s|')?\s*(?:\+\s*)?(?:of\s+)?(?:(?:hands[- ]on|direct|professional|practical|relevant|production|commercial)\s+)?(?:experience\s+)?(?:with|using|programming|coding|writing|scripting)\b/i;
const PREFERRED_CUE =
  /\b(?:prefer(?:red|ably|ence)?|nice[- ]to[- ]have|bonus|a (?:big |huge |strong )?plus|is a plus|ideally|desired|desirable|advantageous|would be (?:great|nice|helpful|ideal)|not required)\b/gi;
const REQUIRED_CUE = /\b(?:require[ds]?|requirements?|minimum|must|at least|mandatory|essential|need(?:ed|s)?)\b/gi;
const EQUIVALENT_ROUTE =
  /\bequivalent combination\b|\bor (?:an? )?equivalent (?:amount|level|mix) of\b|\bcombination of (?:education|training) and (?:work )?experience\b/i;

function toNumber(raw: string): number {
  const key = raw.toLowerCase();
  return WORD_NUMBERS[key] ?? Number(raw);
}

/**
 * Required or preferred, from the cue word nearest the figure ("5+ years
 * required, 8+ preferred" holds one of each), else from the section heading.
 */
function kindFor(
  sentence: string,
  span: { start: number; end: number },
  section: SectionKind,
  heading: string | null,
): { kind: YearsKind; cue: string } {
  let nearest: { kind: YearsKind; cue: string; distance: number } | null = null;
  for (const [kind, pattern] of [["preferred", PREFERRED_CUE], ["required", REQUIRED_CUE]] as const) {
    for (const match of sentence.matchAll(pattern)) {
      const at = match.index ?? 0;
      const distance = at >= span.end ? at - span.end : at + match[0].length <= span.start ? span.start - (at + match[0].length) : 0;
      if (!nearest || distance < nearest.distance) nearest = { kind, cue: match[0], distance };
    }
  }
  if (nearest) return { kind: nearest.kind, cue: nearest.cue };
  if (section === "preferred") return { kind: "preferred", cue: heading ?? "preferred section" };
  if (section === "requirements") return { kind: "required", cue: heading ?? "requirements section" };
  return { kind: "unclear", cue: heading ? `under "${heading}"` : "no section heading" };
}

function mentionsIn(sentence: string, section: SectionKind, heading: string | null): YearsMention[] {
  if (NOT_A_REQUIREMENT.test(sentence) || THIRD_PARTY_SENTENCE.test(sentence)) return [];
  const found: YearsMention[] = [];
  for (const match of sentence.matchAll(MENTION)) {
    const start = match.index ?? 0;
    const before = sentence.slice(Math.max(0, start - 60), start);
    const after = sentence.slice(start + match[0].length);
    if (WINDOW_LEAD.test(before) || CEILING_LEAD.test(before) || THIRD_PARTY_LEAD.test(before)) continue;
    if (NON_EXPERIENCE_OF.test(after) || CEILING_TRAIL.test(after) || !EXPERIENCE_TRAIL.test(after)) continue;
    const low = toNumber(match[2] ?? "");
    const high = match[3] ? toNumber(match[3]) : null;
    if (!Number.isFinite(low) || low <= 0 || low > 30) continue;
    const scope = SUB_LEAD.test(before) ? "sub" : SKILL_TRAIL.test(after) ? "skill" : "overall";
    const { kind, cue } = kindFor(sentence, { start, end: start + match[0].length }, section, heading);
    found.push({
      min: low,
      max: high !== null && Number.isFinite(high) && high >= low ? high : null,
      kind,
      scope,
      sentence: sentence.slice(0, 300),
      cue,
    });
  }
  return found;
}

/** Reads the years-of-experience bar from a description. */
export function extractRequiredYears(text: string): RequiredYears {
  const mentions: YearsMention[] = [];
  let alternative = false;
  for (const line of readJdLines(text)) {
    if (line.heading || line.section === "legal" || line.section === "benefits" || line.section === "about") continue;
    for (const sentence of splitSentences(line.text)) {
      const found = mentionsIn(sentence, line.section, line.headingText);
      if (found.length > 0 && EQUIVALENT_ROUTE.test(sentence)) alternative = true;
      mentions.push(...found);
    }
  }

  const pick = (kind: YearsKind): YearsMention | null => {
    const candidates = mentions.filter((mention) => mention.kind === kind && mention.scope !== "sub");
    const overall = candidates.filter((mention) => mention.scope === "overall");
    const pool = overall.length > 0 ? overall : candidates;
    return pool.reduce<YearsMention | null>((lowest, mention) => (lowest === null || mention.min < lowest.min ? mention : lowest), null);
  };

  const required = pick("required");
  const unclear = required ? null : pick("unclear");
  const chosen = required ?? unclear;
  if (!chosen) {
    const preferredOnly = mentions.some((mention) => mention.kind === "preferred");
    return { minYears: null, maxYears: null, sentence: null, status: preferredOnly ? "preferred-only" : "none", confident: false, mentions };
  }
  return {
    minYears: chosen.min,
    maxYears: chosen.max,
    sentence: chosen.sentence,
    status: required ? "stated" : "unclear",
    confident: required !== null && !alternative,
    mentions,
  };
}

const INTERNSHIP = /\b(?:intern|internship|co-?op|apprentice(?:ship)?)\b/i;

function monthIndex(value: string, edge: "start" | "end"): number | null {
  const text = value.trim();
  const full = /^(\d{4})-(\d{1,2})(?:-\d{1,2})?$/.exec(text);
  if (full) {
    const month = Number(full[2]);
    if (month < 1 || month > 12) return null;
    return Number(full[1]) * 12 + month - 1;
  }
  const year = /^(\d{4})$/.exec(text);
  if (year) return Number(year[1]) * 12 + (edge === "start" ? 0 : 12);
  return null;
}

function isCurrent(end: string): boolean {
  return /^(?:|present|current|now|ongoing)$/i.test(end.trim());
}

export type CandidateYears = { years: number; source: "campaign" | "profile"; detail: string };

/**
 * Professional years from profile.experience: internships excluded, and
 * overlapping roles counted once, so two concurrent jobs do not double a year.
 */
export function candidateYearsFromProfile(profile: Profile, now = new Date()): CandidateYears {
  const nowIndex = now.getUTCFullYear() * 12 + now.getUTCMonth();
  const spans: Array<[number, number]> = [];
  let skipped = 0;
  for (const entry of profile.experience) {
    if (INTERNSHIP.test(entry.title)) {
      skipped += 1;
      continue;
    }
    const from = monthIndex(entry.start, "start");
    const to = isCurrent(entry.end) ? nowIndex : monthIndex(entry.end, "end");
    if (from === null || to === null || to <= from) continue;
    spans.push([from, Math.min(to, nowIndex)]);
  }
  spans.sort((a, b) => a[0] - b[0]);
  let months = 0;
  let cursor = Number.NEGATIVE_INFINITY;
  for (const [from, to] of spans) {
    const start = Math.max(from, cursor);
    if (to > start) months += to - start;
    cursor = Math.max(cursor, to);
  }
  const years = Math.round((months / 12) * 10) / 10;
  return {
    years,
    source: "profile",
    detail: `${years} years from ${spans.length} role(s) in profile.experience${skipped > 0 ? `, ${skipped} internship(s) excluded` : ""}`,
  };
}

export function candidateYears(profile: Profile, campaign: Campaign, now = new Date()): CandidateYears {
  const configured = campaign.hygiene.experience.candidateYears;
  if (configured !== undefined) {
    return { years: configured, source: "campaign", detail: `${configured} years from campaign.hygiene.experience.candidateYears` };
  }
  return candidateYearsFromProfile(profile, now);
}

export type ExperienceAssessment = {
  required: RequiredYears;
  candidate: CandidateYears;
  toleranceYears: number;
  /** Required floor minus the candidate's years; null when the posting states no floor. */
  gap: number | null;
  overTolerance: boolean;
  /** Over tolerance on a confident bar, with campaign.hygiene.experience.enforce on. */
  rejects: boolean;
};

export function assessExperience(
  job: Pick<Job, "descriptionText">,
  campaign: Campaign,
  profile: Profile,
  now = new Date(),
): ExperienceAssessment {
  const policy = campaign.hygiene.experience;
  const required = extractRequiredYears(job.descriptionText ?? "");
  const candidate = candidateYears(profile, campaign, now);
  const gap = required.minYears === null ? null : Math.round((required.minYears - candidate.years) * 10) / 10;
  const overTolerance = gap !== null && gap > policy.toleranceYears;
  return {
    required,
    candidate,
    toleranceYears: policy.toleranceYears,
    gap,
    overTolerance,
    rejects: policy.enforce && overTolerance && required.confident,
  };
}

/** Queue flags: the stated bar, and whether it is beyond the candidate's reach. */
export function experienceFlags(assessment: ExperienceAssessment): string[] {
  if (assessment.required.minYears === null) return [];
  const flags = [`years-required:${assessment.required.minYears}`];
  if (assessment.overTolerance) flags.push("years-over-tolerance");
  return flags;
}
