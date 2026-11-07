import { PHRASE_RULES, type PhraseRule, type ScoredKind } from "./rules.js";

/**
 * Deterministic reply classifier.
 *
 * Every verdict carries the phrases that produced it, so a person reviewing a
 * proposal can see why, and a confidence that only reaches the auto-record
 * threshold when the wording is explicit and nothing in the message argues
 * the other way.
 */

export const REPLY_KINDS = [
  "acknowledged",
  "recruiter_screen",
  "assessment",
  "interview",
  "offer",
  "rejected",
  "withdrawn",
  "noise",
  "unknown",
] as const;
export type ReplyKind = (typeof REPLY_KINDS)[number];

export type Classification = {
  kind: ReplyKind;
  confidence: number;
  /** The phrases that decided the kind, strongest first. */
  evidence: string[];
  /** Combined evidence per kind, for transparency. */
  scores: Partial<Record<ScoredKind, number>>;
  /** The message carries a credential such as a one-time code; its text must not be kept. */
  sensitive: boolean;
};

export type ReplyText = { subject?: string; body?: string };

/** Lower case, straight quotes, single spaces: the form every rule is written against. */
export function normalizeReplyText(text: string): string {
  return text
    .replace(/[\u2018\u2019\u02bc\u2032]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/[\u00a0\u2007\u202f]/g, " ")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

const NEGATION = /(?:\b(?:not|no longer|unable|never|cannot)\b|n't\b)/;
const CLAUSE_BREAK = /[.!?;,:\n]/g;

/** Whether the clause leading up to `index` negates what follows. */
function negated(text: string, index: number): boolean {
  const before = text.slice(Math.max(0, index - 80), index);
  let clauseStart = 0;
  for (const match of before.matchAll(CLAUSE_BREAK)) clauseStart = (match.index ?? 0) + 1;
  return NEGATION.test(before.slice(clauseStart));
}

function firstMatch(rule: PhraseRule, text: string): string | null {
  rule.pattern.lastIndex = 0;
  for (const match of text.matchAll(rule.pattern)) {
    if (rule.guardNegation && negated(text, match.index ?? 0)) continue;
    return match[0].trim();
  }
  return null;
}

type Hit = { rule: PhraseRule; phrase: string };

const PRECEDENCE: readonly ScoredKind[] = [
  "rejected",
  "offer",
  "interview",
  "assessment",
  "recruiter_screen",
  "withdrawn",
  "acknowledged",
  "noise",
];

const POSITIVE: readonly ScoredKind[] = ["offer", "interview", "assessment", "recruiter_screen"];

/** Kinds whose presence makes a verdict less certain. Acknowledgement wording conflicts with nothing: rejections and invitations both open with thanks. */
const CONFLICTS: Record<ScoredKind, readonly ScoredKind[]> = {
  rejected: POSITIVE,
  offer: ["rejected", "noise", "withdrawn"],
  interview: ["rejected", "noise", "withdrawn"],
  assessment: ["rejected", "noise", "withdrawn"],
  recruiter_screen: ["rejected", "noise", "withdrawn"],
  withdrawn: ["rejected", ...POSITIVE],
  acknowledged: ["rejected", "noise", "withdrawn"],
  noise: ["rejected", "offer", "interview", "assessment", "recruiter_screen", "withdrawn", "acknowledged"],
};

/** A kind needs this much combined evidence to be considered at all. */
const MIN_SIGNAL = 0.3;
/** Evidence this strong for a rejection or offer decides the message on its own. */
const DECISIVE = 0.6;
/** Conflicting evidence below this is a stray word, not a counter-argument. */
const CONFLICT_FLOOR = 0.45;
/** A later kind in PRECEDENCE must beat an earlier one by more than this. */
const TIE_MARGIN = 0.05;

const round2 = (value: number): number => Math.round(value * 100) / 100;

/** Independent cues combine as 1 - prod(1 - w): more cues, more certainty, never quite 1. */
function combine(hits: readonly Hit[]): Partial<Record<ScoredKind, number>> {
  const remaining = new Map<ScoredKind, number>();
  for (const { rule } of hits) remaining.set(rule.kind, (remaining.get(rule.kind) ?? 1) * (1 - rule.weight));
  return Object.fromEntries([...remaining].map(([kind, rest]) => [kind, round2(1 - rest)]));
}

function pick(scores: Partial<Record<ScoredKind, number>>): ScoredKind | null {
  const score = (kind: ScoredKind): number => scores[kind] ?? 0;
  if (score("rejected") >= DECISIVE) return "rejected";
  const strongestOther = Math.max(...PRECEDENCE.filter((kind) => kind !== "noise").map(score));
  if (score("noise") >= DECISIVE && score("noise") >= strongestOther) return "noise";
  if (score("offer") >= DECISIVE) return "offer";
  let best: ScoredKind | null = null;
  for (const kind of PRECEDENCE) {
    if (score(kind) < MIN_SIGNAL) continue;
    if (best === null || score(kind) > score(best) + TIE_MARGIN) best = kind;
  }
  return best;
}

export function classifyReply(input: ReplyText): Classification {
  const text = normalizeReplyText(`${input.subject ?? ""}\n${input.body ?? ""}`);
  const hits: Hit[] = PHRASE_RULES.flatMap((rule) => {
    const phrase = firstMatch(rule, text);
    return phrase ? [{ rule, phrase }] : [];
  });
  const scores = combine(hits);
  const sensitive = hits.some((hit) => hit.rule.sensitive === true);
  const kind = pick(scores);
  if (!kind) return { kind: "unknown", confidence: 0, evidence: [], scores, sensitive };
  const conflict = Math.max(0, ...CONFLICTS[kind].map((other) => scores[other] ?? 0).filter((value) => value >= CONFLICT_FLOOR));
  const evidence = hits
    .filter((hit) => hit.rule.kind === kind)
    .sort((a, b) => b.rule.weight - a.rule.weight)
    .map((hit) => hit.phrase.slice(0, 80));
  return {
    kind,
    confidence: round2((scores[kind] ?? 0) * (1 - 0.5 * conflict)),
    evidence: [...new Set(evidence)].slice(0, 6),
    scores,
    sensitive,
  };
}
