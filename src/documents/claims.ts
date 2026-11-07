import { sameValue, type Figure } from "../text/figures.js";

/**
 * Claim extraction for the fact check: job titles, employers and named
 * technologies or proper nouns in model-written text. Figures and dates are
 * read by text/figures.ts.
 *
 * The claim-kind approach follows career-ops' fact gate
 * (https://github.com/career-ops-hq/career-ops, MIT); the extractors are this
 * project's own.
 */

/**
 * Whether a claimed figure appears among the evidence. A percentage or a sum
 * of money must match one of the same kind; a bare count may match any.
 */
export function numberSupported(claim: Pick<Figure, "raw" | "value" | "kind">, evidence: readonly Pick<Figure, "value" | "kind">[]): boolean {
  return evidence.some((known) => sameValue(known.value, claim.value) && (claim.kind === "plain" || known.kind === claim.kind));
}

const TITLE_NOUNS =
  "Engineers?|Developers?|Architects?|Managers?|Scientists?|Analysts?|Designers?|Directors?|Consultants?|Interns?|Researchers?|Administrators?|Specialists?|Officers?|Programmers?|Technologists?|Leads?|Heads?|President|Founder|Co-[Ff]ounder|Fellow|SRE|CTO|CEO|CISO|CIO|VP";
const TITLE = new RegExp(
  // A trailing "I" is a level only when no lowercase word follows; "Engineer I set" is the pronoun.
  String.raw`(?:[A-Z][\w+#./&-]*\s+){1,4}(?:${TITLE_NOUNS})\b(?:\s+(?:III|II|IV|VIII|VII|VI|V|I(?!\s+[a-z])|[1-9])\b)?`,
  "g",
);
const TITLE_LEAD_WORDS = new Set(["the", "a", "an", "as", "at", "for", "our", "my", "your", "dear", "with", "to", "of", "in", "and", "i", "we", "new", "former"]);
const NOT_A_TITLE = /^(?:hiring|recruiting|talent|account|engineering|product|program)\b/i;
// "the Staff Engineer role" names the job applied for, not a title the candidate held.
const NAMES_THE_JOB = /^\s*(?:\([^)]{0,60}\)\s*)?(?:role|position|opening|job|req|requisition)\b/i;

export type TitleClaim = {
  title: string;
  /** Introduced with "the": a particular job ("the Staff Engineer, Platform role"), not a title the candidate held. */
  definite: boolean;
};

/** Capitalized job titles in the text ("Senior Software Engineer II"); generic lowercase roles are not claims. */
export function titleClaims(text: string): TitleClaim[] {
  return [...text.matchAll(TITLE)].flatMap((match) => {
    const index = match.index ?? 0;
    if (NAMES_THE_JOB.test(text.slice(index + match[0].length))) return [];
    const parts = match[0].trim().split(/\s+/);
    const start = parts.findIndex((word) => !TITLE_LEAD_WORDS.has(word.toLowerCase()));
    const lead = parts.slice(0, start < 0 ? parts.length : start).map((word) => word.toLowerCase());
    const title = parts.slice(start < 0 ? parts.length : start).join(" ");
    const definite = lead.at(-1) === "the" || /\bthe\s+$/i.test(text.slice(Math.max(0, index - 6), index));
    return title.split(" ").length >= 2 && !NOT_A_TITLE.test(title) ? [{ title, definite }] : [];
  });
}

export function extractTitles(text: string): string[] {
  return titleClaims(text).map((claim) => claim.title);
}

