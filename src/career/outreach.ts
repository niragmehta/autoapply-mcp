import { existsSync } from "node:fs";
import { z } from "zod";
import { listCompanyNoteRecords } from "../db/repositories/career/companyNotes.js";
import {
  deleteOutreachDraftRecord,
  getOutreachDraft,
  insertOutreachDraftRecord,
  listOutreachDraftRecords,
  setOutreachStatusRecord,
  updateOutreachDraftRecord,
  type OutreachFilter,
} from "../db/repositories/career/outreach.js";
import { listOfferRecords } from "../db/repositories/career/offers.js";
import { listStoryRecords } from "../db/repositories/career/stories.js";
import { appendEvent } from "../db/repositories/events.js";
import { rankFacts } from "../drafting/matchReport.js";
import type { Application, Job } from "../domain/job.js";
import type { Profile } from "../domain/profile.js";
import { extractFigures, profileFigureEvidence, withoutDatesAndTimes, type EvidenceText } from "../text/figures.js";
import { requirementLines } from "../text/jobDescription.js";
import { detectInjection } from "../text/untrusted.js";
import { wordCount } from "../text/words.js";
import { AppError } from "../util/errors.js";
import { newId, nowIso } from "../util/hash.js";
import { requireContact } from "./contacts.js";
import { parseInput, requireApplication, sameCompany, truncateText, type CareerWorkspace } from "./context.js";
import { checkNumbers } from "./factCheck.js";
import { negotiationPlan } from "./negotiation.js";
import { offerComp } from "./offerMath.js";
import {
  CHANNEL_LIMITS,
  CHANNEL_STRUCTURES,
  FILLER_PATTERN,
  JOB_ASK_PATTERN,
  OUTREACH_GUIDELINES,
  PERSONA_STRUCTURES,
  type ChannelLimit,
} from "./outreachRules.js";
import { matchStories } from "./storyMatch.js";
import {
  ACTIVE_OFFER_STATUSES,
  OUTREACH_CHANNELS,
  OUTREACH_STATUSES,
  type Contact,
  type OutreachChannel,
  type OutreachDraft,
  type OutreachStatus,
} from "./types.js";

/**
 * Outreach drafts: LinkedIn notes, messages, application emails, referral
 * requests and follow-ups. The server supplies the facts to cite and the
 * limits; the agent writes; every figure is checked before a draft is
 * stored. Nothing is ever sent from here.
 */

const TargetSchema = z.object({
  applicationId: z.string().trim().min(1).optional(),
  contactId: z.string().trim().min(1).optional(),
  company: z.string().trim().min(1).max(200).optional(),
});

export const OutreachScaffoldSchema = TargetSchema.extend({ channel: z.enum(OUTREACH_CHANNELS) });
type OutreachScaffoldInput = z.input<typeof OutreachScaffoldSchema>;

export const OutreachDraftInputSchema = TargetSchema.extend({
  channel: z.enum(OUTREACH_CHANNELS),
  subject: z.string().trim().max(200).default(""),
  body: z.string().trim().min(1).max(10_000),
});
type OutreachDraftInput = z.input<typeof OutreachDraftInputSchema>;

/** Channels that may be an email, where a signature with the candidate's phone is normal. */
const EMAIL_LIKE: readonly OutreachChannel[] = ["email", "referral_request", "follow_up"];
const TRANSITIONS: Readonly<Record<OutreachStatus, readonly OutreachStatus[]>> = {
  draft: ["sent_by_user", "discarded"],
  discarded: ["draft"],
  sent_by_user: [],
};

type Target = {
  company: string;
  application: Application | null;
  job: Job | null;
  contact: Contact | null;
  warnings: string[];
};

