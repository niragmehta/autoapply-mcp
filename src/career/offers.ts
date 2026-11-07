import { z } from "zod";
import type { Db } from "../db/database.js";
import { appendEvent } from "../db/repositories/events.js";
import { getOffer, listOfferRecords, saveOfferRecord } from "../db/repositories/career/offers.js";
import type { Job } from "../domain/job.js";
import { AppError } from "../util/errors.js";
import { newId, nowIso } from "../util/hash.js";
import {
  daysUntil,
  parseInput,
  recordOutcomeOnce,
  requireApplication,
  toIsoDateTime,
  type CareerWorkspace,
} from "./context.js";
import {
  converterTo,
  DEFAULT_SIGN_ON_AMORTIZATION_YEARS,
  median,
  offerComp,
  pctDelta,
  postingRange,
  round,
  salaryGap,
  type Converter,
  type OfferComp,
  type PostingRange,
} from "./offerMath.js";
import { ACTIVE_OFFER_STATUSES, OFFER_STATUSES, type Offer, type OfferStatus } from "./types.js";

/** Offers: recording, updating, listing and comparing them in one currency. */

const AMOUNT = z.number().nonnegative().max(100_000_000);
const DATE = z.string().trim().min(1).max(40).describe("YYYY-MM-DD or an ISO 8601 date-time.");
const CURRENCY = z.string().trim().regex(/^[A-Za-z]{3}$/, "a 3-letter ISO currency code");

export const OfferInputSchema = z.object({
  applicationId: z.string().trim().min(1).optional(),
  company: z.string().trim().min(1).max(200).optional().describe("Required when there is no applicationId."),
  title: z.string().trim().max(200).optional(),
  level: z.string().trim().max(100).default(""),
  currency: CURRENCY,
  base: z.number().positive().max(100_000_000).describe("Annual base salary."),
  bonusTargetAmount: AMOUNT.optional(),
  bonusTargetPct: z.number().nonnegative().max(500).optional().describe("Target bonus as a percentage of base."),
  equityValueAnnual: AMOUNT.optional().describe("Equity value per year: grant value divided by vesting years."),
  equityDetails: z.string().max(2000).default(""),
  signOn: AMOUNT.optional(),
  relocation: AMOUNT.optional(),
  benefitsNotes: z.string().max(4000).default(""),
  location: z.string().trim().max(200).default(""),
  remotePolicy: z.string().trim().max(200).default(""),
  startDate: DATE.optional(),
  deadline: DATE.optional(),
  status: z.enum(OFFER_STATUSES).default("received"),
});
type OfferInput = z.input<typeof OfferInputSchema>;

export const UpdateOfferSchema = z.object({
  id: z.string().trim().min(1),
  title: z.string().trim().max(200).optional(),
  level: z.string().trim().max(100).optional(),
  currency: CURRENCY.optional(),
  base: z.number().positive().max(100_000_000).optional(),
  bonusTargetAmount: AMOUNT.nullable().optional(),
  bonusTargetPct: z.number().nonnegative().max(500).nullable().optional(),
  equityValueAnnual: AMOUNT.nullable().optional(),
  equityDetails: z.string().max(2000).optional(),
  signOn: AMOUNT.nullable().optional(),
  relocation: AMOUNT.nullable().optional(),
  benefitsNotes: z.string().max(4000).optional(),
  location: z.string().trim().max(200).optional(),
  remotePolicy: z.string().trim().max(200).optional(),
  startDate: DATE.nullable().optional(),
  deadline: DATE.nullable().optional(),
  status: z.enum(OFFER_STATUSES).optional(),
});
type UpdateOfferInput = z.input<typeof UpdateOfferSchema>;

function normalizeDate(value: string, field: string): string {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const parsed = new Date(`${value}T00:00:00Z`);
    // Date rolls 2030-02-30 over to March rather than failing, so compare the round trip.
    if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
      throw new AppError("invalid_input", `${field}: "${value}" is not a calendar date`);
    }
    return value;
  }
  return toIsoDateTime(value, field);
}

function optionalDate(value: string | null | undefined, field: string, fallback: string | null): string | null {
  if (value === undefined) return fallback;
  return value === null ? null : normalizeDate(value, field);
}

function offerWarnings(offer: Offer): string[] {
  const warnings: string[] = [];
  if (offer.bonusTargetAmount !== null && offer.bonusTargetPct !== null) {
    const implied = (offer.base * offer.bonusTargetPct) / 100;
    if (Math.abs(implied - offer.bonusTargetAmount) > Math.max(implied, offer.bonusTargetAmount) * 0.01) {
      warnings.push(
        `bonusTargetAmount ${offer.bonusTargetAmount} differs from ${offer.bonusTargetPct}% of base (${round(implied)}); the amount is used.`,
      );
    }
  }
  if (offer.equityDetails.trim() && offer.equityValueAnnual === null) {
    warnings.push("Equity is described but has no equityValueAnnual, so totals count it as 0.");
  }
  const remaining = daysUntil(offer.deadline);
  if (remaining !== null && remaining < 0 && (offer.status === "received" || offer.status === "negotiating")) {
    warnings.push(`The deadline ${offer.deadline} has passed; confirm the offer is still open or mark it expired.`);
  }
  return warnings;
}

