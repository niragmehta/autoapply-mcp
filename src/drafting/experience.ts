import type { Profile } from "../domain/profile.js";
import { normalizeLabel } from "../submission/formFields.js";

type Experience = Profile["experience"][number];

/**
 * Resolvers for the employment-history block boards render on the live page.
 *
 * Lever and Ashby publish no question schema, and Lyft's Greenhouse form asks
 * for company, title and start/end month and year as separate controls that no
 * single stored answer can serve. Nothing sourced them, so every required field
 * in the block stayed blank and the submission aborted with the form otherwise
 * complete.
 *
 * These are resume facts - the same employer, title and dates the attached PDF
 * states - so restating them on the form claims nothing new. The values come
 * from `profile.experience`, never from a guess.
 *
 * Only the most recent position is filled. Forms render one block and offer an
 * "Add another" button for the rest, so there is exactly one block to answer;
 * filling it with anything other than the current role would be wrong.
 */

export type ExperienceResolution = {
  answer: string;
  citation: string;
  category: string;
  authorized: boolean;
};

const MONTHS = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
] as const;

/** True when the position has no end date, however the profile spells it. */
function isCurrent(entry: Experience): boolean {
  const end = entry.end.trim().toLowerCase();
  return end.length === 0 || end === "present" || end === "current" || end === "now";
}

/** Splits a profile "YYYY-MM" into a month name and a year. */
function splitPeriod(period: string): { month: string; year: string } | null {
  const match = /^(\d{4})-(\d{1,2})$/.exec(period.trim());
  if (!match) return null;
  const year = match[1];
  const index = Number(match[2]) - 1;
  const month = MONTHS[index];
  if (!year || !month) return null;
  return { month, year };
}

/**
 * The position the block is asking about: the one that is current, or failing
 * that the one that started most recently.
 */
function mostRecent(profile: Profile): Experience | null {
  if (profile.experience.length === 0) return null;
  const ordered = [...profile.experience].sort((a, b) => b.start.localeCompare(a.start));
  return ordered.find((entry) => isCurrent(entry)) ?? ordered[0] ?? null;
}

type Resolver = {
  /** Matched against the normalized label, which is lowercased and de-punctuated. */
  test: (label: string) => boolean;
  category: string;
  citation: string;
  resolve: (entry: Experience, profile: Profile, label: string) => string;
};

/**
 * Bare "Company" and "Title" are only safe as exact matches. A substring rule
 * would let "Company name" answer "Why this company?" and let "Title" answer
 * "Job title you are applying for", which are questions about the employer
 * being applied to, not the one being left.
 */
function exact(...labels: readonly string[]): (label: string) => boolean {
  const allowed = new Set(labels);
  return (label: string) => allowed.has(label);
}

/**
 * A month or year *component* only appears in an employment-history block. A
 * desired-start-date question is a single date control, so requiring both the
 * date part and the component keeps a notice period out of these fields.
 */
function component(part: "start" | "end", unit: "month" | "year"): (label: string) => boolean {
  const date = part === "start" ? /\b(start(?:ed|ing)?|from)\b/ : /\b(end(?:ed|ing)?|finish(?:ed)?|to|last)\b/;
  return (label: string) => date.test(label) && new RegExp(`\\b${unit}\\b`).test(label) && /\bdate\b|\b(month|year)\b/.test(label);
}

/**
 * "Current role" on a checkbox means "I still work here", but "Current job
 * title" is a text box asking for the title itself. Both contain "current" and
 * a role noun, so a purely keyword test hands a Yes/No answer to a free-text
 * field - 1Password's "Current job title?" was submitted as "Yes". A boolean
 * question either reads as one ("Is this...", "Do you currently...", anything
 * with "here") or is one of the bare checkbox labels, and it never names the
 * attribute it is supposedly asking for.
 */
/**
 * Work eligibility, authorization and sponsorship are legally material and are
 * decided from the candidate's stored answers, never inferred from whether a
 * job on the CV has an end date.
 */
const WORK_ELIGIBILITY_TEXT =
  /\b(eligible to work|authoriz|authoris|sponsor|visa|work permit|right to work|legally)\b/i;

const NAMES_AN_ATTRIBUTE =
  /\b(title|name|company|employer|organisation|organization|salary|compensation|date|month|year|level|team|manager|location|description|duration|responsibilities)\b/;

function currentRoleBoolean(label: string): boolean {
  if (exact("current role", "current position", "current job", "currently work here", "i currently work here")(label)) {
    return true;
  }
  // Whether the candidate may lawfully work is never a fact about their current
  // employer. Abnormal Security asks "Are you currently eligible to work in the
  // country in which this job is posted?" - "currently", "job" and a leading
  // "Are" together read as "is this your current role?", so an unfinished
  // Microsoft end date answered a work-eligibility question with Yes. It was the
  // right answer for the wrong reason, and would have been the same Yes for any
  // country named.
  if (WORK_ELIGIBILITY_TEXT.test(label)) return false;
  // "this job" is the vacancy being applied for, not the candidate's own.
  if (/\b(this|the)\s+(job|role|position)\b/.test(label)) return false;
  if (!/\bcurrent(ly)?\b/.test(label) || !/\b(role|position|job|employer|here)\b/.test(label)) return false;
  if (NAMES_AN_ATTRIBUTE.test(label)) return false;
  return /\bhere\b/.test(label) || /^(is|are|do|does|have|has)\b/.test(label);
}

