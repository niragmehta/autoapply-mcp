import { normalizeForMatch } from "./html.js";
import { shortQuote, STOP_WORDS } from "./words.js";

/**
 * A job description's structure: which lines are headings, which section each
 * line sits under, where sentences break, and which lines state what the
 * employer asks for.
 *
 * Section names vary by employer ("Requirements", "What you'll bring", "Basic
 * Qualifications", "You might be a good fit if"), so headings are recognised
 * by pattern, preferred before required because "Preferred Qualifications"
 * holds both words. A heading without a colon must be little more than its
 * heading words, so "Experience with Go" or "Python required" stays content.
 * A short line ending in a colon that names no known section ("Technical:",
 * "Tools we use:") is a sub-heading: it is not content, and the lines under it
 * stay in the enclosing section.
 */

export type SectionKind = "requirements" | "preferred" | "responsibilities" | "about" | "benefits" | "compensation" | "legal" | "other";

type JdLine = {
  text: string;
  bullet: boolean;
  /** A heading or sub-heading: structure, not content. */
  heading: boolean;
  /** A heading that names no section and leaves the current one in place. */
  subheading: boolean;
  section: SectionKind;
  /** The text of the heading that opened the section. */
  headingText: string | null;
};

/** Sections about the employer, the pay or the law rather than the work. */
export const BOILERPLATE_SECTIONS: ReadonlySet<SectionKind> = new Set(["about", "benefits", "compensation", "legal"]);