const NAME = String.raw`[A-Z0-9][\w&.'\u2019-]*(?:\s+(?:[A-Z0-9][\w&.'\u2019-]*|&|of)){0,4}`;
const EMPLOYER_PATTERNS: readonly RegExp[] = [
  new RegExp(String.raw`\b(?:worked|work|working|interned|served|employed)\s+(?:at|for)\s+(${NAME})`, "g"),
  new RegExp(String.raw`\b(?:time|tenure|years?|role|position|career|job|stint|internship)\s+at\s+(${NAME})`, "g"),
  new RegExp(
    String.raw`\b(?:[Ee]ngineer|[Dd]eveloper|[Ss]cientist|[Mm]anager|[Aa]nalyst|[Cc]onsultant|[Aa]rchitect|[Ii]ntern|[Ll]ead|[Rr]esearcher)\s+at\s+(${NAME})`,
    "g",
  ),
  new RegExp(String.raw`\bjoined\s+(${NAME})`, "g"),
  new RegExp(String.raw`(?:^|[.!?]\s+|\n)At\s+(${NAME})\s*,`, "g"),
];

/** Organizations the text says the candidate worked at ("worked at X", "At X, I ..."). */
export function extractEmployers(text: string): string[] {
  const names = EMPLOYER_PATTERNS.flatMap((pattern) => [...text.matchAll(pattern)].map((match) => match[1] ?? ""));
  return [
    ...new Set(
      names
        .map((name) => name.replace(/(?:'|\u2019)s$/, "").replace(/[.\s]+$/, "").replace(/\s+(?:of|&)$/, ""))
        .filter((name) => name.length > 0),
    ),
  ];
}

/**
 * Capitalized words that are letter conventions, not claims: pronouns,
 * greetings, sign-offs, days and months. Months are checked as dates instead.
 */
const COMMON_CAPITALIZED: ReadonlySet<string> = new Set(
  (
    "i i'm i've i'd i'll dear hello hi hiring manager managers team teams recruiter recruiters recruiting talent " +
    "acquisition sincerely regards best kind warm thank thanks mr mrs ms dr re ps cc ok co monday tuesday wednesday " +
    "thursday friday saturday sunday january february march april may june july august september october november " +
    "december jan feb mar apr jun jul aug sep sept oct nov dec spring summer fall autumn winter present today"
  ).split(" "),
);

const SMALL_WORDS = new Set("a an the and or of for in on at to with by from as vs via".split(" "));

export type TermCandidate = {
  surface: string;
  tokens: string[];
  /** Whether its sentence speaks of the candidate ("I", "my", "me"), which makes a named technology a claim. */
  firstPerson: boolean;
};

const TOKEN = /\.?[\p{L}\p{N}](?:[\p{L}\p{N}+#&'\u2019./-]*[\p{L}\p{N}+#])?/gu;

function stripPossessive(token: string): string {
  return token.replace(/(?:'|\u2019)s$/, "");
}

/** Stylized names: camelCase, acronyms, letters with digits, C#/C++, .NET, Node.js, CI/CD. */
export function looksTechnical(token: string): boolean {
  if (/^\d+$/.test(token)) return false;
  if (token.includes("/")) return token.split("/").some((part) => part.length > 0 && looksTechnical(part));
  if (/[a-z][A-Z]/.test(token)) return true;
  if (/^[A-Z][A-Z0-9&]+s?$/.test(token) && /[A-Z].*[A-Z]|[A-Z]\d|\d[A-Z]/.test(token)) return true;
  if (/\d/.test(token) && /\p{L}/u.test(token)) return true;
  if (/[#+]/.test(token) || /^\./.test(token) || /\p{L}\.\p{L}/u.test(token)) return true;
  return false;
}

function isCapitalized(token: string): boolean {
  return /^\p{Lu}/u.test(token);
}

/**
 * The name a token carries, if any. A hyphen joins a name to a version or a
 * capitalized part ("GPT-4", "T-Mobile") but a lowercase part belongs to the
 * surrounding phrase ("Kubernetes-based" names Kubernetes). A lone capital
 * before such a part starts an ordinary word ("E-commerce"), not a name.
 */
function nameIn(token: string, technical: ReadonlySet<string>, capitalsCount: boolean): string | null {
  const isName = (part: string): boolean =>
    part.length > 0 &&
    !COMMON_CAPITALIZED.has(part.toLowerCase().replace(/\u2019/g, "'")) &&
    (looksTechnical(part) || technical.has(part.toLowerCase()) || (capitalsCount && isCapitalized(part) && !/^\d/.test(part)));
  // A slashed pair is a name when either half is ("Bicep/ARM"), not when both are words ("Tuesday/Wednesday").
  if (token.includes("/")) return token.split("/").some(isName) ? token : null;
  if (!token.includes("-") || looksTechnical(token.replace(/-/g, ""))) return isName(token) ? token : null;
  const parts = token.split("-");
  const first = parts[0] ?? "";
  if (!isName(first)) return null;
  const rest = parts.slice(1);
  const lowercaseAt = rest.findIndex((part) => /^\p{Ll}/u.test(part));
  const kept = [first, ...(lowercaseAt < 0 ? rest : rest.slice(0, lowercaseAt))];
  if (kept.length === 1 && first.length === 1 && lowercaseAt === 0) return null;
  return kept.join("-");
}

/** Sentences, with a list separator or line break counting as a boundary. */
function sentences(text: string): string[] {
  return text
    .split(/(?<=[.!?:])\s+|\n+|\s[|\u2022\u00b7\u2013\u2014]\s/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

/**
 * Whether text reads as Title Case, as a headline does, so that every capital
 * is meaningful. Prose with more than one sentence never is, and technology
 * names do not count either way, since they are capitalized anywhere.
 */
export function isTitleCase(text: string): boolean {
  if (/[.!?]\s+\S/.test(text.trim())) return false;
  const plain = (text.match(/[\p{L}\p{N}][\p{L}\p{N}+#./'-]*/gu) ?? []).filter(
    (word) => !SMALL_WORDS.has(word.toLowerCase()) && !looksTechnical(word) && /^\p{L}/u.test(word),
  );
  if (plain.length < 2 || plain.length > 20) return false;
  return plain.filter(isCapitalized).length / plain.length >= 0.6;
}

const FIRST_PERSON = /(?:^|[^\p{L}\p{N}])(?:I|I['\u2019](?:m|ve|d|ll)|[Mm]y|[Mm]e|[Mm]ine|[Mm]yself)(?![\p{L}\p{N}])/u;

/**
 * Named things the text mentions: stylized technology names, listed
 * technology names in any case, and capitalized words other than a
 * sentence's first word. Adjacent names form one phrase ("Open Policy Agent").
 */
export function extractTermCandidates(text: string, technical: ReadonlySet<string>): TermCandidate[] {
  const titleCase = isTitleCase(text);
  return sentences(text).flatMap((sentence) => {
    const firstPerson = FIRST_PERSON.test(sentence);
    const matches = [...sentence.matchAll(TOKEN)];
    const marked = matches.map((match, index) => {
      const token = stripPossessive(match[0]);
      const previous = matches[index - 1];
      const gap = previous ? sentence.slice((previous.index ?? 0) + previous[0].length, match.index ?? 0) : "";
      const capitalsCount = titleCase || index > 0;
      const name = titleCase && SMALL_WORDS.has(token.toLowerCase()) ? null : nameIn(token, technical, capitalsCount);
      // A name cut short ("Kubernetes" from "Kubernetes-based") ends its phrase.
      return { name, whole: name === token, joinsPrevious: /^\s+$/.test(gap) };
    });
    return marked.reduce<TermCandidate[]>((phrases, entry, index) => {
      if (!entry.name) return phrases;
      const previous = marked[index - 1];
      const last = phrases.at(-1);
      if (last && previous?.name && previous.whole && entry.joinsPrevious) {
        return [...phrases.slice(0, -1), { ...last, surface: `${last.surface} ${entry.name}`, tokens: [...last.tokens, entry.name] }];
      }
      return [...phrases, { surface: entry.name, tokens: [entry.name], firstPerson }];
    }, []);
  });
}