const RESOLVERS: readonly Resolver[] = [
  {
    test: exact(
      "company",
      "company name",
      "employer",
      "employer name",
      "organization",
      "organisation",
      "current company",
      "current employer",
      "current company name",
      "current employer name",
      "most recent company",
      "most recent employer",
      "current or previous employer",
      "current or previous company",
      "current or most recent employer",
      "current or most recent company",
      "who is your current or previous employer",
      "who is your current or most recent employer",
    ),
    category: "employment-history",
    citation: "experience[0].company",
    resolve: (entry) => entry.company,
  },
  {
    test: exact(
      "title",
      "job title",
      "position",
      "role",
      "position title",
      "your title",
      "current title",
      "current job title",
      "current position title",
      "current role title",
      "most recent title",
      "most recent job title",
      "current or previous job title",
      "current or most recent job title",
      "current or previous title",
      "current or most recent title",
      "what is your current or previous job title",
      "what is your current or most recent job title",
    ),
    category: "employment-history",
    citation: "experience[0].title",
    resolve: (entry) => entry.title,
  },
  {
    test: component("start", "month"),
    category: "employment-history",
    citation: "experience[0].start",
    resolve: (entry) => splitPeriod(entry.start)?.month ?? "",
  },
  {
    test: component("start", "year"),
    category: "employment-history",
    citation: "experience[0].start",
    resolve: (entry) => splitPeriod(entry.start)?.year ?? "",
  },
  {
    test: component("end", "month"),
    category: "employment-history",
    citation: "experience[0].end",
    // A current role has no end date. Leaving these blank and ticking "Current
    // role" is the truthful answer; inventing an end month would not be.
    resolve: (entry) => (isCurrent(entry) ? "" : (splitPeriod(entry.end)?.month ?? "")),
  },
  {
    test: component("end", "year"),
    category: "employment-history",
    citation: "experience[0].end",
    resolve: (entry) => (isCurrent(entry) ? "" : (splitPeriod(entry.end)?.year ?? "")),
  },
  {
    test: (label) => currentRoleBoolean(label),
    category: "employment-history",
    citation: "experience[0].end",
    resolve: (entry) => (isCurrent(entry) ? "Yes" : "No"),
  },
  {
    test: (label) => yearsThresholdIn(label) !== null,
    category: "employment-history",
    citation: "experience[].start",
    resolve: (_entry, profile, label) => answerYearsThreshold(label, profile),
  },
];

/**
 * "Do you have over 5 years of professional software engineering experience?"
 *
 * The profile already states every start and end date, so the answer is
 * arithmetic on facts the attached resume gives anyway. Boards ask this at
 * every threshold from 3 to 10, and GitLab asks two different ones on the same
 * form, so a stored yes or no is wrong at some of them: the number has to be
 * read from the question and compared.
 *
 * Internships are excluded. They are real experience but they are not what a
 * board means by professional or full-time years, and counting them decides the
 * answer either way around the six-year mark.
 */
const YEARS_THRESHOLD = /\b(\d{1,2})\s*\+?\s*years?\b/;
const STRICTLY_MORE = /\b(?:over|more than|greater than|beyond)\s*$/;

/**
 * The question must be about experience in general. "5 years of experience with
 * Kubernetes" asks about one technology, which the profile does not track, so
 * it stays with a person.
 */
const GENERAL_EXPERIENCE =
  /\b(?:professional|software engineering|software development|engineering|industry|full[-\s]?time|work|working|relevant|technical)\b/;
const NAMES_A_SUBJECT = /\bexperience\s+(?:with|in|using|building|developing|working|programming)\b/;

function yearsThresholdIn(label: string): number | null {
  const experienceAt = label.indexOf("experience");
  if (experienceAt < 0) return null;
  if (NAMES_A_SUBJECT.test(label)) return null;
  const match = YEARS_THRESHOLD.exec(label);
  if (!match || match.index > experienceAt) return null;
  const between = label.slice(match.index + match[0].length, experienceAt);
  const filler = between.replace(/\b(?:of|over|in|the|a|an)\b/g, "").trim();
  if (filler.length > 0 && !GENERAL_EXPERIENCE.test(between)) return null;
  const years = Number(match[1]);
  return Number.isFinite(years) ? years : null;
}

/** Whole months of non-internship experience, expressed in years. */
function fullTimeYears(profile: Profile): number {
  const asDate = (period: string): Date | null => {
    const match = /^(\d{4})-(\d{1,2})$/.exec(period.trim());
    return match ? new Date(Number(match[1]), Number(match[2]) - 1) : null;
  };
  let months = 0;
  for (const entry of profile.experience) {
    if (/\bintern(ship)?\b/i.test(entry.title)) continue;
    const from = asDate(entry.start);
    if (!from) continue;
    const to = isCurrent(entry) ? new Date() : asDate(entry.end);
    if (!to) continue;
    const span = (to.getFullYear() - from.getFullYear()) * 12 + (to.getMonth() - from.getMonth());
    if (span > 0) months += span;
  }
  return months / 12;
}

function answerYearsThreshold(label: string, profile: Profile): string {
  const threshold = yearsThresholdIn(label);
  if (threshold === null) return "";
  const match = YEARS_THRESHOLD.exec(label);
  const strict = match ? STRICTLY_MORE.test(label.slice(0, match.index)) : false;
  const held = fullTimeYears(profile);
  return (strict ? held > threshold : held >= threshold) ? "Yes" : "No";
}

/**
 * Returns the employment-history value for a live field label, or null when the
 * profile says nothing about it.
 */
export function resolveExperience(label: string, profile: Profile): ExperienceResolution | null {
  const entry = mostRecent(profile);
  if (!entry) return null;
  const normalized = normalizeLabel(label);
  for (const resolver of RESOLVERS) {
    if (!resolver.test(normalized)) continue;
    const answer = resolver.resolve(entry, profile, normalized);
    if (answer.trim().length === 0) return null;
    return { answer, citation: resolver.citation, category: resolver.category, authorized: true };
  }
  return null;
}