const HEADING_RULES: ReadonlyArray<readonly [SectionKind, RegExp]> = [
  ["legal", /\b(?:equal (?:employment )?opportunit(?:y|ies)|eeo\b|accommodations?\b|privacy|disclaimer|e-verify|right to work|fraud|how to apply)/i],
  [
    "preferred",
    /\b(?:prefer(?:red|able)?|nice[- ]to[- ]haves?|bonus(?: points)?|pluses|desired|desirable|good[- ]to[- ]haves?|great[- ]to[- ]haves?|extra credit|stand out|even better|would be (?:great|nice)|ideally|it(?:'s| is) a plus)\b/i,
  ],
  [
    "requirements",
    /\b(?:requirements?|qualifications?|what you(?:'ll| will)? (?:need|bring)|must[- ]haves?|who you are|about you|you (?:are|have|bring|should have|might be|may be|could be)|you(?:'ll| will) (?:have|need)|(?:what )?we(?:'re| are) looking for|skills (?:and|&) (?:experience|qualifications)|experience (?:and|&) (?:skills|qualifications)|your (?:background|experience|profile|skills|qualifications)|ideal candidate|required|minimum|basic|essential|knowledge, skills)\b|^(?:(?:technical|key|core|relevant|additional)\s+)?(?:skills|experience)$/i,
  ],
  ["benefits", /\b(?:benefits|perks|what we offer|why you(?:'ll| will) love|total rewards|why join)\b/i],
  ["compensation", /\b(?:compensation|salary|pay (?:range|transparency)|base pay)\b/i],
  [
    "responsibilities",
    /\b(?:responsibilit(?:y|ies)|what you(?:'ll| will) (?:do|be doing|work on|own|achieve)|(?:the|your|this) role|role overview|day[- ]to[- ]day|your (?:impact|mission|work)|key duties|duties|the work|the opportunity|(?:the|this) job|you will|you'll|in this position|what the job involves)\b/i,
  ],
  ["about", /\b(?:about (?:us|the (?:company|team|organi[sz]ation))|who we are|our (?:mission|team|story|company|values|culture)|company overview)\b/i],
];

/** "About Acme Robotics": the employer's name after "About". */
const ABOUT_NAME = /^[Aa]bout\s+\p{Lu}[\p{L}\p{N}&.'-]*(?:\s+(?:\p{Lu}[\p{L}\p{N}&.'-]*|&|and|of|the))*$/u;

const GLOBAL_RULES = new Map(HEADING_RULES.map(([, pattern]) => [pattern, new RegExp(pattern.source, "gi")]));

const BULLET = /^\s*(?:[-*\u2022\u00b7\u25aa\u25e6\u2023\u25cf]|\d{1,2}[.)])(?:\s+|$)/;
const MARKDOWN_HEADING = /^\s*#{1,6}\s+/;
const BOLD_WRAPPER = /^\s*(?:\*\*|__)(.+?)(?:\*\*|__)\s*:?\s*$/;
const ENDS_WITH_COLON = /:\s*(?:\*\*|__)?\s*$/;

/** Heading words removed, what is left: a real heading leaves at most one word ("Key", "Technical"). */
function residue(line: string, pattern: RegExp): number {
  const all = GLOBAL_RULES.get(pattern) ?? pattern;
  return normalizeForMatch(line.replace(all, " "))
    .split(" ")
    .filter((word) => word.length > 1 && !STOP_WORDS.has(word)).length;
}

function headingWords(raw: string): string {
  const bold = BOLD_WRAPPER.exec(raw);
  return (bold?.[1] ?? raw)
    .replace(MARKDOWN_HEADING, "")
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/:\s*$/, "")
    .trim();
}

/** The section a line opens; null for a sub-heading; undefined when the line is not a heading. */
function readHeading(raw: string, bullet: boolean): SectionKind | null | undefined {
  const colon = ENDS_WITH_COLON.test(raw);
  const line = headingWords(raw);
  const wordCount = line.split(/\s+/).length;
  if (line.length === 0 || line.length > 80 || wordCount > 10) return undefined;
  if (!colon && (/[.!?]$/.test(line) || /\d/.test(line) || wordCount > 7)) return undefined;
  const rule = HEADING_RULES.find(([, pattern]) => pattern.test(line));
  if (rule && (colon || residue(line, rule[1]) <= 1)) return rule[0];
  if (ABOUT_NAME.test(line)) return "about";
  return colon && !bullet ? null : undefined;
}

/** The section a heading opens, or null when the line opens none. */
export function classifyHeading(raw: string): SectionKind | null {
  return readHeading(raw, false) ?? null;
}

function cleanHeading(text: string): string {
  return text.replace(/[*_#:]+/g, " ").replace(/\s+/g, " ").trim();
}

/** Lines with their bullet flag, heading flags and the section each falls under. */
export function readJdLines(text: string): JdLine[] {
  const lines: JdLine[] = [];
  let section: SectionKind = "other";
  let headingText: string | null = null;
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const trimmed = raw.trim();
    const bullet = BULLET.test(trimmed);
    const content = trimmed.replace(BULLET, "").trim();
    if (content.length === 0) continue;
    // A bullet is content, except the short "Requirements:" kind some
    // descriptions put in a list of its own.
    const kind = !bullet || ENDS_WITH_COLON.test(content) ? readHeading(content, bullet) : undefined;
    if (kind !== undefined) {
      if (kind !== null) {
        section = kind;
        headingText = cleanHeading(content);
      }
      lines.push({ text: content, bullet, heading: true, subheading: kind === null, section, headingText });
      continue;
    }
    // "Requirements: 5+ years of Python" opens a section and carries content.
    const inline = bullet ? null : /^([^:]{3,60}):\s+(\S.{8,})$/.exec(content);
    const inlineKind = inline ? readHeading(`${inline[1]}:`, false) : undefined;
    if (inline && inlineKind) {
      section = inlineKind;
      headingText = cleanHeading(inline[1] ?? "");
      lines.push({ text: inline[1] ?? "", bullet: false, heading: true, subheading: false, section, headingText });
      lines.push({ text: inline[2] ?? "", bullet: false, heading: false, subheading: false, section, headingText });
      continue;
    }
    lines.push({ text: content, bullet, heading: false, subheading: false, section, headingText });
  }
  return lines;
}

/**
 * Splits a line into sentences. A break needs two word characters before the
 * stop, so "e.g. Python" and "U.S. citizens" stay whole.
 */
export function splitSentences(line: string): string[] {
  return line
    .split(/(?<=\w\w[.!?])\s+(?=[A-Z0-9("'])/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
}

/** The description without headings and boilerplate sections: the text that can name a skill the job needs. */
export function skillBearingText(description: string): string {
  return readJdLines(description)
    .filter((line) => !line.heading && !BOILERPLATE_SECTIONS.has(line.section))
    .map((line) => line.text)
    .join("\n");
}

/** A line the posting states as a requirement or responsibility, with a short quote of it. */
type RequirementLine = { text: string; quote: string; section: SectionKind; bullet: boolean };

const ASK_SECTIONS: ReadonlySet<SectionKind> = new Set(["requirements", "responsibilities", "preferred"]);
/** Wording that makes an unlisted sentence an ask rather than company description. */
const ASK_CUE =
  /\b(?:experience|experienced|proficien\w*|familiar\w*|knowledge|expertise|expert|ability|skills?|background|track record|understanding|hands[- ]on|demonstrated|proven|degree|years?|you have|you will|you'll|you're|we need|need|needs|looking for|seeking|must|should|required|requires?|responsib\w*|own|lead|build|design|develop|implement|drive|deliver|collaborat\w*|partner|mentor|architect|run|operate|manage|maintain|scale)\b/i;
/** Benefits, pay and legal wording that can sit in any section of an unstructured posting. */
const BOILERPLATE_TEXT =
  /\b(?:equal (?:employment )?opportunity|eeo|affirmative action|accommodation|disabilit\w*|veteran|benefits|401\(?k\)?|paid time off|parental leave|health insurance|salary|compensation|pay range|base pay|visa sponsorship|privacy (?:policy|notice)|e-verify|recruitment fraud|cookie)\b/i;
/** Longer "lines" are paragraphs, read sentence by sentence. */
const MAX_LINE = 320;

/**
 * The lines a posting states as requirements or responsibilities: list items
 * under those headings, else any list item outside the boilerplate, else the
 * sentences that read as asks. Benefits and legal text never count, and a
 * repeated line counts once. Returned verbatim: still untrusted content.
 */
export function requirementLines(description: string, options: { limit?: number } = {}): RequirementLine[] {
  const lines = readJdLines(description).filter((line) => !line.heading && !BOILERPLATE_SECTIONS.has(line.section));
  const asked = lines.filter((line) => line.bullet && ASK_SECTIONS.has(line.section));
  const listed = asked.length > 0 ? asked : lines.filter((line) => line.bullet);
  const units =
    listed.length > 0
      ? listed.flatMap((line) => (line.text.length > MAX_LINE ? splitSentences(line.text) : [line.text]).map((text) => ({ line, text })))
      : lines.flatMap((line) =>
          splitSentences(line.text)
            .filter((sentence) => sentence.split(/\s+/).length >= 4 && ASK_CUE.test(sentence))
            .map((text) => ({ line, text })),
        );
  const seen = new Set<string>();
  const chosen = units.filter(({ text }) => {
    const key = text.toLowerCase();
    if (BOILERPLATE_TEXT.test(text) || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return chosen
    .slice(0, options.limit ?? chosen.length)
    .map(({ line, text }) => ({ text, quote: shortQuote(text), section: line.section, bullet: line.bullet }));
}