function resolveTarget(workspace: Pick<CareerWorkspace, "db">, input: z.output<typeof TargetSchema>): Target {
  const contact = input.contactId ? requireContact(workspace.db, input.contactId) : null;
  const linked = input.applicationId ? requireApplication(workspace.db, input.applicationId) : null;
  const company = linked?.job.companyName ?? contact?.company ?? input.company;
  if (!company) throw new AppError("invalid_input", "outreach: give applicationId, contactId or company");
  const warnings: string[] = [];
  if (contact && !sameCompany(contact.company, company)) {
    warnings.push(`${contact.name} is recorded at ${contact.company}, not ${company}.`);
  }
  if (input.company && !sameCompany(input.company, company)) {
    warnings.push(`Using ${company} from the application, not "${input.company}".`);
  }
  return { company, application: linked?.application ?? null, job: linked?.job ?? null, contact, warnings };
}

function codePoints(text: string): number {
  return [...text].length;
}

function factsToCite(profile: Profile, job: Job | null) {
  const byId = new Map(profile.facts.map((fact) => [fact.id, fact] as const));
  const ranked = job ? rankFacts(profile.facts, job, 5).map((fact) => fact.id) : [];
  const withFigures = profile.facts
    .filter((fact) => extractFigures([fact.statement, ...fact.metrics].join(" ")).length > 0)
    .map((fact) => fact.id);
  return [...new Set([...ranked, ...withFigures])]
    .slice(0, 6)
    .flatMap((id) => {
      const fact = byId.get(id);
      return fact ? [{ id: fact.id, statement: fact.statement, metrics: fact.metrics }] : [];
    });
}

function storiesToCite(workspace: Pick<CareerWorkspace, "db" | "profile">, job: Job | null) {
  const stories = listStoryRecords(workspace.db, 1000);
  const order = job ? matchStories(job, stories, workspace.profile).topStories.map((entry) => entry.storyId) : stories.map((story) => story.id);
  return order.slice(0, 3).flatMap((id) => {
    const story = stories.find((entry) => entry.id === id);
    return story ? [{ storyId: story.id, title: story.title, result: story.result }] : [];
  });
}

function attachmentChecklist(application: Application | null, profile: Profile) {
  if (!application) return [];
  const links = Object.entries(profile.identity.links).map(([label, url]) => `${label}: ${url}`);
  return [
    {
      item: "Resume",
      detail: `${application.resumeId}: ${application.resumePath}`,
      ready: application.resumePath !== "" && existsSync(application.resumePath),
    },
    {
      item: "Cover letter",
      detail: application.coverLetter.trim()
        ? "Drafted in the application packet: attach it as a PDF or paste it below the email."
        : "None drafted; do not mention one.",
      ready: application.coverLetter.trim().length > 0,
    },
    { item: "Links", detail: links.join(", ") || "none in the profile", ready: links.length > 0 },
  ];
}

/** Outreach scaffold: who, why, which facts, which limits. Reads only. */
export function outreachScaffold(workspace: CareerWorkspace, input: OutreachScaffoldInput) {
  const parsed = parseInput(OutreachScaffoldSchema, input, "outreach scaffold");
  const { db, profile } = workspace;
  const target = resolveTarget(workspace, parsed);
  const { job, contact, application } = target;
  const emailLike = EMAIL_LIKE.includes(parsed.channel);
  const previous = listOutreachDraftRecords(db, application ? { applicationId: application.id, limit: 5 } : { company: target.company, limit: 5 });
  return {
    channel: parsed.channel,
    limits: CHANNEL_LIMITS[parsed.channel],
    company: target.company,
    role: job
      ? {
          jobId: job.id,
          title: job.title,
          url: job.url,
          locations: job.locationsRaw,
          workplaceType: job.workplaceType,
          requirements: requirementLines(job.descriptionText, { limit: 8 }).map((line) => line.text),
          injectionFlags: detectInjection(job.descriptionText).map((flag) => flag.pattern),
        }
      : null,
    application: application ? { id: application.id, status: application.status, submittedAt: application.submittedAt } : null,
    contact,
    structure: contact ? PERSONA_STRUCTURES[contact.kind] : CHANNEL_STRUCTURES[parsed.channel],
    factsToCite: factsToCite(profile, job),
    stories: storiesToCite(workspace, job),
    candidate: {
      name: profile.identity.fullName,
      headline: profile.identity.headline,
      links: profile.identity.links,
      ...(emailLike ? { email: profile.identity.email, phone: profile.identity.phone } : {}),
    },
    attachments: parsed.channel === "email" ? attachmentChecklist(application, profile) : [],
    companyNotes: listCompanyNoteRecords(db, target.company, undefined, 5).map((note) => ({
      kind: note.kind,
      sources: note.sources,
      ...truncateText(note.content, 600),
    })),
    previousDrafts: previous.map((draft) => ({
      id: draft.id,
      channel: draft.channel,
      status: draft.status,
      contactId: draft.contactId,
      createdAt: draft.createdAt,
      preview: truncateText(draft.body, 160).text,
    })),
    guidelines: OUTREACH_GUIDELINES,
    warnings: target.warnings,
  };
}

