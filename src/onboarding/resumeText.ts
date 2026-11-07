import { detectInjection } from "../text/untrusted.js";
import { findDateRange, findSingleYear } from "./resumeDates.js";
import { classifyHeader, looksLikeLocation, splitHeader } from "./resumeParts.js";

/**
 * Deterministic extraction scaffold from pasted resume text.
 *
 * The output is a proposal, never a write: every entry is shaped like the
 * profile schema so an agent can confirm it with the candidate and then save
 * it with update_profile. Nothing is inferred beyond what the text states;
 * fields the heuristics cannot place are left empty for the candidate to fill.
 * The text is untrusted input - a resume can carry instructions - so injection
 * signals are reported alongside.
 */

export const RESUME_TEXT_MAX_CHARS = 60_000;

export type SectionKind = "experience" | "education" | "skills" | "summary" | "projects" | "certifications" | "other";

const HEADINGS: Record<string, SectionKind> = Object.fromEntries([
  ...["experience", "work experience", "professional experience", "employment", "employment history", "work history", "career history", "relevant experience", "professional background", "industry experience"].map((h) => [h, "experience"]),
  ...["education", "education and training", "academic background", "academic history", "academics"].map((h) => [h, "education"]),
  ...["skills", "technical skills", "core skills", "key skills", "core competencies", "competencies", "technologies", "tools", "skills and tools", "skills and technologies", "tech stack", "technical proficiencies", "areas of expertise", "expertise", "skills and expertise"].map((h) => [h, "skills"]),
  ...["summary", "professional summary", "profile", "about", "about me", "objective", "career objective", "overview", "career summary"].map((h) => [h, "summary"]),
  ...["projects", "selected projects", "personal projects", "side projects", "open source", "key projects"].map((h) => [h, "projects"]),
  ...["certifications", "certificates", "licenses", "licenses and certifications", "certifications and licenses"].map((h) => [h, "certifications"]),
  ...["publications", "awards", "honors", "honors and awards", "awards and honors", "volunteer", "volunteering", "volunteer experience", "languages", "interests", "references", "patents", "talks", "leadership", "activities", "achievements"].map((h) => [h, "other"]),
]) as Record<string, SectionKind>;

const BULLET = /^(?:[-*\u2022\u25cf\u25aa\u25e6\u2023\u2219\u00b7\u2013\u25ba\u27a2>]|o(?=\s+[A-Z])|\d{1,2}[.)])\s+/;

type Line = { number: number; text: string; kind: "blank" | "heading" | "bullet" | "text"; section: SectionKind | null };

