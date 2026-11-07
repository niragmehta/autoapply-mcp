import type { Db } from "../db/database.js";
import { getApplication, listOutcomes } from "../db/repositories/applications.js";
import { appendEvent } from "../db/repositories/events.js";
import { withTransaction } from "../db/repositories/followups.js";
import {
  getInboxMessage,
  getInboxMessageByMessageId,
  insertInboxMessage,
  listInboxMessages,
  updateInboxMessage,
  type InboxMessageRecord,
  type InboxStatus,
} from "../db/repositories/inbox.js";
import { getJob } from "../db/repositories/jobs.js";
import type { OutcomeKind } from "../domain/policies/followup.js";
import { parseOutcomeKind, recordApplicationOutcome } from "../followup/outcomes.js";
import { advancesApplication, summarizeOutcomes } from "../followup/stages.js";
import { redact } from "../text/redact.js";
import { AppError } from "../util/errors.js";
import { newId, nowIso } from "../util/hash.js";
import { analyzeReply, type DecisionContext, type IncomingReply, type ReplyAction, type ReplyAnalysis } from "./analysis.js";
import type { ApplicationIndex } from "./companies.js";
import { makeSnippet } from "./mime.js";

/**
 * Turns analysed replies into stored proposals and recorded outcomes, and
 * carries a person's review decisions back to the outcome history.
 */

export type ProcessedReply = {
  replyId: string | null;
  duplicate: boolean;
  action: ReplyAction;
  kind: string;
  applicationId: string | null;
  company: string | null;
  title: string | null;
  receivedAt: string;
  from: string;
  subject: string;
  classConfidence: number;
  matchConfidence: number;
  reasons: string[];
};

export function applicationContext(db: Db): (applicationId: string) => DecisionContext["application"] {
  return (applicationId) => {
    const application = getApplication(db, applicationId);
    return application ? { status: application.status, history: listOutcomes(db, applicationId) } : null;
  };
}

function snippetFor(reply: IncomingReply, analysis: ReplyAnalysis): string {
  return analysis.classification.sensitive ? "[withheld: carries a sign-in or verification code]" : redact(makeSnippet(reply.text));
}

function toRecord(reply: IncomingReply, analysis: ReplyAnalysis, status: InboxStatus): InboxMessageRecord {
  const { classification, match, decision } = analysis;
  return {
    id: newId("reply"),
    messageId: reply.messageId,
    mailbox: reply.mailbox,
    uid: reply.uid,
    receivedAt: reply.receivedAt.toISOString(),
    fromAddress: reply.fromAddress.toLowerCase(),
    fromName: reply.fromName,
    subject: reply.subject.slice(0, 300),
    snippet: snippetFor(reply, analysis),
    matchedApplicationId: match.applicationId,
    matchConfidence: match.confidence,
    classification: classification.kind,
    classConfidence: classification.confidence,
    evidence: {
      filter: reply.filterReason,
      classifier: { evidence: classification.evidence, scores: classification.scores },
      match: { ambiguous: match.ambiguous, reason: match.reason, candidates: match.candidates },
      decision: { action: decision.action, reasons: decision.reasons },
      ...(analysis.injectionFlags.length > 0 ? { injectionFlags: analysis.injectionFlags } : {}),
    },
    status,
    processedAt: status === "new" ? null : nowIso(),
    createdAt: nowIso(),
  };
}

function outcomeDetail(reply: IncomingReply, analysis: ReplyAnalysis, how: string): string {
  const phrase = analysis.classification.evidence[0];
  return [
    `Reply "${reply.subject.slice(0, 120)}" from ${reply.fromAddress.split("@").pop() ?? "unknown sender"}`,
    `received ${reply.receivedAt.toISOString().slice(0, 16).replace("T", " ")} UTC`,
    `(${how}; classifier ${analysis.classification.confidence}${phrase ? `: "${phrase}"` : ""}; match ${analysis.match.confidence})`,
  ].join(" ");
}

