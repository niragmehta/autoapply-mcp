import type { Profile } from "../domain/profile.js";
import { extractDates, extractFigures, isoMonthKey, profileFigureEvidence, yearsOnly, type Figure } from "../text/figures.js";
import { readJdLines } from "../text/jobDescription.js";
import { LOWERCASE_TECH_WORDS, TECH_WORDS } from "../text/techTerms.js";
import { normalizeTerm, normalizeWord, words } from "../text/words.js";
import { AppError } from "../util/errors.js";
import {
  extractEmployers,
  extractTermCandidates,
  looksTechnical,
  numberSupported,
  titleClaims,
  type TermCandidate,
  type TitleClaim,
} from "./claims.js";
import { stripMetricMarkers, type ResumeSource } from "./resumeSource.js";

/**
 * The fact check for anything a model writes: a headline override, a cover
 * letter, any other prose that reaches an employer.
 *
 * The corpus is the candidate's own evidence: every string in resume.json and
 * the profile's identity, relocation targets, skills (with aliases), facts,
 * experience and education. A figure, a named technology or proper noun, an
 * employer, a job title or a date that the corpus does not contain is
 * reported, and `assertFacts` refuses the text. It checks what is claimed, not
 * how it is worded: rephrasing is free, new facts are not. A figure must come
 * from the record itself, not from a phone number, a link or a month in an
 * ISO date. Adapted from the fact gate in career-ops
 * (https://github.com/career-ops-hq/career-ops, MIT).
 */

export type FactCorpus = {
  /** Every evidence string as normalized words, " | "-separated and space-padded for phrase lookup. */
  phrases: string;
  words: ReadonlySet<string>;
  numbers: readonly Figure[];
  employers: readonly string[];
  titles: readonly string[];
  dates: ReadonlySet<string>;
  /**
   * What the posting says outside its requirements: the employer's products,
   * teams and places. A letter may name these; it may not claim a skill the
   * posting asks for unless the evidence holds it.
   */
  postingPhrases: string;
  postingWords: ReadonlySet<string>;
  /** The title of the job being written for, which a letter may name as "the <title> role". */
  roles: readonly string[];
};

type CorpusInput = { source?: ResumeSource | null; profile: Profile };

/** What a letter may name without it being in the evidence: the employer, the role, where it is, and the posting's own description. */
type CheckContext = { company?: string; role?: string; locations?: readonly string[]; posting?: string };

export type FactIssueKind = "number" | "term" | "employer" | "title" | "date";
type FactIssue = { kind: FactIssueKind; token: string; detail: string };
export type FactCheckResult = {
  ok: boolean;
  issues: FactIssue[];
  checked: Record<FactIssueKind, number>;
};

const present = (value: string | undefined | null): value is string => typeof value === "string" && value.trim().length > 0;

/** The resume source's evidence, its contact line aside. */
function resumeEvidence(source: ResumeSource): string[] {
  return [
    source.header.name,
    source.header.headline,
    ...source.experience.flatMap((entry) => [
      entry.organization,
      entry.location,
      ...entry.roles.flatMap((role) => [
        role.title,
        role.dates,
        ...role.groups.flatMap((group) => [group.label, ...group.bullets.flatMap((bullet) => [stripMetricMarkers(bullet.text), ...bullet.tags])]),
      ]),
    ]),
    ...source.additional.flatMap((entry) => [entry.organization, entry.location, entry.title, entry.dates]),
    ...source.education.flatMap((entry) => [entry.institution, entry.location, entry.credential, entry.dates]),
    ...source.skills.categories.flatMap((category) => [category.label, ...category.terms]),
    ...Object.values(source.variants).map((variant) => variant.headline),
  ].filter(present);
}

/** Names, places and dates the profile holds; its figures come from `profileFigureEvidence`. */
function profileEvidence(profile: Profile): string[] {
  const { identity, workAuthorization } = profile;
  return [
    identity.fullName,
    identity.headline,
    identity.email,
    identity.phone,
    identity.location.city,
    identity.location.region,
    identity.location.country,
    ...Object.values(identity.links),
    workAuthorization.statement,
    ...workAuthorization.citizenships,
    ...profile.preferences.relocationTargets,
    ...profile.skills.flatMap((skill) => [skill.name, ...skill.aliases]),
    ...profile.facts.flatMap((fact) => [fact.statement, ...fact.metrics, ...fact.tags, fact.evidence]),
    ...profile.experience.flatMap((role) => [role.company, role.title, role.location, role.start, role.end, ...role.highlights]),
    ...profile.education.flatMap((entry) => [entry.institution, entry.credential, entry.field, entry.location, entry.start, entry.end]),
  ].filter(present);
}

