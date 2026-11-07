import { SKILL_TERMS, TECH_TERMS, type TechTerm, type TermForm } from "./techVocabulary.js";
import { escapeRegExp } from "./words.js";

/**
 * Finding vocabulary terms in text. Matches respect word boundaries ("Java"
 * never matches inside "JavaScript", "C++" still matches), a hyphen and a
 * space are interchangeable ("event driven" is "event-driven"), and an
 * everyday word counts only where it cannot be the word: mid-sentence, or as
 * a list item ("Go, Rust or C++" yes, "React to incidents" no).
 */

/** Extra guards for one spelling: "Go" is a language only outside phrasal verbs and "go-to"; places and products named alike are not the tool. */
const FORM_GUARDS: Readonly<Record<string, string>> = {
  Go: String.raw`(?!-)(?!\s+(?:to|live|above|beyond|further|deep|deeper|ahead|back|out|get|after)\b)`,
  Salt: String.raw`(?!\s+Lake\b)`,
  Unity: String.raw`(?!\s+Catalog\b)`,
};

/** Not the first word of a sentence, a line or a list item. */
const NOT_SENTENCE_START = String.raw`(?<![.!?:;]\s*)(?<!(?:^|\n)\s*(?:[-*\u2022\u00b7\u25cf]|\d{1,2}[.)])?\s*)`;
const LIST_ITEM_FOLLOWS = String.raw`(?=\s*(?:[,/);]|\n|$)|\s+(?:and|or|&)\s)`;

const patternCache = new Map<string, RegExp>();

function formPattern(form: TermForm): RegExp {
  const key = `${form.caseSensitive ? "s" : "i"}${form.ordinaryWord ? "w" : ""}|${form.text}`;
  const cached = patternCache.get(key);
  if (cached) return cached;
  const body = escapeRegExp(form.text).replace(/-|\s+/g, String.raw`(?:-|\s+)`) + (FORM_GUARDS[form.text] ?? "");
  const end = "(?![A-Za-z0-9])";
  const source = form.ordinaryWord
    ? `(?<![A-Za-z0-9-])(?:${NOT_SENTENCE_START}${body}${end}|${body}${LIST_ITEM_FOLLOWS})`
    : `(?<![A-Za-z0-9])${body}${end}`;
  const pattern = new RegExp(source, form.caseSensitive ? "g" : "gi");
  patternCache.set(key, pattern);
  return pattern;
}

function countTerm(text: string, term: TechTerm): number {
  return term.forms.reduce((sum, form) => sum + [...text.matchAll(formPattern(form))].length, 0);
}

export function mentionsTerm(text: string, term: TechTerm): boolean {
  return term.forms.some((form) => {
    const pattern = formPattern(form);
    pattern.lastIndex = 0;
    return pattern.test(text);
  });
}

/** The vocabulary entry for a free-text skill name, by term or alias, in any case. */
export function lookupTerm(name: string): TechTerm | null {
  const wanted = name.trim().toLowerCase();
  return TECH_TERMS.find((term) => term.forms.some((form) => form.text.toLowerCase() === wanted)) ?? null;
}

/** The first run of letters and digits in each spelling: a term can only match text holding one of them. */
const firstRuns = new Map(TECH_TERMS.map((term) => [term, term.forms.map((form) => /[a-z0-9]+/.exec(form.text.toLowerCase())?.[0] ?? "")]));

/** Vocabulary terms present in the text, most frequent first. */
export function findKnownTerms(text: string, vocabulary: readonly TechTerm[] = SKILL_TERMS): Array<{ term: TechTerm; count: number }> {
  const runs = new Set(text.toLowerCase().match(/[a-z0-9]+/g) ?? []);
  return vocabulary
    .filter((term) => (firstRuns.get(term) ?? [""]).some((run) => run === "" || runs.has(run)))
    .map((term) => ({ term, count: countTerm(text, term) }))
    .filter((entry) => entry.count > 0)
    .sort((a, b) => b.count - a.count || a.term.term.localeCompare(b.term.term));
}

/** Words that look technical but name no skill: places, laws, benefits, generic acronyms. */
const NOT_A_SKILL = new Set(
  [
    "US", "USA", "UK", "EU", "EEO", "EEOC", "ADA", "HR", "CEO", "CTO", "CFO", "COO", "VP", "SVP", "PTO", "FAQ", "LGBTQ", "OFCCP",
    "NY", "CA", "SF", "NYC", "DC", "WA", "TX", "PST", "EST", "CST", "UTC", "ASAP", "FTE", "TBD", "OTE", "USD", "CAD", "EUR", "GBP",
    "ID", "RSU", "RSUs", "ESPP", "AI", "IT", "B2B", "B2C", "SaaS", "API", "APIs", "UI", "UX", "QA", "PM", "OKR", "OKRs", "KPI", "KPIs",
    "BS", "BA", "MS", "MA", "MBA", "PhD", "STEM", "GPA", "AM", "LinkedIn", "YouTube", "iPhone", "eBay", "PayPal", "OR", "AND",
    "APAC", "EMEA", "AMER", "LATAM", "ANZ", "NAMER", "GMT", "CET", "PDT", "EDT", "NA", "TBA", "DEI", "ERG", "ERGs",
  ].map((value) => value.toLowerCase()),
);

const KNOWN_SPELLINGS = new Set(TECH_TERMS.flatMap((term) => term.forms.map((form) => form.text.toLowerCase())));

/**
 * Technical-looking tokens the vocabulary does not know: mixed-case words
 * ("ClickPipe"), acronyms ("SIEM") and symbol-bearing names ("C++",
 * "Node.js"). Used only on requirement text, where they are most likely skills.
 */
export function findTechLikeTokens(text: string, exclude: readonly string[] = []): string[] {
  const skip = new Set([...NOT_A_SKILL, ...exclude.map((value) => value.toLowerCase())]);
  const found = new Set<string>();
  const patterns = [
    /(?<![A-Za-z0-9])[A-Za-z][a-z]+[A-Z][A-Za-z0-9]*(?![A-Za-z0-9])/g,
    /(?<![A-Za-z0-9])[A-Z]{2,6}s?(?![A-Za-z0-9])/g,
    /(?<![A-Za-z0-9])[A-Za-z][A-Za-z0-9]*(?:\.js|\+\+|#)(?![A-Za-z0-9])/g,
  ];
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      const lower = match[0].toLowerCase();
      if (!skip.has(lower) && !KNOWN_SPELLINGS.has(lower)) found.add(match[0]);
    }
  }
  return [...found];
}

/** Single-word spellings of named technologies (not practices), as written in the vocabulary. */
const NAME_SPELLINGS = TECH_TERMS.filter((term) => !term.concept).flatMap((term) =>
  term.forms.filter((form) => !/\s/.test(form.text) && (/[A-Z0-9+#./]/.test(form.text) || term.term === term.term.toLowerCase())),
);

/** Technology names recognised in any case ("terraform", "dbt"), lowercased. */
export const LOWERCASE_TECH_WORDS: ReadonlySet<string> = new Set(
  NAME_SPELLINGS.filter((form) => !form.caseSensitive || form.text === form.text.toLowerCase()).map((form) => form.text.toLowerCase()),
);

/** Every single-word technology name, lowercased, including everyday words recognised only when capitalised ("rust", "spark"). */
export const TECH_WORDS: ReadonlySet<string> = new Set(NAME_SPELLINGS.map((form) => form.text.toLowerCase()));