function describe(db: Db, applicationId: string | null): { company: string | null; title: string | null } {
  if (!applicationId) return { company: null, title: null };
  const application = getApplication(db, applicationId);
  const job = application ? getJob(db, application.jobId) : null;
  return { company: job?.companyName ?? null, title: job?.title ?? null };
}

function summary(
  db: Db,
  reply: IncomingReply,
  analysis: ReplyAnalysis,
  replyId: string | null,
  duplicate: boolean,
): ProcessedReply {
  return {
    replyId,
    duplicate,
    action: analysis.decision.action,
    kind: analysis.classification.kind,
    applicationId: analysis.match.applicationId,
    ...describe(db, analysis.match.applicationId),
    receivedAt: reply.receivedAt.toISOString(),
    from: reply.fromName ? `${reply.fromName} <${reply.fromAddress}>` : reply.fromAddress,
    subject: reply.subject,
    classConfidence: analysis.classification.confidence,
    matchConfidence: analysis.match.confidence,
    reasons: analysis.decision.reasons,
  };
}

export type ProcessOptions = {
  autoRecord: readonly OutcomeKind[];
  allowAutoRecord: boolean;
  dryRun?: boolean;
  namedApplicationId?: string;
};

/**
 * Analyses one reply and, unless this is a dry run, stores it and records the
 * outcome it carries when policy allows. Analysis, insert and outcome happen
 * in one write transaction, so a reply is never recorded twice, never stored
 * without its outcome, and never judged against a history another process is
 * changing at the same moment.
 */
export function processReply(db: Db, reply: IncomingReply, index: ApplicationIndex, options: ProcessOptions): ProcessedReply {
  const analyze = (): ReplyAnalysis =>
    analyzeReply(reply, index, {
      applicationContext: applicationContext(db),
      autoRecord: options.autoRecord,
      allowAutoRecord: options.allowAutoRecord,
      namedApplicationId: options.namedApplicationId,
    });
  if (options.dryRun) {
    const existing = getInboxMessageByMessageId(db, reply.messageId);
    return summary(db, reply, analyze(), existing?.id ?? null, existing !== null);
  }
  return withTransaction(db, () => {
    const analysis = analyze();
    const existing = getInboxMessageByMessageId(db, reply.messageId);
    if (existing) return summary(db, reply, analysis, existing.id, true);
    const { decision } = analysis;
    const status: InboxStatus = decision.action === "record" ? "recorded" : decision.action === "propose" ? "proposed" : "dismissed";
    const record = toRecord(reply, analysis, status);
    insertInboxMessage(db, record);
    if (decision.action === "record" && decision.applicationId) {
      recordApplicationOutcome(db, {
        applicationId: decision.applicationId,
        kind: decision.kind,
        detail: outcomeDetail(reply, analysis, "auto-recorded"),
        event: "outcome.auto_recorded",
        payload: {
          replyId: record.id,
          classConfidence: analysis.classification.confidence,
          matchConfidence: analysis.match.confidence,
        },
      });
    }
    return summary(db, reply, analysis, record.id, false);
  });
}

export type ReplyView = {
  replyId: string;
  status: InboxStatus;
  receivedAt: string;
  from: string;
  subject: string;
  snippet: string;
  classification: { kind: string; confidence: number; evidence: unknown };
  match: {
    applicationId: string | null;
    company: string | null;
    title: string | null;
    confidence: number;
    ambiguous: boolean;
    candidates: unknown;
  };
  reasons: unknown;
  injectionFlags: unknown;
};