function wordSet(texts: readonly string[]): Set<string> {
  // Compounds are indexed whole and by part, so "Bicep/ARM" supports "ARM".
  return new Set(
    texts
      .flatMap((text) => words(text))
      .flatMap((word) => [word, ...word.split(/[-/]/).map(normalizeWord)])
      .filter((word) => word.length > 0),
  );
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values.filter((value) => value.length > 0))];
}

const phraseIndex = (texts: readonly string[]) => ` ${texts.map((text) => words(text).join(" ")).join(" | ")} `;

/** Builds the evidence corpus from the resume source (when there is one) and the profile. */
export function buildFactCorpus(input: CorpusInput): FactCorpus {
  const { profile, source } = input;
  const resume = source ? resumeEvidence(source) : [];
  const contact = source ? source.header.contact.flatMap((item) => [item.text, item.href]).filter(present) : [];
  const evidence = [...resume, ...contact, ...profileEvidence(profile)];
  const figureEvidence = [...resume.map(yearsOnly), ...profileFigureEvidence(profile).map((entry) => entry.text)];
  const employers = [
    ...(source ? source.experience.map((entry) => entry.organization) : []),
    ...(source ? source.additional.map((entry) => entry.organization) : []),
    ...(source ? source.education.map((entry) => entry.institution) : []),
    ...profile.experience.map((role) => role.company),
    ...profile.education.map((entry) => entry.institution),
  ];
  const titles = [
    ...(source ? source.experience.flatMap((entry) => entry.roles.map((role) => role.title)) : []),
    ...(source ? source.additional.map((entry) => entry.title) : []),
    ...(source ? [source.header.headline, ...Object.values(source.variants).map((variant) => variant.headline ?? "")] : []),
    ...profile.experience.map((role) => role.title),
    profile.identity.headline,
  ];
  const isoDates = [...profile.experience.flatMap((role) => [role.start, role.end]), ...profile.education.flatMap((entry) => [entry.start, entry.end])];
  return {
    phrases: phraseIndex(evidence),
    words: wordSet(evidence),
    numbers: figureEvidence.flatMap(extractFigures),
    employers: unique(employers.map(normalizeTerm)),
    titles: unique(titles.map(normalizeTerm)),
    dates: new Set([
      ...evidence.flatMap((text) => extractDates(text).map((date) => date.key)),
      ...isoDates.map(isoMonthKey).filter(present),
    ]),
    postingPhrases: "",
    postingWords: new Set(),
    roles: [],
  };
}

/** "Hudson River Trading" is also "HRT". */
function initials(name: string): string[] {
  const capitals = name.split(/\s+/).filter((word) => /^\p{Lu}/u.test(word));
  return capitals.length >= 2 ? [capitals.map((word) => word[0]).join("")] : [];
}

/**
 * The corpus plus the posting being written for: its employer (and the
 * employer's initials), role and locations, and the parts of its description
 * that are not requirements.
 */
export function withContext(corpus: FactCorpus, context: CheckContext): FactCorpus {
  const company = present(context.company) ? [context.company, ...initials(context.company)] : [];
  const extra = [...company, context.role, ...(context.locations ?? [])].filter(present);
  const described = context.posting
    ? readJdLines(context.posting)
        .filter((line) => !line.heading && line.section !== "requirements" && line.section !== "preferred")
        .map((line) => line.text)
    : [];
  return {
    ...corpus,
    phrases: extra.length > 0 ? `${corpus.phrases}|${phraseIndex(extra)}` : corpus.phrases,
    words: new Set([...corpus.words, ...wordSet(extra)]),
    numbers: [...corpus.numbers, ...extra.flatMap(extractFigures)],
    employers: unique([...corpus.employers, ...company.map(normalizeTerm)]),
    // The role is not a title the candidate holds: "I was a <target title>" stays a claim to check.
    titles: corpus.titles,
    roles: unique([...corpus.roles, ...(present(context.role) ? [normalizeTerm(context.role)] : [])]),
    postingPhrases: described.length > 0 ? `${corpus.postingPhrases}|${phraseIndex(described)}` : corpus.postingPhrases,
    postingWords: new Set([...corpus.postingWords, ...wordSet(described)]),
  };
}

function phraseIn(index: string, text: string): boolean {
  const phrase = words(text).join(" ");
  return phrase.length > 0 && index.includes(` ${phrase} `);
}