/** Numbers an outreach draft may state: the profile's, plus the role's and offers' own records. */
function draftEvidence(workspace: CareerWorkspace, target: Target, channel: OutreachChannel): EvidenceText[] {
  const { profile } = workspace;
  const evidence: EvidenceText[] = [...profileFigureEvidence(profile), { source: "company", text: target.company }];
  if (EMAIL_LIKE.includes(channel)) evidence.push({ source: "identity:phone", text: profile.identity.phone });
  if (target.job) {
    const pay = target.job.compensation;
    const payText = pay ? [pay.raw, pay.min ?? "", pay.max ?? ""].join(" ") : "";
    evidence.push({ source: "job", text: `${target.job.title} ${target.job.externalId} ${payText}` });
  }
  if (target.contact) evidence.push({ source: "contact", text: `${target.contact.name} ${target.contact.role}` });
  const offers = listOfferRecords(workspace.db, { statuses: ACTIVE_OFFER_STATUSES }).filter(
    (offer) => offer.applicationId === (target.application?.id ?? "") || sameCompany(offer.company, target.company),
  );
  for (const offer of offers) {
    const comp = offerComp(offer);
    const plan = negotiationPlan(workspace, offer.id);
    // The walk-away figure is deliberately absent: it must never appear in a message.
    const figures = [
      comp.base, comp.targetBonus, comp.annualEquity, comp.signOn, comp.relocation, comp.firstYearTotal, comp.annualizedTotal,
      plan.numbers.anchor, plan.numbers.target, plan.recommendedCounter.base,
      plan.recommendedCounter.baseIncrease, plan.recommendedCounter.additionalAnnualEquity,
      ...(offer.bonusTargetPct !== null ? [`${offer.bonusTargetPct}%`] : []),
    ];
    evidence.push({ source: `offer:${offer.id}`, text: figures.join(" ") });
  }
  return evidence;
}

const URLS_AND_EMAILS =
  /\b(?:https?:\/\/|www\.)\S+|\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b|\b[\w-]+(?:\.[\w-]+)*\.[A-Za-z]{2,}\/\S*/gi;

/** The text whose figures are checked: no links, addresses, dates or times. */
function figureText(subject: string, body: string): string {
  return withoutDatesAndTimes(`${subject}\n${body}`.replace(URLS_AND_EMAILS, " "));
}

function enforceLimits(channel: OutreachChannel, limit: ChannelLimit, subject: string, body: string): void {
  if (limit.subject === "none" && subject) {
    throw new AppError("subject_not_allowed", `${channel} has no subject line; put everything in the body`);
  }
  if (limit.subject === "required" && !subject) throw new AppError("subject_required", `${channel} drafts need a subject line`);
  const characters = codePoints(body);
  if (characters > limit.maxChars) {
    throw new AppError("too_long", `${channel} is limited to ${limit.maxChars} characters; this draft has ${characters}.`, {
      characters,
      maxChars: limit.maxChars,
    });
  }
  const words = wordCount(body);
  if (limit.maxWords !== null && words > limit.maxWords) {
    throw new AppError("too_long", `${channel} drafts are limited to ${limit.maxWords} words; this one has ${words}.`, {
      words,
      maxWords: limit.maxWords,
    });
  }
}