export function requireOffer(db: Db, id: string): Offer {
  const offer = getOffer(db, id);
  if (!offer) throw new AppError("offer_not_found", `no offer ${id}`);
  return offer;
}

/** The posting behind an offer, when the offer is linked to an application that still exists. */
export function jobForOffer(db: Db, offer: Offer): Job | null {
  if (!offer.applicationId) return null;
  try {
    return requireApplication(db, offer.applicationId).job;
  } catch {
    // An offer outlives a pruned application; it is still comparable without its posting.
    return null;
  }
}

export function recordOffer(workspace: Pick<CareerWorkspace, "db">, input: OfferInput) {
  const parsed = parseInput(OfferInputSchema, input, "offer");
  const { db } = workspace;
  const linked = parsed.applicationId ? requireApplication(db, parsed.applicationId) : null;
  const company = parsed.company ?? linked?.job.companyName;
  if (!company) throw new AppError("invalid_input", "offer: give applicationId or company");
  const now = nowIso();
  const offer: Offer = {
    id: newId("offer"),
    applicationId: linked?.application.id ?? null,
    company,
    title: parsed.title ?? linked?.job.title ?? "",
    level: parsed.level,
    currency: parsed.currency.toUpperCase(),
    base: parsed.base,
    bonusTargetAmount: parsed.bonusTargetAmount ?? null,
    bonusTargetPct: parsed.bonusTargetPct ?? null,
    equityValueAnnual: parsed.equityValueAnnual ?? null,
    equityDetails: parsed.equityDetails,
    signOn: parsed.signOn ?? null,
    relocation: parsed.relocation ?? null,
    benefitsNotes: parsed.benefitsNotes,
    location: parsed.location,
    remotePolicy: parsed.remotePolicy,
    startDate: optionalDate(parsed.startDate, "startDate", null),
    deadline: optionalDate(parsed.deadline, "deadline", null),
    status: parsed.status,
    createdAt: now,
    updatedAt: now,
  };
  saveOfferRecord(db, offer);
  const outcomeRecorded = offer.applicationId ? recordOutcomeOnce(db, offer.applicationId, "offer", `offer ${offer.id} recorded`) : false;
  appendEvent(db, "offer.recorded", offer.id, { applicationId: offer.applicationId, status: offer.status });
  return { offer, comp: offerComp(offer), outcomeRecorded: outcomeRecorded ? "offer" : null, warnings: offerWarnings(offer) };
}

export function updateOffer(workspace: Pick<CareerWorkspace, "db">, input: UpdateOfferInput) {
  const parsed = parseInput(UpdateOfferSchema, input, "offer update");
  const { db } = workspace;
  const existing = requireOffer(db, parsed.id);
  const pick = <T>(value: T | undefined, fallback: T): T => (value === undefined ? fallback : value);
  const next: Offer = {
    ...existing,
    title: pick(parsed.title, existing.title),
    level: pick(parsed.level, existing.level),
    currency: parsed.currency ? parsed.currency.toUpperCase() : existing.currency,
    base: pick(parsed.base, existing.base),
    bonusTargetAmount: pick(parsed.bonusTargetAmount, existing.bonusTargetAmount),
    bonusTargetPct: pick(parsed.bonusTargetPct, existing.bonusTargetPct),
    equityValueAnnual: pick(parsed.equityValueAnnual, existing.equityValueAnnual),
    equityDetails: pick(parsed.equityDetails, existing.equityDetails),
    signOn: pick(parsed.signOn, existing.signOn),
    relocation: pick(parsed.relocation, existing.relocation),
    benefitsNotes: pick(parsed.benefitsNotes, existing.benefitsNotes),
    location: pick(parsed.location, existing.location),
    remotePolicy: pick(parsed.remotePolicy, existing.remotePolicy),
    startDate: optionalDate(parsed.startDate, "startDate", existing.startDate),
    deadline: optionalDate(parsed.deadline, "deadline", existing.deadline),
    status: pick(parsed.status, existing.status),
    updatedAt: nowIso(),
  };
  const changed = (Object.keys(next) as Array<keyof Offer>).filter(
    (key) => key !== "updatedAt" && next[key] !== existing[key],
  );
  saveOfferRecord(db, next);
  appendEvent(db, "offer.updated", next.id, { changed, status: next.status });
  return { offer: next, changed, comp: offerComp(next), warnings: offerWarnings(next) };
}

type OfferListFilter = { status?: OfferStatus; applicationId?: string; limit?: number };

export function listOffers(workspace: Pick<CareerWorkspace, "db">, filter: OfferListFilter = {}) {
  return listOfferRecords(workspace.db, {
    statuses: filter.status ? [filter.status] : undefined,
    applicationId: filter.applicationId,
    limit: filter.limit,
  }).map((offer) => ({ ...offer, comp: offerComp(offer), daysToDeadline: daysUntil(offer.deadline) }));
}

