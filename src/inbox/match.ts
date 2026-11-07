import {
  employerLabel,
  findCompanyName,
  labelMatchesKey,
  workdaySenderTenant,
  type ApplicationCandidate,
  type ApplicationIndex,
  type CompanyIdentity,
} from "./companies.js";
import { addressDomain, knownSender } from "./senders.js";

/**
 * Matches a reply to the application it answers.
 *
 * The employer's identity (sender domain, Workday tenant, its name in the
 * sender or subject) decides which company; the job title and requisition
 * number decide which of that company's applications. Two applications that
 * score within AMBIGUITY_MARGIN of each other are a tie, and a tie is no
 * match: guessing would record a rejection against the wrong role.
 */

export type MatchInput = {
  fromAddress: string;
  fromName: string;
  replyTo?: readonly string[];
  subject: string;
  body: string;
  receivedAt?: Date | null;
};

export type MatchCandidate = {
  applicationId: string;
  company: string;
  title: string;
  status: string;
  score: number;
  reasons: string[];
};

export type MatchResult = {
  applicationId: string | null;
  confidence: number;
  ambiguous: boolean;
  /** Best candidates first, at most three. */
  candidates: MatchCandidate[];
  reason: string;
};

export const MATCH_MIN_SCORE = 0.5;
export const AMBIGUITY_MARGIN = 0.1;
/** A reply dated more than this before the application went out cannot be about it. */
const EARLIEST_REPLY_SLACK_MS = 24 * 60 * 60 * 1000;

const round2 = (value: number): number => Math.round(value * 100) / 100;

type Signal = { score: number; reasons: string[] };

/** Everything about a message that does not depend on the company, worked out once per message. */
type TextContext = {
  raw: string;
  joined: string;
  words: ReadonlySet<string>;
  header: string;
  headerLower: string;
  bodyLower: string;
  senders: ReadonlyArray<{ domain: string; label: string; tenant: string }>;
  /** The ATS a known sender belongs to, for corroborating the application's channel. */
  senderAts: string | undefined;
  /** Whether any sender is an applicant tracking system. */
  atsSender: boolean;
};

function textContext(input: MatchInput): TextContext {
  const raw = `${input.subject}\n${input.body}`;
  const words = tokens(raw);
  const header = `${input.fromName}\n${input.subject}`;
  const addresses = [input.fromAddress, ...(input.replyTo ?? [])];
  return {
    raw,
    joined: ` ${words.join(" ")} `,
    words: new Set(words),
    header,
    headerLower: header.toLowerCase(),
    bodyLower: input.body.toLowerCase(),
    senders: addresses.map((address) => ({
      domain: addressDomain(address),
      label: employerLabel(address),
      tenant: workdaySenderTenant(address),
    })),
    senderAts: addresses.map((address) => knownSender(address)?.ats).find((ats) => ats !== undefined),
    atsSender: addresses.some((address) => knownSender(address)?.kind === "ats"),
  };
}

function companySignal(company: CompanyIdentity, input: MatchInput, context: TextContext): Signal {
  const reasons: string[] = [];
  const kinds = new Set<string>();
  let best = 0;
  const note = (kind: string, weight: number, reason: string): void => {
    kinds.add(kind);
    best = Math.max(best, weight);
    reasons.push(reason);
  };
  for (const sender of context.senders) {
    if (sender.label && [...company.keys].some((key) => labelMatchesKey(sender.label, key))) {
      note("sender", 0.6, `sender domain ${sender.domain}`);
    }
    if (sender.tenant && company.tenants.has(sender.tenant)) note("sender", 0.6, `Workday tenant ${sender.tenant}`);
  }
  const inHeader = findCompanyName(context.header, company, false, context.headerLower);
  if (inHeader) {
    note("header", inHeader.form === "full" ? 0.5 : 0.4, `"${inHeader.matched}" in sender or subject`);
    // An applicant tracking system writing in the employer's name is the employer's own channel.
    if (context.atsSender) kinds.add("ats-sender");
  }
  const inBody = findCompanyName(input.body, company, true, context.bodyLower);
  if (inBody) note("body", inBody.form === "full" ? 0.3 : 0.2, `"${inBody.matched}" in body`);
  if (best === 0) return { score: 0, reasons };
  return { score: best + (kinds.size >= 2 ? 0.1 : 0), reasons: [...new Set(reasons)] };
}

const TITLE_STOP_WORDS = new Set([
  "and", "or", "of", "the", "for", "with", "at", "in", "to", "a", "an", "on", "us", "usa", "remote", "hybrid", "onsite",
]);

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[^a-z0-9+#]+/)
    .filter((token) => token.length > 0);
}

function significant(words: readonly string[]): string[] {
  return words.filter((word) => !TITLE_STOP_WORDS.has(word));
}

/** The title, then the title without its location suffix or team qualifier. */
function titleVariants(title: string): string[][] {
  const withoutParens = title.replace(/\([^)]*\)/g, " ");
  const main = withoutParens.split(/\s+[-|\u2013\u2014]\s+|,/)[0] ?? withoutParens;
  return [title, withoutParens, main].map((variant) => significant(tokens(variant))).filter((words) => words.length >= 2);
}