function draftWarnings(
  workspace: Pick<CareerWorkspace, "db">,
  target: Target,
  channel: OutreachChannel,
  body: string,
  selfId: string | null = null,
): string[] {
  const limit = CHANNEL_LIMITS[channel];
  const warnings = [...target.warnings];
  if (codePoints(body) > limit.recommendedMaxChars) warnings.push(`Over ${limit.recommendedMaxChars} characters. ${limit.note}`);
  if (FILLER_PATTERN.test(body)) warnings.push("Contains stock filler; say it plainly instead.");
  const contact = target.contact;
  if (contact?.kind === "peer" && JOB_ASK_PATTERN.test(body)) {
    warnings.push("Peers are asked for their perspective, not for a job or a referral.");
  }
  if (channel === "referral_request" && contact && contact.kind !== "referral") {
    warnings.push(`A referral request needs a real prior relationship; ${contact.name} is recorded as ${contact.kind}.`);
  }
  if (channel.startsWith("linkedin") && /\battach/i.test(body)) warnings.push("LinkedIn notes cannot carry attachments.");
  if (contact) {
    const pending = listOutreachDraftRecords(workspace.db, { contactId: contact.id, channel, status: "draft", limit: 5 }).filter(
      (draft) => draft.id !== selfId,
    );
    if (pending.length > 0) warnings.push(`An earlier unsent ${channel} draft to ${contact.name} exists (${pending[0]?.id}); discard it if this replaces it.`);
  }
  return warnings;
}

/** Limits, then every figure checked against the profile and the role's records; throws on the first failure. */
function checkDraft(workspace: CareerWorkspace, target: Target, channel: OutreachChannel, subject: string, body: string) {
  enforceLimits(channel, CHANNEL_LIMITS[channel], subject, body);
  const check = checkNumbers(figureText(subject, body), draftEvidence(workspace, target, channel));
  if (check.unverified.length > 0) {
    throw new AppError(
      "unverified_figures",
      `the draft states figures found neither in the profile nor in this role's records: ${check.unverified.join(", ")}. Use only figures from factsToCite, or drop them.`,
      { offending: check.unverified },
    );
  }
  return check;
}

/**
 * Stores a draft after enforcing the channel's limits and checking that every
 * figure in it appears in the profile or in the role's own records.
 */
export function saveOutreachDraft(workspace: CareerWorkspace, input: OutreachDraftInput) {
  const parsed = parseInput(OutreachDraftInputSchema, input, "outreach draft");
  const target = resolveTarget(workspace, parsed);
  const limit = CHANNEL_LIMITS[parsed.channel];
  const check = checkDraft(workspace, target, parsed.channel, parsed.subject, parsed.body);
  const warnings = draftWarnings(workspace, target, parsed.channel, parsed.body);
  const now = nowIso();
  const draft: OutreachDraft = {
    id: newId("outreach"),
    applicationId: target.application?.id ?? null,
    contactId: target.contact?.id ?? null,
    company: target.company,
    channel: parsed.channel,
    subject: parsed.subject,
    body: parsed.body,
    status: "draft",
    createdAt: now,
    updatedAt: now,
  };
  insertOutreachDraftRecord(workspace.db, draft);
  appendEvent(workspace.db, "outreach.drafted", draft.id, {
    channel: draft.channel,
    applicationId: draft.applicationId,
    contactId: draft.contactId,
  });
  return {
    draft,
    characters: codePoints(draft.body),
    words: wordCount(draft.body),
    limits: limit,
    figures: check.checked,
    warnings,
    nextStep: "Show the draft to the candidate. They send it themselves, then call mark_outreach with sent_by_user.",
  };
}

export function listOutreachDrafts(workspace: Pick<CareerWorkspace, "db">, filter: OutreachFilter = {}): OutreachDraft[] {
  return listOutreachDraftRecords(workspace.db, filter);
}

