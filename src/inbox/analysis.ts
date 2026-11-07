import { OutcomeKindSchema, type OutcomeKind } from "../domain/policies/followup.js";
import { advancesApplication, summarizeOutcomes, type OutcomeEntry } from "../followup/stages.js";
import { detectInjection } from "../text/untrusted.js";
import { classifyReply, REPLY_KINDS, type Classification, type ReplyKind } from "./classify.js";
import type { ApplicationIndex } from "./companies.js";
import { matchNamedApplication, matchReply, type MatchResult } from "./match.js";

/**
 * What to do with one reply: record it, propose it to a person, or set it
 * aside as noise. Pure: storage and recording happen in process.ts.
 */

/** Below these, a reply is proposed for a person to confirm rather than recorded. */
const AUTO_RECORD_MIN_CLASS_CONFIDENCE = 0.85;
const AUTO_RECORD_MIN_MATCH_CONFIDENCE = 0.8;

/** A reply in memory. `text` is the decoded body and is never stored. */
export type IncomingReply = {
  messageId: string;
  mailbox: string;
  uid: number | null;
  receivedAt: Date;
  fromAddress: string;
  fromName: string;
  replyTo: readonly string[];
  subject: string;
  text: string;
  /** Why the envelope was let through, or "pasted". */
  filterReason: string;
};

export type ReplyAction = "record" | "propose" | "dismiss";

type ReplyDecision = {
  action: ReplyAction;
  kind: ReplyKind;
  applicationId: string | null;
  reasons: string[];
};

export type ReplyAnalysis = {
  classification: Classification;
  match: MatchResult;
  decision: ReplyDecision;
  injectionFlags: string[];
};

export type DecisionContext = {
  /** Status and outcome history of the matched application, when there is one. */
  application: { status: string; history: readonly OutcomeEntry[] } | null;
  autoRecord: readonly OutcomeKind[];
  /** Pasted replies are always confirmed by a person. */
  allowAutoRecord: boolean;
  /** Prompt-injection patterns found in the message: a person looks at those. */
  injectionFlags?: readonly string[];
};

/** Reply kinds that are also outcomes an application can record. */
const OUTCOME_REPLY_KINDS: readonly ReplyKind[] = REPLY_KINDS.filter((kind) => OutcomeKindSchema.safeParse(kind).success);

function isOutcomeReplyKind(kind: string): kind is OutcomeKind {
  return (OUTCOME_REPLY_KINDS as readonly string[]).includes(kind);
}

function decideReply(classification: Classification, match: MatchResult, context: DecisionContext): ReplyDecision {
  const base = { kind: classification.kind, applicationId: match.applicationId };
  if (classification.kind === "noise") {
    return { ...base, action: "dismiss", reasons: [`classified as noise (${classification.evidence.join("; ") || "no reply wording"})`] };
  }
  if (!isOutcomeReplyKind(classification.kind)) {
    return { ...base, action: "propose", reasons: ["could not tell what kind of reply this is"] };
  }
  const kind = classification.kind;
  const summary = summarizeOutcomes(context.application?.history ?? []);
  // An acknowledgement carries no decision. Once the application has one, or has
  // moved past it, another is set aside rather than queued for review.
  if (kind === "acknowledged" && context.application && (summary.furthestRank >= 1 || summary.terminal)) {
    return {
      ...base,
      action: "dismiss",
      reasons: [`acknowledgement after the application reached ${summary.furthestStage ?? summary.terminal}; nothing to record`],
    };
  }
  const reasons: string[] = [];
  if (!context.allowAutoRecord) reasons.push("pasted replies are confirmed by a person");
  if ((context.injectionFlags ?? []).length > 0) reasons.push("the message contains instruction-like text");
  if (!context.autoRecord.includes(kind)) reasons.push(`${kind} is not in inbox.autoRecord`);
  if (classification.confidence < AUTO_RECORD_MIN_CLASS_CONFIDENCE) {
    reasons.push(`classifier confidence ${classification.confidence} is below ${AUTO_RECORD_MIN_CLASS_CONFIDENCE}`);
  }
  if (!match.applicationId) {
    reasons.push(match.ambiguous ? "more than one application matches" : "no application matched");
  } else if (!context.application) {
    reasons.push(`application ${match.applicationId} no longer exists`);
  } else if (match.confidence < AUTO_RECORD_MIN_MATCH_CONFIDENCE) {
    reasons.push(`match confidence ${match.confidence} is below ${AUTO_RECORD_MIN_MATCH_CONFIDENCE}`);
  }
  if (context.application && context.application.status !== "submitted") {
    reasons.push(`application is ${context.application.status}, not submitted`);
  }
  const advance = advancesApplication(kind, summary);
  if (!advance.advances) reasons.push(advance.reason);
  if (reasons.length > 0) return { ...base, action: "propose", reasons };
  return { ...base, action: "record", reasons: [advance.reason] };
}

export function analyzeReply(
  reply: IncomingReply,
  index: ApplicationIndex,
  options: {
    applicationContext: (applicationId: string) => DecisionContext["application"];
    autoRecord: readonly OutcomeKind[];
    allowAutoRecord: boolean;
    namedApplicationId?: string;
  },
): ReplyAnalysis {
  const classification = classifyReply({ subject: reply.subject, body: reply.text });
  const input = {
    fromAddress: reply.fromAddress,
    fromName: reply.fromName,
    replyTo: reply.replyTo,
    subject: reply.subject,
    body: reply.text,
    receivedAt: reply.receivedAt,
  };
  const match = options.namedApplicationId
    ? matchNamedApplication(options.namedApplicationId, input, index)
    : matchReply(input, index);
  const application = match.applicationId ? options.applicationContext(match.applicationId) : null;
  const injectionFlags = detectInjection(`${reply.subject}\n${reply.text}`).map((flag) => flag.pattern);
  const decision = decideReply(classification, match, {
    application,
    autoRecord: options.autoRecord,
    allowAutoRecord: options.allowAutoRecord,
    injectionFlags,
  });
  return { classification, match, decision, injectionFlags };
}