function titleSignal(title: string, joinedText: string, wordSet: ReadonlySet<string>): Signal {
  const variants = titleVariants(title);
  if (variants.some((words) => joinedText.includes(` ${words.join(" ")} `))) {
    return { score: 0.3, reasons: [`title "${title}" named`] };
  }
  const words = [...new Set(significant(tokens(title)))];
  if (words.length === 0) return { score: 0, reasons: [] };
  const coverage = words.filter((word) => wordSet.has(word)).length / words.length;
  if (coverage < 0.5) return { score: 0, reasons: [] };
  return { score: 0.25 * coverage * coverage, reasons: [`${Math.round(coverage * 100)}% of title words present`] };
}

/** Requisition numbers an employer quotes back: `2012996` from a Workday URL, `JR-10432`, `R123456`. */
function requisitionIds(application: ApplicationCandidate): string[] {
  const lastSegment = application.url.split(/[?#]/)[0]?.split("/").filter((part) => part.length > 0).pop() ?? "";
  return [...new Set([application.externalId, lastSegment].flatMap((source) => source.split(/[/_\s?#=&]+/)))].filter(
    (token) => /^[A-Za-z]{1,4}-?\d{4,}$/.test(token) || /^\d{6,}$/.test(token),
  );
}

function requisitionSignal(application: ApplicationCandidate, text: string): Signal {
  for (const id of requisitionIds(application)) {
    const pattern = new RegExp(`(?<![A-Za-z0-9])${id.replace(/[-]/g, "-?")}(?![A-Za-z0-9])`, "i");
    if (pattern.test(text)) return { score: 0.25, reasons: [`requisition ${id} quoted`] };
  }
  return { score: 0, reasons: [] };
}

function repliedBeforeApplying(application: ApplicationCandidate, receivedAt: Date | null | undefined): boolean {
  if (!receivedAt) return false;
  const reference = Date.parse(application.submittedAt ?? application.createdAt);
  return Number.isFinite(reference) && receivedAt.getTime() < reference - EARLIEST_REPLY_SLACK_MS;
}

function scoreCompany(company: CompanyIdentity, input: MatchInput, context: TextContext): RankedCandidate[] {
  const signal = companySignal(company, input, context);
  if (signal.score === 0) return [];
  const eligible = company.applications.filter((application) => !repliedBeforeApplying(application, input.receivedAt));
  const sole = eligible.length === 1 && signal.score >= MATCH_MIN_SCORE;
  const senderAts = context.senderAts;
  return eligible.map((application) => {
    const title = titleSignal(application.title, context.joined, context.words);
    const requisition = requisitionSignal(application, context.raw);
    const reasons = [...signal.reasons, ...title.reasons, ...requisition.reasons];
    let score = signal.score + title.score + requisition.score;
    if (sole) {
      score += 0.15;
      reasons.push(`only application at ${company.name}`);
    }
    if (senderAts && senderAts === application.ats) {
      score += 0.05;
      reasons.push(`sent through ${application.ats}`);
    }
    score += application.status === "submitted" ? 0.05 : -0.1;
    return {
      applicationId: application.applicationId,
      company: application.companyName,
      title: application.title,
      status: application.status,
      score: round2(Math.min(1, Math.max(0, score))),
      raw: score,
      reasons,
    };
  });
}

/** Ranked by the uncapped score: two candidates can both be certain of the company and still differ on the role. */
type RankedCandidate = MatchCandidate & { raw: number };

export function matchReply(input: MatchInput, index: ApplicationIndex): MatchResult {
  const context = textContext(input);
  const ranked = [...index.companies.values()]
    .flatMap((company) => scoreCompany(company, input, context))
    .sort((a, b) => b.raw - a.raw || a.applicationId.localeCompare(b.applicationId));
  const candidates: MatchCandidate[] = ranked.slice(0, 3).map(({ raw: _raw, ...entry }) => entry);
  const [best, second] = ranked;
  if (!best || best.raw < MATCH_MIN_SCORE) {
    return { applicationId: null, confidence: best?.score ?? 0, ambiguous: false, candidates, reason: "no application matched" };
  }
  if (second && round2(best.raw - second.raw) < AMBIGUITY_MARGIN) {
    return {
      applicationId: null,
      confidence: best.score,
      ambiguous: true,
      candidates,
      reason: `ambiguous: ${best.company} - ${best.title} and ${second.company} - ${second.title} score within ${AMBIGUITY_MARGIN}`,
    };
  }
  return { applicationId: best.applicationId, confidence: best.score, ambiguous: false, candidates, reason: best.reasons.join("; ") };
}

/** Matches against one application the caller named, keeping the evidence for the record. */
export function matchNamedApplication(applicationId: string, input: MatchInput, index: ApplicationIndex): MatchResult {
  const scored = matchReply(input, index).candidates.find((candidate) => candidate.applicationId === applicationId);
  return {
    applicationId,
    confidence: 1,
    ambiguous: false,
    candidates: scored ? [scored] : [],
    reason: "application named by the person who supplied the reply",
  };
}
