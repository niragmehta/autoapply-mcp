import type { Job } from "../domain/job.js";
import { annualize, convertCurrency } from "../ranking/compensation.js";
import type { Offer } from "./types.js";

/**
 * Offer arithmetic: normalized total compensation, currency conversion with
 * the campaign's configured rates, the posting's published range and the
 * desired / advertised / offered gap. Gap math follows career-ops
 * salary-gap.mjs (MIT): percentages are (to - from) / from, and figures in
 * different currencies are compared only through a configured rate, never a
 * guessed one.
 */

/** A typical four-year vesting horizon; a sign-on bonus is spread over it for annualized totals. */
export const DEFAULT_SIGN_ON_AMORTIZATION_YEARS = 4;

export type OfferComp = {
  currency: string;
  base: number;
  targetBonus: number;
  bonusBasis: "amount" | "pct" | "none";
  annualEquity: number;
  signOn: number;
  relocation: number;
  /** Base + target bonus + annual equity. */
  recurringTotal: number;
  /** Recurring total plus the whole sign-on bonus. */
  firstYearTotal: number;
  /** Recurring total plus the sign-on bonus spread over `signOnAmortizationYears`. */
  annualizedTotal: number;
  signOnAmortizationYears: number;
};

export function round(value: number, places = 0): number {
  const factor = 10 ** places;
  return Math.round(value * factor) / factor;
}

export function offerComp(offer: Offer, signOnAmortizationYears = DEFAULT_SIGN_ON_AMORTIZATION_YEARS): OfferComp {
  const years = signOnAmortizationYears > 0 ? signOnAmortizationYears : DEFAULT_SIGN_ON_AMORTIZATION_YEARS;
  const bonusBasis = offer.bonusTargetAmount !== null ? "amount" : offer.bonusTargetPct !== null ? "pct" : "none";
  const targetBonus =
    offer.bonusTargetAmount ?? (offer.bonusTargetPct !== null ? (offer.base * offer.bonusTargetPct) / 100 : 0);
  const annualEquity = offer.equityValueAnnual ?? 0;
  const signOn = offer.signOn ?? 0;
  const recurringTotal = offer.base + targetBonus + annualEquity;
  return {
    currency: offer.currency,
    base: offer.base,
    targetBonus: round(targetBonus),
    bonusBasis,
    annualEquity,
    signOn,
    relocation: offer.relocation ?? 0,
    recurringTotal: round(recurringTotal),
    firstYearTotal: round(recurringTotal + signOn),
    annualizedTotal: round(recurringTotal + signOn / years),
    signOnAmortizationYears: years,
  };
}

/** Percentage change from `from` to `to`, one decimal place; null without a positive base. */
export function pctDelta(from: number | null, to: number | null): number | null {
  if (from === null || to === null || from <= 0) return null;
  return round(((to - from) / from) * 100, 1);
}

export type Converter = (amount: number, fromCurrency: string) => number | null;

/** Converts into `currency` using the campaign's static FX table; null when a rate is missing. */
export function converterTo(currency: string, fx: Readonly<Record<string, number>>): Converter {
  const target = currency.toUpperCase();
  return (amount, fromCurrency) => {
    const converted = convertCurrency(amount, fromCurrency.toUpperCase(), target, { ...fx });
    return converted === null ? null : round(converted);
  };
}

export type PostingRange = {
  currency: string;
  period: string;
  min: number | null;
  max: number | null;
  mid: number | null;
  raw: string;
};

/** The posting's published pay as annual figures, or null when it has none usable. */
export function postingRange(job: Pick<Job, "compensation"> | null): PostingRange | null {
  const range = job?.compensation;
  if (!range) return null;
  const min = range.min === null ? null : annualize(range.min, range.period);
  const max = range.max === null ? null : annualize(range.max, range.period);
  if (min === null && max === null) return null;
  const mid = min !== null && max !== null ? (min + max) / 2 : (min ?? max);
  return { currency: range.currency.toUpperCase(), period: range.period, min, max, mid, raw: range.raw };
}

type SalaryGap = {
  /** Every figure below is in this currency. */
  currency: string;
  desired: number;
  advertisedMid: number | null;
  advertisedTop: number | null;
  offeredBase: number | null;
  offeredTotal: number | null;
  advertisedMidToOfferedBasePct: number | null;
  advertisedTopToOfferedBasePct: number | null;
  desiredToOfferedTotalPct: number | null;
  desiredToAdvertisedTopPct: number | null;
  notes: string[];
};

/**
 * Desired vs advertised vs offered, in the profile's currency. Posted ranges
 * are usually base pay, so they are compared with the offered base; the
 * desired figure is a total, so it is compared with the annualized total.
 */
export function salaryGap(input: {
  currency: string;
  desired: number;
  comp: OfferComp;
  posting: PostingRange | null;
  convert: Converter;
}): SalaryGap {
  const { comp, posting, convert } = input;
  const notes: string[] = [];
  const offeredBase = convert(comp.base, comp.currency);
  const offeredTotal = convert(comp.annualizedTotal, comp.currency);
  if (offeredBase === null) notes.push(`No FX rate for ${comp.currency}->${input.currency}; offer figures not compared.`);
  const advertisedMid = posting && posting.mid !== null ? convert(posting.mid, posting.currency) : null;
  const advertisedTop = posting && posting.max !== null ? convert(posting.max, posting.currency) : null;
  if (posting && advertisedMid === null && advertisedTop === null) {
    notes.push(`No FX rate for ${posting.currency}->${input.currency}; posted range not compared.`);
  }
  if (!posting) notes.push("No published range on the posting.");
  return {
    currency: input.currency,
    desired: input.desired,
    advertisedMid,
    advertisedTop,
    offeredBase,
    offeredTotal,
    advertisedMidToOfferedBasePct: pctDelta(advertisedMid, offeredBase),
    advertisedTopToOfferedBasePct: pctDelta(advertisedTop, offeredBase),
    desiredToOfferedTotalPct: pctDelta(input.desired, offeredTotal),
    desiredToAdvertisedTopPct: pctDelta(input.desired, advertisedTop),
    notes,
  };
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[middle] ?? null) : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}