function postingComparison(comp: OfferComp, posting: PostingRange, fx: Readonly<Record<string, number>>) {
  const offeredBase = converterTo(posting.currency, fx)(comp.base, comp.currency);
  const position =
    offeredBase !== null && posting.min !== null && posting.max !== null && posting.max > posting.min
      ? round((offeredBase - posting.min) / (posting.max - posting.min), 2)
      : null;
  return {
    raw: posting.raw,
    currency: posting.currency,
    min: posting.min,
    max: posting.max,
    mid: posting.mid,
    offeredBase,
    /** 0 = bottom of the posted range, 1 = top; outside 0-1 means outside the range. */
    positionInRange: position,
    baseVsMidPct: pctDelta(posting.mid, offeredBase),
    baseVsTopPct: pctDelta(posting.max, offeredBase),
  };
}

function compareOne(workspace: CareerWorkspace, offer: Offer, currency: string, convert: Converter, years: number) {
  const { profile, campaign } = workspace;
  const comp = offerComp(offer, years);
  const posting = postingRange(jobForOffer(workspace.db, offer));
  const base = convert(comp.base, comp.currency);
  const firstYear = convert(comp.firstYearTotal, comp.currency);
  const annualized = convert(comp.annualizedTotal, comp.currency);
  const inProfileCurrency =
    base !== null && firstYear !== null && annualized !== null
      ? { currency, converted: comp.currency !== currency, base, firstYearTotal: firstYear, annualizedTotal: annualized }
      : null;
  const { targetTotal, minimumTotal } = profile.compensation;
  return {
    offerId: offer.id,
    applicationId: offer.applicationId,
    company: offer.company,
    title: offer.title,
    level: offer.level,
    status: offer.status,
    comp,
    inProfileCurrency,
    vsTarget: annualized === null ? null : { target: targetTotal, delta: round(annualized - targetTotal), pct: pctDelta(targetTotal, annualized) },
    vsMinimum: annualized === null ? null : { minimum: minimumTotal, delta: round(annualized - minimumTotal), meets: annualized >= minimumTotal },
    posting: posting ? postingComparison(comp, posting, campaign.compensation.fx) : null,
    salaryGap: salaryGap({ currency, desired: targetTotal, comp, posting, convert }),
    startDate: offer.startDate,
    deadline: offer.deadline,
    daysToDeadline: daysUntil(offer.deadline),
    warnings: offerWarnings(offer),
  };
}

type CompareOffersOptions = { includeClosed?: boolean; signOnAmortizationYears?: number };

/**
 * Every active offer in the profile's currency: totals, target and minimum,
 * the posting's published range and the desired / advertised / offered gap.
 */
export function compareOffers(workspace: CareerWorkspace, options: CompareOffersOptions = {}) {
  const currency = workspace.profile.compensation.currency.toUpperCase();
  const years = options.signOnAmortizationYears ?? DEFAULT_SIGN_ON_AMORTIZATION_YEARS;
  const convert = converterTo(currency, workspace.campaign.compensation.fx);
  const offers = listOfferRecords(workspace.db, { statuses: options.includeClosed ? undefined : ACTIVE_OFFER_STATUSES });
  const rows = offers.map((offer) => compareOne(workspace, offer, currency, convert, years));
  const gaps = rows
    .map((row) => row.salaryGap.advertisedMidToOfferedBasePct)
    .filter((value): value is number => value !== null);
  const ranking = rows
    .flatMap((row) => (row.inProfileCurrency ? [{ offerId: row.offerId, company: row.company, ...row.inProfileCurrency }] : []))
    .sort((left, right) => right.annualizedTotal - left.annualizedTotal);
  return {
    currency,
    assumptions: [
      `Totals are base + target bonus + stated annual equity value; a sign-on bonus counts in full in the first year and spread over ${years} years in the annualized total.`,
      "Relocation is listed separately and not counted as compensation.",
      "Other currencies are converted with campaign.compensation.fx (static, documented rates), never live rates.",
      "Posted ranges are treated as base pay. Equity is taken at the employer's stated value, not risk-adjusted.",
    ],
    offers: rows,
    ranking,
    aggregates: {
      offers: rows.length,
      meetsMinimum: rows.filter((row) => row.vsMinimum?.meets === true).length,
      atOrAboveTarget: rows.filter((row) => row.vsTarget !== null && row.vsTarget.delta >= 0).length,
      advertisedCompared: gaps.length,
      atOrAboveAdvertisedMid: gaps.filter((value) => value >= 0).length,
      meanAdvertisedMidToOfferedBasePct: gaps.length > 0 ? round(gaps.reduce((sum, value) => sum + value, 0) / gaps.length, 1) : null,
      medianAdvertisedMidToOfferedBasePct: median(gaps),
    },
  };
}