/** Records what the candidate did with a draft. The server itself never sends. */
export function markOutreach(workspace: Pick<CareerWorkspace, "db">, id: string, status: OutreachStatus) {
  if (!OUTREACH_STATUSES.includes(status)) throw new AppError("invalid_input", `unknown outreach status ${status}`);
  const draft = getOutreachDraft(workspace.db, id);
  if (!draft) throw new AppError("outreach_not_found", `no outreach draft ${id}`);
  if (draft.status === status) return { draft, changed: false };
  if (!(TRANSITIONS[draft.status] ?? []).includes(status)) {
    throw new AppError("invalid_transition", `an outreach draft cannot go from ${draft.status} to ${status}`);
  }
  const updatedAt = nowIso();
  setOutreachStatusRecord(workspace.db, id, status, updatedAt);
  appendEvent(workspace.db, "outreach.marked", id, { from: draft.status, to: status });
  return { draft: { ...draft, status, updatedAt }, changed: true };
}

export const UpdateOutreachDraftSchema = z.object({
  id: z.string().trim().min(1),
  channel: z.enum(OUTREACH_CHANNELS).optional(),
  subject: z.string().trim().max(200).optional(),
  body: z.string().trim().min(1).max(10_000).optional(),
});
type UpdateOutreachDraftInput = z.input<typeof UpdateOutreachDraftSchema>;

function requireDraft(workspace: Pick<CareerWorkspace, "db">, id: string): OutreachDraft {
  const draft = getOutreachDraft(workspace.db, id);
  if (!draft) throw new AppError("outreach_not_found", `no outreach draft ${id}`);
  return draft;
}

/**
 * Edits an unsent draft's channel, subject or body, with the same limits and
 * figure check as saving one. A sent draft is the record of what went out,
 * and a discarded one is restored first; neither is edited.
 */
export function updateOutreachDraft(workspace: CareerWorkspace, input: UpdateOutreachDraftInput) {
  const parsed = parseInput(UpdateOutreachDraftSchema, input, "outreach draft update");
  const existing = requireDraft(workspace, parsed.id);
  if (existing.status !== "draft") {
    throw new AppError(
      "outreach_not_editable",
      existing.status === "sent_by_user"
        ? "this draft was sent; it stays as the record of what went out"
        : "this draft is discarded; restore it to drafts before editing",
    );
  }
  const target = resolveTarget(workspace, {
    applicationId: existing.applicationId ?? undefined,
    contactId: existing.contactId ?? undefined,
    company: existing.company,
  });
  const channel = parsed.channel ?? existing.channel;
  const subject = parsed.subject ?? existing.subject;
  const body = parsed.body ?? existing.body;
  const check = checkDraft(workspace, target, channel, subject, body);
  const draft: OutreachDraft = { ...existing, channel, subject, body, updatedAt: nowIso() };
  const changed = (["channel", "subject", "body"] as const).filter((key) => draft[key] !== existing[key]);
  updateOutreachDraftRecord(workspace.db, draft);
  appendEvent(workspace.db, "outreach.edited", draft.id, { channel: draft.channel, changed });
  return {
    draft,
    changed,
    characters: codePoints(draft.body),
    words: wordCount(draft.body),
    limits: CHANNEL_LIMITS[channel],
    figures: check.checked,
    warnings: draftWarnings(workspace, target, channel, body, draft.id),
  };
}

/** Deletes a draft that was never sent. A sent one is kept as the record of what went out. */
export function deleteOutreachDraft(workspace: Pick<CareerWorkspace, "db">, id: string): { deleted: string } {
  const draft = requireDraft(workspace, id);
  if (draft.status === "sent_by_user") {
    throw new AppError("outreach_sent", "this draft was sent; it stays as the record of what went out");
  }
  deleteOutreachDraftRecord(workspace.db, draft.id);
  appendEvent(workspace.db, "outreach.deleted", draft.id, { channel: draft.channel, status: draft.status });
  return { deleted: draft.id };
}