export function headingKind(raw: string): SectionKind | null {
  const cleaned = raw
    .replace(/^#+\s*/, "")
    .replace(/\*\*/g, "")
    .replace(/[:\s]+$/, "")
    .trim()
    .toLowerCase()
    .replace(/\s*&\s*/g, " and ");
  if (cleaned.length === 0 || cleaned.length > 40) return null;
  return HEADINGS[cleaned] ?? null;
}

function toLines(text: string): Line[] {
  let section: SectionKind | null = null;
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((raw, index) => {
      const text = raw.replace(/[\t\u00a0]/g, "  ").replace(/ {3,}/g, "  ").trim();
      if (text.length === 0) return { number: index + 1, text, kind: "blank" as const, section };
      const heading = headingKind(text);
      if (heading) {
        section = heading;
        return { number: index + 1, text, kind: "heading" as const, section };
      }
      if (BULLET.test(text)) return { number: index + 1, text: text.replace(BULLET, "").trim(), kind: "bullet" as const, section };
      return { number: index + 1, text, kind: "text" as const, section };
    });
}

export type ExtractedExperience = {
  company: string;
  title: string;
  location: string;
  start: string;
  end: string;
  highlights: string[];
  line: number;
  needsConfirmation: string[];
};

/** A plain line that is a sentence, not a header: too long, or ending in a full stop after a word. */
function isSentence(text: string): boolean {
  return text.length > 100 || /[a-z]{3,}[.!?]$/.test(text);
}

/** A wrapped bullet continues on a line starting in lowercase. */
function continuesBullet(text: string): boolean {
  return /^[a-z(]/.test(text);
}

function draftEntry(headerLines: readonly string[], start: string, end: string, line: number): ExtractedExperience {
  const fields = classifyHeader(headerLines.flatMap(splitHeader));
  return { ...fields, start, end, highlights: [], line, needsConfirmation: [] };
}

function fillFrom(entry: ExtractedExperience, text: string): ExtractedExperience {
  const extra = classifyHeader(splitHeader(text));
  return {
    ...entry,
    title: entry.title || extra.title,
    company: entry.company || extra.company,
    location: entry.location || extra.location,
  };
}

function parseExperience(lines: readonly Line[]): { entries: ExtractedExperience[]; orphanBullets: number } {
  const entries: ExtractedExperience[] = [];
  let pending: string[] = [];
  let orphanBullets = 0;
  let lastBullet = false;
  const current = () => entries[entries.length - 1];
  const replaceCurrent = (entry: ExtractedExperience) => {
    entries[entries.length - 1] = entry;
  };

  for (const line of lines) {
    if (line.kind === "blank" || line.kind === "heading") {
      // A blank line closes whatever block came before; header lines for the
      // next role start after it.
      pending = [];
      lastBullet = false;
      continue;
    }
    const entry = current();
    if (line.kind === "bullet") {
      if (entry) replaceCurrent({ ...entry, highlights: [...entry.highlights, line.text] });
      else orphanBullets += 1;
      pending = [];
      lastBullet = true;
      continue;
    }
    const range = findDateRange(line.text);
    if (range) {
      const remainder = `${line.text.slice(0, range.index)}  ${line.text.slice(range.index + range.matched.length)}`;
      const header = [...pending.slice(-3), remainder].filter((text) => !isSentence(text));
      entries.push(draftEntry(header, range.start, range.end, line.number));
      pending = [];
      lastBullet = false;
      continue;
    }
    if (entry && lastBullet && continuesBullet(line.text)) {
      const highlights = [...entry.highlights];
      highlights[highlights.length - 1] = `${highlights[highlights.length - 1]} ${line.text}`;
      replaceCurrent({ ...entry, highlights });
      continue;
    }
    if (entry && entry.highlights.length === 0 && (!entry.title || !entry.company || !entry.location) && !isSentence(line.text)) {
      replaceCurrent(fillFrom(entry, line.text));
      continue;
    }
    pending.push(line.text);
    lastBullet = false;
  }
  return {
    entries: entries.map((entry) => ({
      ...entry,
      needsConfirmation: [
        ...(entry.company ? [] : ["company"]),
        ...(entry.title ? [] : ["title"]),
        ...(entry.start.length === 4 ? ["start month"] : []),
      ],
    })),
    orphanBullets,
  };
}

export type ExtractedEducation = { institution: string; credential: string; field: string; location: string; start: string; end: string; line: number };

const INSTITUTION = /\b(?:university|universit[eéà]|college|institute|school|polytechnic|academy|conservatory|\bIIT\b|\bMIT\b)\b/i;
const DEGREE =
  /(?:Ph\.?\s?D\.?|Doctor(?:ate)?(?: of [A-Z][A-Za-z]+(?: [A-Z][A-Za-z]+)?)?|M\.?B\.?A\.?|M\.S\.|M\.A\.|M\.?Sc\.?|M\.?Eng\.?|M\.?Tech\.?|Master(?:'s)?(?: of [A-Z][A-Za-z]+(?: [A-Z][A-Za-z]+)?)?|B\.S\.|B\.A\.|B\.?Sc\.?|B\.?A\.?Sc\.?|B\.?Eng\.?|B\.?Tech\.?|Bachelor(?:'s)?(?: of [A-Z][A-Za-z]+(?: [A-Z][A-Za-z]+)?)?|Associate(?:'s)? (?:of|in) [A-Z][A-Za-z]+|(?:BS|MS|BA|MA)(?= in\b)|Diploma|Certificate)(?![A-Za-z])/;

function fieldAfter(text: string, end: number): string {
  const rest = text.slice(end);
  const match = /^\s*(?:in|,|-|\u2013|\u2014|:)?\s*\(?([A-Z][A-Za-z&/ ]{2,60}?)\)?\s*(?:$|[,|\u2013\u2014(]|\s{2,}|\s-\s)/.exec(rest);
  const field = match?.[1]?.trim() ?? "";
  return field && !INSTITUTION.test(field) && !looksLikeLocation(field) ? field : "";
}

function parseEducation(lines: readonly Line[]): ExtractedEducation[] {
  const out: ExtractedEducation[] = [];
  let block: Line[] = [];
  const flush = () => {
    if (block.length === 0) return;
    const entry: ExtractedEducation = { institution: "", credential: "", field: "", location: "", start: "", end: "", line: block[0]!.number };
    for (const line of block) {
      const range = findDateRange(line.text);
      const text = range ? `${line.text.slice(0, range.index)}  ${line.text.slice(range.index + range.matched.length)}` : line.text;
      if (range && !entry.end) Object.assign(entry, { start: range.start, end: range.end });
      else if (!range && !entry.end) entry.end = findSingleYear(text) ?? "";
      const degree = DEGREE.exec(text);
      if (degree && !entry.credential) {
        entry.credential = degree[0].trim();
        entry.field = fieldAfter(text, degree.index + degree[0].length);
      }
      for (const part of splitHeader(text.replace(/\b(?:19|20)\d{2}\b/g, " "))) {
        if (!entry.institution && INSTITUTION.test(part)) entry.institution = part;
        else if (!entry.location && looksLikeLocation(part)) entry.location = part;
      }
    }
    if (entry.institution || entry.credential) out.push(entry);
    block = [];
  };
  for (const line of lines) {
    if (line.kind === "blank" || line.kind === "heading") {
      flush();
      continue;
    }
    const startsNew = block.length > 0 && ((INSTITUTION.test(line.text) && block.some((entry) => INSTITUTION.test(entry.text))) || (DEGREE.test(line.text) && block.some((entry) => DEGREE.test(entry.text))));
    if (startsNew) flush();
    block.push(line);
  }
  flush();
  return out;
}

function parseSkills(lines: readonly Line[]): Array<{ name: string }> {
  const seen = new Map<string, string>();
  for (const line of lines) {
    if (line.kind !== "text" && line.kind !== "bullet") continue;
    const body = line.text.includes(":") ? line.text.slice(line.text.indexOf(":") + 1) : line.text;
    for (const raw of body.split(/[,;|\u2022\u00b7]/)) {
      const name = raw.replace(/\.$/, "").trim();
      if (name.length < 1 || name.length > 40 || name.split(/\s+/).length > 5) continue;
      if (!seen.has(name.toLowerCase())) seen.set(name.toLowerCase(), name);
    }
  }
  return [...seen.values()].map((name) => ({ name }));
}

const METRIC =
  /[$\u20ac\u00a3]\s?\d[\d,.]*\s?(?:[kmb]\b|million|billion|thousand)?|\b\d[\d,.]*\s?(?:%|percent\b|x\b|\u00d7)|\b\d[\d,.]*\+?\s?(?:k|m|b|million|billion|thousand)?\+?\s+(?:users|customers|clients|requests|rps|qps|tps|transactions|ms|milliseconds|seconds|minutes|hours|days|weeks|engineers|developers|people|members|repositories|repos|services|microservices|servers|nodes|clusters|countries|regions|teams|endpoints|models|pipelines|tests|downloads|stars|projects|applications|apps|accounts|devices|events|records|rows|tb|gb|pb)\b/gi;

export function metricsIn(text: string): string[] {
  return [...new Set([...text.matchAll(METRIC)].map((match) => match[0].trim()))];
}

export type ExtractedFact = { id: string; statement: string; metrics: string[]; category: string; tags: string[]; evidence: string };

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").slice(0, 4).join("-");
}

export type ResumeExtraction = {
  sections: Array<{ heading: string; kind: SectionKind; line: number }>;
  summary: string;
  experience: ExtractedExperience[];
  education: ExtractedEducation[];
  skills: Array<{ name: string }>;
  facts: ExtractedFact[];
  links: string[];
  contactDetected: { email: boolean; phone: boolean };
  warnings: string[];
  injectionFlags: string[];
};

export function extractResumeText(input: string): ResumeExtraction {
  const warnings: string[] = [];
  const text = input.length > RESUME_TEXT_MAX_CHARS ? input.slice(0, RESUME_TEXT_MAX_CHARS) : input;
  if (text.length < input.length) warnings.push(`text truncated to ${RESUME_TEXT_MAX_CHARS} characters`);
  const lines = toLines(text);
  const sections = lines.filter((line) => line.kind === "heading").map((line) => ({ heading: line.text, kind: line.section!, line: line.number }));
  const inSection = (kind: SectionKind) => lines.filter((line) => line.section === kind);

  const hasExperienceHeading = sections.some((section) => section.kind === "experience");
  if (!hasExperienceHeading) warnings.push("no experience heading found; entries were located by their date ranges");
  const experienceLines = hasExperienceHeading ? inSection("experience") : lines.filter((line) => line.section === null || line.section === "other");
  const { entries, orphanBullets } = parseExperience(experienceLines);
  if (orphanBullets > 0) warnings.push(`${orphanBullets} bullet(s) appear before any dated role and were not assigned`);

  const bulletSources = [
    ...entries.flatMap((entry, index) => entry.highlights.map((statement) => ({ statement, evidence: `experience[${index}] (line ${entry.line})` }))),
    ...lines
      .filter((line) => line.kind === "bullet" && line.section !== "experience" && line.section !== "skills")
      .map((line) => ({ statement: line.text, evidence: `line ${line.number}` })),
  ];
  const facts = bulletSources
    .map((source) => ({ ...source, metrics: metricsIn(source.statement) }))
    .filter((source) => source.metrics.length > 0)
    .map((source, index) => ({
      id: `cv-${index + 1}-${slug(source.statement)}`,
      statement: source.statement.slice(0, 400),
      metrics: source.metrics,
      category: "experience",
      tags: [] as string[],
      evidence: `resume text, ${source.evidence}`,
    }));

  const links = [...new Set([...text.matchAll(/https?:\/\/[^\s<>()"']+/gi)].map((match) => match[0].replace(/[.,;]+$/, "")))].slice(0, 10);
  const summary = inSection("summary")
    .filter((line) => line.kind !== "heading" && line.kind !== "blank")
    .map((line) => line.text)
    .join(" ")
    .slice(0, 600);

  return {
    sections,
    summary,
    experience: entries,
    education: parseEducation(inSection("education")),
    skills: parseSkills(inSection("skills")),
    facts,
    links,
    contactDetected: {
      email: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(text),
      phone: /(?<![\d-])(?:\+\d{1,3}[\s.-]?)?(?:\(?\d{3}\)?[\s.-]?)?\d{3}[\s.-]\d{4}(?!\d)/.test(text),
    },
    warnings,
    injectionFlags: detectInjection(text).map((flag) => flag.pattern),
  };
}