function toView(db: Db, message: InboxMessageRecord): ReplyView {
  const evidence = message.evidence as {
    classifier?: { evidence?: unknown };
    match?: { ambiguous?: boolean; candidates?: unknown };
    decision?: { reasons?: unknown };
    injectionFlags?: unknown;
  };
  return {
    replyId: message.id,
    status: message.status,
    receivedAt: message.receivedAt,
    from: message.fromName ? `${message.fromName} <${message.fromAddress}>` : message.fromAddress,
    subject: message.subject,
    snippet: message.snippet,
    classification: { kind: message.classification, confidence: message.classConfidence, evidence: evidence.classifier?.evidence ?? [] },
    match: {
      applicationId: message.matchedApplicationId,
      ...describe(db, message.matchedApplicationId),
      confidence: message.matchConfidence,
      ambiguous: evidence.match?.ambiguous === true,
      candidates: evidence.match?.candidates ?? [],
    },
    reasons: evidence.decision?.reasons ?? [],
    injectionFlags: evidence.injectionFlags ?? [],
  };
}

/** Replies awaiting review (status "proposed" by default), newest first. */
export function reviewReplies(db: Db, filter: { status?: InboxStatus; limit?: number } = {}): ReplyView[] {
  return listInboxMessages(db, { status: filter.status ?? "proposed", limit: filter.limit ?? 50 }).map((message) =>
    toView(db, message),
  );
}

export function getReplyView(db: Db, replyId: string): ReplyView | null {
  const message = getInboxMessage(db, replyId);
  return message ? toView(db, message) : null;
}

function requireReply(db: Db, replyId: string): InboxMessageRecord {
  const message = getInboxMessage(db, replyId);
  if (!message) throw new AppError("reply_not_found", `no reply ${replyId}`);
  return message;
}

export type ConfirmedReply = {
  replyId: string;
  applicationId: string;
  kind: OutcomeKind;
  history: Array<{ status: string; notedAt: string; detail: string }>;
  warning?: string;
};

/**
 * Records the outcome a reply carries, as a person decided it. `kind` and
 * `applicationId` override the classifier and matcher; one of each must be
 * known. A person may record anything, but is told when it changes nothing.
 */
export function confirmReply(db: Db, replyId: string, kind?: string, applicationId?: string): ConfirmedReply {
  return withTransaction(db, () => {
    const message = requireReply(db, replyId);
    if (message.status === "recorded") throw new AppError("reply_already_recorded", `reply ${replyId} was already recorded`);
    const chosenKind = kind ?? message.classification;
    if (chosenKind === "noise" || chosenKind === "unknown") {
      throw new AppError("reply_kind_required", `reply ${replyId} was classified as ${chosenKind}; pass the outcome kind to record`);
    }
    const outcome = parseOutcomeKind(chosenKind);
    const target = applicationId ?? message.matchedApplicationId;
    if (!target) throw new AppError("reply_unmatched", `reply ${replyId} matches no single application; pass applicationId`);
    const advance = advancesApplication(outcome, summarizeOutcomes(listOutcomes(db, target)));
    const recorded = recordApplicationOutcome(db, {
      applicationId: target,
      kind: outcome,
      detail: `Reply "${message.subject.slice(0, 120)}" from ${message.fromAddress.split("@").pop() ?? "unknown sender"} received ${message.receivedAt.slice(0, 10)} (confirmed by a person)`,
      payload: { source: "reply", replyId },
    });
    updateInboxMessage(db, replyId, {
      status: "recorded",
      matchedApplicationId: target,
      matchConfidence: applicationId ? 1 : message.matchConfidence,
      classification: outcome,
    });
    const warning = advance.advances ? undefined : `recorded, but it does not move the application on: ${advance.reason}`;
    return { replyId, applicationId: target, kind: outcome, history: recorded.history, ...(warning ? { warning } : {}) };
  });
}

export function dismissReply(db: Db, replyId: string): { replyId: string; status: InboxStatus } {
  const message = requireReply(db, replyId);
  if (message.status === "recorded") {
    throw new AppError("reply_already_recorded", `reply ${replyId} was already recorded; record a correcting outcome instead`);
  }
  updateInboxMessage(db, replyId, { status: "dismissed" });
  appendEvent(db, "inbox.reply_dismissed", replyId, { classification: message.classification });
  return { replyId, status: "dismissed" };
}
