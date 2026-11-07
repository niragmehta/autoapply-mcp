import { readJdLines, splitSentences, type SectionKind } from "../text/jobDescription.js";

/**
 * Requirement items and their importance in this posting.
 *
 * Importance measures how much a requirement matters to the employer, never how
 * well the candidate meets it, so it is read from the description alone.
 * Each item records where its weight came from:
 *
 * - `jd-wording`: the item itself says so ("must", "required", "preferred",
 *   "a plus").
 * - `structure`: the section it sits under ("Requirements" vs "Nice to have").
 * - `estimate`: neither; the item was recognised as a requirement by its
 *   phrasing alone.
 *
 * An estimate is never "required" (career-ops' rule): only the posting's own
 * words or structure can create a hard requirement, never a guess.
 */

export type Importance = "required" | "preferred" | "bonus";
export type WeightSource = "jd-wording" | "structure" | "estimate";

export type RequirementItem = {
  id: string;
  text: string;
  section: SectionKind;
  heading: string | null;
  importance: Importance;
  weightSource: WeightSource;
  /** The verbatim cue or heading the importance rests on; null for an estimate. */
  signal: string | null;
};

type ParsedRequirements = {
  items: RequirementItem[];
  responsibilities: string[];
  sections: Array<{ kind: SectionKind; heading: string }>;
  /** Items dropped by the item budget, lowest importance first. */
  truncated: number;
};

const BONUS_CUE = /\b(?:nice[- ]to[- ]haves?|bonus(?: points)?|(?:is |are |a )plus\b|extra credit|great if|advantageous|not required|would be (?:great|nice|helpful))/i;
const PREFERRED_CUE = /\b(?:prefer(?:red|ably|ence)?|desired|desirable|ideally|ideal candidates? (?:will )?(?:have|has))\b/i;
const REQUIRED_CUE = /\b(?:must|required|requirement|mandatory|essential|minimum(?: of)?|at least|need to have)\b/i;
const BONUS_HEADING = /\b(?:nice[- ]to[- ]haves?|bonus|plus(?:es)?|extra credit|great[- ]to[- ]have|good[- ]to[- ]have|stand out|even better)\b/i;

/** Phrasing that marks a sentence as a qualification even outside a requirements section. */
const REQUIREMENT_PHRASING =
  /\b(?:experience (?:with|in|building|designing|developing|leading|working)|proficien(?:t|cy)|knowledge of|familiar(?:ity)? with|\d+\+? years|degree in|background in|expertise (?:in|with)|you have|you bring|you(?:'ve| have) (?:built|led|shipped)|ability to|comfortable (?:with|working)|hands-on|track record|fluency in|certification)\b/i;

const DEFAULT_MAX_ITEMS = 40;

function firstCue(text: string): { importance: Importance; cue: string } | null {
  const found = [
    { importance: "bonus" as const, match: BONUS_CUE.exec(text) },
    { importance: "preferred" as const, match: PREFERRED_CUE.exec(text) },
    { importance: "required" as const, match: REQUIRED_CUE.exec(text) },
  ]
    .filter((entry) => entry.match !== null)
    .sort((a, b) => (a.match!.index ?? 0) - (b.match!.index ?? 0));
  const earliest = found[0];
  return earliest ? { importance: earliest.importance, cue: earliest.match![0] } : null;
}

function weigh(text: string, section: SectionKind, heading: string | null): Pick<RequirementItem, "importance" | "weightSource" | "signal"> {
  const cue = firstCue(text);
  if (cue) return { importance: cue.importance, weightSource: "jd-wording", signal: cue.cue };
  if (section === "requirements") return { importance: "required", weightSource: "structure", signal: heading ?? "requirements section" };
  if (section === "preferred") {
    const bonus = heading !== null && BONUS_HEADING.test(heading);
    return { importance: bonus ? "bonus" : "preferred", weightSource: "structure", signal: heading ?? "preferred section" };
  }
  return { importance: "preferred", weightSource: "estimate", signal: null };
}

function clean(text: string): string {
  return text.replace(/\s+/g, " ").replace(/^[\s:;,-]+/, "").trim().slice(0, 300);
}

function units(line: { text: string; bullet: boolean }): string[] {
  const parts = line.bullet ? [line.text] : splitSentences(line.text);
  return parts.map(clean).filter((part) => part.split(" ").length >= 3);
}

const RANK: Readonly<Record<Importance, number>> = { required: 0, preferred: 1, bonus: 2 };

/** Splits a description into requirement items, responsibilities and the sections found. */
export function extractRequirements(text: string, options: { maxItems?: number } = {}): ParsedRequirements {
  const lines = readJdLines(text);
  const sections = lines
    .filter((line) => line.heading && !line.subheading)
    .map((line) => ({ kind: line.section, heading: line.headingText ?? line.text }));
  const hasRequirementSection = lines.some((line) => !line.heading && (line.section === "requirements" || line.section === "preferred"));

  const raw: Array<Omit<RequirementItem, "id">> = [];
  const responsibilities: string[] = [];
  for (const line of lines) {
    if (line.heading) continue;
    if (line.section === "responsibilities") responsibilities.push(...units(line));
    const inRequirements = line.section === "requirements" || line.section === "preferred";
    const fallback = !hasRequirementSection && (line.section === "other" || line.section === "responsibilities");
    if (!inRequirements && !fallback) continue;
    for (const unit of units(line)) {
      if (!inRequirements && !REQUIREMENT_PHRASING.test(unit)) continue;
      raw.push({ text: unit, section: line.section, heading: line.headingText, ...weigh(unit, line.section, line.headingText) });
    }
  }

  const unique = raw.filter((item, index) => raw.findIndex((other) => other.text.toLowerCase() === item.text.toLowerCase()) === index);
  const maxItems = options.maxItems ?? DEFAULT_MAX_ITEMS;
  // Over budget, every required item is kept before any preferred or bonus one.
  const kept = new Set(
    [...unique]
      .map((item, index) => ({ item, index }))
      .sort((a, b) => RANK[a.item.importance] - RANK[b.item.importance] || a.index - b.index)
      .slice(0, maxItems)
      .map((entry) => entry.index),
  );
  const items = unique
    .filter((_item, index) => kept.has(index))
    .map((item, index) => ({ id: `r${index + 1}`, ...item }));

  return { items, responsibilities: [...new Set(responsibilities)].slice(0, 20), sections, truncated: unique.length - items.length };
}
