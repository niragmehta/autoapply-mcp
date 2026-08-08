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
  resolve: (entry: Experience) => string;
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

const RESOLVERS: readonly Resolver[] = [
  {
    test: exact("company", "company name", "employer", "employer name", "organization", "organisation"),
    category: "employment-history",
    citation: "experience[0].company",
    resolve: (entry) => entry.company,
  },
  {
    test: exact("title", "job title", "position", "role", "position title", "your title"),
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
    test: (label) => /\bcurrent(ly)?\b/.test(label) && /\b(role|position|job|employer|here)\b/.test(label),
    category: "employment-history",
    citation: "experience[0].end",
    resolve: (entry) => (isCurrent(entry) ? "Yes" : "No"),
  },
];

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
    const answer = resolver.resolve(entry);
    if (answer.trim().length === 0) return null;
    return { answer, citation: resolver.citation, category: resolver.category, authorized: true };
  }
  return null;
}