function tokenIn(known: ReadonlySet<string>, token: string): boolean {
  const normalized = words(token);
  if (normalized.length > 0 && normalized.every((word) => known.has(word))) return true;
  const parts = token.split(/[-/]/).filter((part) => part.length > 0);
  return parts.length > 1 && parts.every((part) => words(part).every((word) => known.has(word)));
}

function isTechnical(token: string): boolean {
  return looksTechnical(token) || TECH_WORDS.has(token.toLowerCase());
}

/**
 * The words of a named phrase the evidence lacks. The posting's own
 * description supports a plain name (a product, team or place) anywhere, and
 * a technical one only in a sentence that is not about the candidate, so
 * "your team's Kafka platform" passes where "my Kafka experience" does not.
 */
function unsupportedWords(candidate: TermCandidate, corpus: FactCorpus): string[] {
  if (phraseIn(corpus.phrases, candidate.surface)) return [];
  const postingMay = (token: string) => !isTechnical(token) || !candidate.firstPerson;
  if (phraseIn(corpus.postingPhrases, candidate.surface) && candidate.tokens.every(postingMay)) return [];
  return candidate.tokens.filter((token) => !tokenIn(corpus.words, token) && !(postingMay(token) && tokenIn(corpus.postingWords, token)));
}

function employerSupported(name: string, corpus: FactCorpus): boolean {
  const normalized = normalizeTerm(name);
  return corpus.employers.some(
    (employer) => employer === normalized || employer.startsWith(`${normalized} `) || normalized.startsWith(`${employer} `),
  );
}

/** A title the candidate held, or "the <title>" naming the job being written for. */
function titleSupported(claim: TitleClaim, corpus: FactCorpus): boolean {
  const normalized = ` ${normalizeTerm(claim.title)} `;
  const within = (known: string) => ` ${known} `.includes(normalized);
  return corpus.titles.some(within) || (claim.definite && corpus.roles.some(within));
}

/** Checks `text` against the corpus without throwing. */
export function checkFacts(text: string, corpus: FactCorpus): FactCheckResult {
  const numbers = extractFigures(text);
  const terms = extractTermCandidates(text, LOWERCASE_TECH_WORDS);
  const employers = extractEmployers(text);
  const titles = titleClaims(text);
  const dates = extractDates(text);

  const specific: FactIssue[] = [
    ...employers
      .filter((name) => !employerSupported(name, corpus))
      .map((name) => ({ kind: "employer" as const, token: name, detail: `"${name}" is not an employer or school in the resume source or profile` })),
    ...titles
      .filter((claim) => !titleSupported(claim, corpus))
      .map((claim) => ({ kind: "title" as const, token: claim.title, detail: `"${claim.title}" is not a title in the resume source or profile` })),
    ...dates
      .filter((date) => !corpus.dates.has(date.key))
      .map((date) => ({ kind: "date" as const, token: date.raw, detail: `the date "${date.raw}" is not in the resume source or profile` })),
  ];
  // A name already reported as an employer or title is not reported again as a term.
  const covered = specific.map((issue) => issue.token.toLowerCase());
  const termIssues = terms.flatMap((candidate) => {
    const missing = unsupportedWords(candidate, corpus);
    const surface = candidate.surface.toLowerCase();
    if (missing.length === 0 || covered.some((token) => token.includes(surface))) return [];
    const part = candidate.tokens.length > 1 ? ` (unsupported: ${missing.join(", ")})` : "";
    return [{ kind: "term" as const, token: candidate.surface, detail: `"${candidate.surface}" is not named in the resume source or profile${part}` }];
  });
  const numberIssues = numbers
    .filter((claim) => !numberSupported(claim, corpus.numbers))
    .map((claim) => ({ kind: "number" as const, token: claim.raw, detail: `the figure "${claim.raw}" is not in the resume source or profile` }));

  const seen = new Set<string>();
  const issues = [...numberIssues, ...termIssues, ...specific].filter((issue) => {
    const key = `${issue.kind}:${issue.token.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return {
    ok: issues.length === 0,
    issues,
    checked: { number: numbers.length, term: terms.length, employer: employers.length, title: titles.length, date: dates.length },
  };
}

/** Checks `text` and throws `fact_check_failed`, naming every unsupported claim, when any fails. */
export function assertFacts(text: string, corpus: FactCorpus, label: string): FactCheckResult {
  const result = checkFacts(text, corpus);
  if (result.ok) return result;
  const listed = result.issues.map((issue) => `${issue.kind} "${issue.token}"`).join(", ");
  throw new AppError(
    "fact_check_failed",
    `${label} makes claims the resume source and profile do not support: ${listed}. Remove or rephrase them; new evidence belongs in profile.json or resume.json, not in generated text.`,
    { issues: result.issues },
  );
}
