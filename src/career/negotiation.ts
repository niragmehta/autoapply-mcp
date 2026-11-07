import { z } from "zod";
import type { Db } from "../db/database.js";
import { listOfferRecords } from "../db/repositories/career/offers.js";
import { listStoryRecords } from "../db/repositories/career/stories.js";
import type { Job } from "../domain/job.js";
import type { Profile } from "../domain/profile.js";
import { extractFigures } from "../text/figures.js";
import { AppError } from "../util/errors.js";
import { daysUntil, parseInput, type CareerWorkspace } from "./context.js";
import { converterTo, offerComp, postingRange, round, type OfferComp } from "./offerMath.js";
import { jobForOffer, requireOffer } from "./offers.js";
import { matchStories } from "./storyMatch.js";
import type { Offer } from "./types.js";

/**
 * Negotiation plan: anchor, target and walk-away numbers from the
 * candidate's own targets and the market signals on file, a recommended
 * counter split across levers, the expected value of negotiating with its
 * assumptions spelled out, and the risks. Inspired by career-ops
 * salary-gap.mjs and negotiation-roi.mjs (MIT): figures come only from
 * recorded data, and every assumption is named so it can be challenged.
 */

/** Open this far above the target, leaving room to settle at it. */
const ANCHOR_PREMIUM = 0.07;
/** Beyond this uplift over the offer, a counter rarely lands without a hard reason. */
const MAX_ANCHOR_UPLIFT = 0.25;
/** The ask when the offer already meets every signal. */
const MODEST_ASK = 0.05;
const ROUND_TO = 1000;
const DEADLINE_SOON_DAYS = 3;

export const NegotiationAssumptionsSchema = z.object({
  pImprove: z.number().min(0).max(1).default(0.7).describe("Chance the employer improves something when asked professionally."),
  captureRate: z.number().min(0).max(1).default(0.5).describe("Share of the requested increase you end up with."),
  pWithdraw: z.number().min(0).max(1).default(0.02).describe("Chance the offer is withdrawn because you negotiated."),
  horizonYears: z.number().min(0.5).max(10).default(3).describe("Years the recurring increase is counted."),
});
type NegotiationAssumptions = z.input<typeof NegotiationAssumptionsSchema>;
type Assumptions = z.output<typeof NegotiationAssumptionsSchema>;

type Signal = { label: string; value: number };

/** Everything the plan is computed from, in the offer's currency. */
type Market = {
  offer: Offer;
  comp: OfferComp;
  currency: string;
  current: number;
  bonusRate: number;
  target: number | null;
  minimum: number | null;
  postedTopBase: number | null;
  postedTopTotal: number | null;
  bestCompeting: Signal | null;
  job: Job | null;
};

type CounterSplit = { base: number; baseIncrease: number; remainder: number };

function roundTo(value: number): number {
  return Math.round(value / ROUND_TO) * ROUND_TO;
}

function money(value: number, currency: string): string {
  return `${Math.round(value).toLocaleString("en-US")} ${currency}`;
}

function strongest(signals: readonly Signal[]): Signal | null {
  return signals.reduce<Signal | null>((best, signal) => (best === null || signal.value > best.value ? signal : best), null);
}

function competingOffers(db: Db, offer: Offer, toOffer: (amount: number, from: string) => number | null): Signal[] {
  return listOfferRecords(db, { statuses: ["received", "negotiating"] })
    .filter((other) => other.id !== offer.id)
    .flatMap((other) => {
      const total = toOffer(offerComp(other).annualizedTotal, other.currency);
      return total === null ? [] : [{ label: `competing offer from ${other.company}`, value: total }];
    });
}

function readMarket(workspace: CareerWorkspace, offer: Offer): Market {
  const { db, profile, campaign } = workspace;
  const comp = offerComp(offer);
  const current = comp.annualizedTotal;
  const toOffer = converterTo(offer.currency, campaign.compensation.fx);
  const job = jobForOffer(db, offer);
  const posting = postingRange(job);
  const bonusRate = comp.bonusBasis === "pct" ? (offer.bonusTargetPct ?? 0) / 100 : 0;
  const postedTopBase = posting && posting.max !== null ? toOffer(posting.max, posting.currency) : null;
  return {
    offer,
    comp,
    currency: offer.currency,
    current,
    bonusRate,
    target: toOffer(profile.compensation.targetTotal, profile.compensation.currency),
    minimum: toOffer(profile.compensation.minimumTotal, profile.compensation.currency),
    postedTopBase,
    postedTopTotal:
      postedTopBase !== null && postedTopBase > comp.base ? current + (postedTopBase - comp.base) * (1 + bonusRate) : null,
    bestCompeting: strongest(competingOffers(db, offer, toOffer)),
    job,
  };
}

function planNumbers(market: Market) {
  const { current, target, minimum, postedTopTotal, bestCompeting } = market;
  const marketSignals: Signal[] = [
    ...(target !== null ? [{ label: "your target total (profile.compensation.targetTotal)", value: target }] : []),
    ...(postedTopTotal !== null ? [{ label: "base at the top of the posted range", value: postedTopTotal }] : []),
    ...(bestCompeting ? [bestCompeting] : []),
  ];
  const signal = strongest(marketSignals);
  const targetBasis =
    signal && signal.value > current
      ? signal
      : { label: `the offer already meets every signal; a modest ${MODEST_ASK * 100}% ask`, value: current * (1 + MODEST_ASK) };
  const targetValue = roundTo(targetBasis.value);
  const cap = current * (1 + MAX_ANCHOR_UPLIFT);
  const anchor = Math.max(roundTo(targetValue >= cap ? targetValue : Math.min(targetValue * (1 + ANCHOR_PREMIUM), cap)), targetValue);
  const walkAwayBasis = strongest([
    ...(minimum !== null ? [{ label: "your minimum (profile.compensation.minimumTotal)", value: minimum }] : []),
    ...(bestCompeting ? [bestCompeting] : []),
  ]);
  return {
    anchor,
    target: targetValue,
    walkAway: walkAwayBasis ? roundTo(walkAwayBasis.value) : null,
    basis: {
      target: targetBasis.label,
      anchor: `target plus up to ${ANCHOR_PREMIUM * 100}%, capped at ${MAX_ANCHOR_UPLIFT * 100}% above the offer unless the target itself is higher`,
      walkAway: walkAwayBasis?.label ?? "unknown",
    },
    marketSignals,
    privateNote: "The walk-away number is for the candidate only; never disclose it.",
  };
}

/** Base first, up to the posted range's top; whatever is left becomes equity or a sign-on. */
function counterSplit(market: Market, anchor: number): CounterSplit {
  const { comp, bonusRate, postedTopBase } = market;
  const totalWithBase = (base: number) => comp.annualizedTotal + (base - comp.base) * (1 + bonusRate);
  const gap = Math.max(anchor - comp.annualizedTotal, 0);
  const baseRoom = postedTopBase === null ? Number.POSITIVE_INFINITY : Math.max(postedTopBase - comp.base, 0);
  const baseIncrease = Math.max(roundTo(Math.min(gap / (1 + bonusRate), baseRoom)), 0);
  const remainder = Math.max(roundTo(anchor - totalWithBase(comp.base + baseIncrease)), 0);
  return { base: comp.base + baseIncrease, baseIncrease, remainder };
}

function expectedValueOf(market: Market, anchor: number, assumptions: Assumptions) {
  const requested = anchor - market.current;
  const gainIfImproved = assumptions.captureRate * requested * assumptions.horizonYears;
  const alternative = market.bestCompeting?.value ?? 0;
  const lossIfWithdrawn = Math.max(market.current - alternative, 0);
  const value = assumptions.pImprove * gainIfImproved - assumptions.pWithdraw * lossIfWithdrawn;
  const breakEven = lossIfWithdrawn > 0 ? Math.min(1, (assumptions.pImprove * gainIfImproved) / lossIfWithdrawn) : 1;
  return {
    value: round(value),
    positive: value > 0,
    breakEvenWithdrawProbability: round(breakEven, 3),
    formula: "EV = pImprove x captureRate x (anchor - offer) x horizonYears - pWithdraw x max(offer - best alternative, 0)",
    inputs: {
      ...assumptions,
      requestedIncrease: round(requested),
      gainIfImproved: round(gainIfImproved),
      lossIfWithdrawn: round(lossIfWithdrawn),
      bestAlternative: round(alternative),
    },
    assumptions: [
      "pImprove, captureRate and pWithdraw are illustrative defaults, not data about this employer; override them with what you know.",
      "The gain counts the recurring increase for horizonYears and ignores raises compounding on a higher base.",
      "The loss counts one year of this offer's value over your best alternative, or all of it when there is no alternative.",
    ],
  };
}

function planRisks(market: Market, anchor: number, profileCurrency: string): string[] {
  const { offer, comp, current, currency, minimum, target, postedTopBase, postedTopTotal, bestCompeting } = market;
  const requested = anchor - current;
  const deadlineDays = daysUntil(offer.deadline);
  const risks: string[] = [];
  if (minimum !== null && current < minimum) {
    risks.push(`The offer (${money(current, currency)}) is below your minimum (${money(minimum, currency)}); be ready to walk away.`);
  }
  if (requested / current > 0.2) {
    risks.push(`The counter is ${round((requested / current) * 100)}% above the offer; lead with the concrete reason for it.`);
  }
  if (postedTopTotal === null && !bestCompeting) {
    risks.push("No posted range or competing offer on file: the numbers rest on your own target. Gather market data first.");
  }
  if (bestCompeting) risks.push("Only cite a competing offer you actually hold, at its real numbers; never invent or inflate one.");
  if (postedTopBase !== null && comp.base >= postedTopBase) {
    risks.push("Base is already at or above the posted range's top; push on sign-on, equity or level instead.");
  }
  if (deadlineDays !== null && deadlineDays <= DEADLINE_SOON_DAYS) {
    const when = deadlineDays < 0 ? "past" : `${deadlineDays} day(s) away`;
    risks.push(`The deadline (${offer.deadline}) is ${when}: ask for more time before anything else.`);
  }
  if (offer.status === "accepted") risks.push("This offer is already accepted; reopening terms now carries real relationship cost.");
  if (/\boption/i.test(offer.equityDetails)) {
    risks.push("Options: their value depends on strike price, share count and preferred price; ask for all three.");
  }
  if (target === null || minimum === null) {
    risks.push(`No FX rate for ${profileCurrency}->${currency}; target and minimum could not be applied.`);
  }
  return risks;
}

function immigrationLever(profile: Profile, job: Job | null) {
  if (!job) return null;
  const country = job.country.toUpperCase();
  const auth = profile.workAuthorization;
  const listed = (codes: readonly string[]) => codes.map((code) => code.toUpperCase()).includes(country);
  const noPetition = listed(auth.noSponsorshipRequiredIn);
  // Only a country the profile explicitly lists; an unknown or remote location says nothing.
  if (listed(auth.authorizedIn) || (!noPetition && !listed(auth.requiresSponsorshipIn))) return null;
  return {
    lever: "immigration",
    current: noPetition ? "status available without a sponsorship petition (e.g. TN)" : "employer sponsorship required",
    ask: null,
    note: noPetition
      ? "Ask the employer to provide the support letter and cover legal fees, renewals and travel timing."
      : "Ask the employer to confirm sponsorship, cover legal fees and protect the start date if approval is delayed.",
  };
}

function planLevers(market: Market, split: CounterSplit, profile: Profile) {
  const { offer, comp, currency, postedTopBase } = market;
  return [
    {
      lever: "base",
      current: comp.base,
      ask: split.base,
      note:
        postedTopBase !== null
          ? `Posted range tops out at ${money(postedTopBase, currency)}.`
          : "No posted range: justify with market data or a competing offer.",
    },
    {
      lever: "sign_on",
      current: comp.signOn,
      ask: comp.signOn + split.remainder,
      note: "One-time; often the easiest to grant when base is capped. Check its repayment clause.",
    },
    {
      lever: "equity",
      current: comp.annualEquity,
      ask: comp.annualEquity + split.remainder,
      note: offer.equityDetails || "Ask for grant size, vesting schedule, cliff and refresh policy.",
    },
    {
      lever: "level",
      current: offer.level || "not recorded",
      ask: null,
      note: "A level change moves the whole band; ask how the level was set if your scope fits the next one.",
    },
    {
      lever: "start_date",
      current: offer.startDate ?? "not set",
      ask: null,
      note: "Flexibility here is a cheap concession to give, or a real ask if you need time.",
    },
    {
      lever: "remote",
      current: offer.remotePolicy || "not recorded",
      ask: null,
      note: `Your workplace preferences: ${profile.preferences.workplaceTypes.join(", ")}.`,
    },
    ...[immigrationLever(profile, market.job)].filter((lever) => lever !== null),
  ];
}

/** Stories whose results carry figures (already verified when saved), best fit with the posting first. */
function proofPoints(db: Db, profile: Profile, job: Job | null) {
  const stories = listStoryRecords(db, 1000).filter((story) => extractFigures(story.result).length > 0);
  const order = job ? matchStories(job, stories, profile).topStories.map((entry) => entry.storyId) : [];
  const rank = (id: string) => (order.includes(id) ? order.indexOf(id) : order.length);
  return [...stories]
    .sort((left, right) => rank(left.id) - rank(right.id))
    .slice(0, 3)
    .map((story) => ({ storyId: story.id, title: story.title, result: story.result }));
}

function counterSummary(split: CounterSplit, currency: string): string {
  return split.remainder > 0
    ? `Base ${money(split.base, currency)} plus ${money(split.remainder, currency)} a year more in equity (or a sign-on of ${money(split.remainder, currency)} to cover the first year).`
    : `Base ${money(split.base, currency)}.`;
}

function talkingPoints(market: Market, split: CounterSplit, anchor: number, signals: readonly Signal[], proof: ReturnType<typeof proofPoints>) {
  const { offer, currency } = market;
  const ask =
    split.remainder > 0
      ? `a base of ${money(split.base, currency)} and ${money(split.remainder, currency)} a year more in equity`
      : `a base of ${money(split.base, currency)}`;
  return [
    `Thank them and restate enthusiasm for the ${offer.title || "role"} at ${offer.company}.`,
    `The ask: ${ask}, about ${money(anchor, currency)} a year in total.`,
    `The reason: ${signals.length > 0 ? signals.map((signal) => signal.label).join("; ") : "your own target"}.`,
    proof.length > 0 ? `The proof: ${proof.map((point) => point.title).join("; ")}.` : "The proof: one verified achievement from the story bank.",
    "An open question: what flexibility is there on base, sign-on or equity?",
    offer.deadline ? `Confirm the timeline (deadline ${offer.deadline}).` : "Confirm the decision timeline.",
  ];
}

export function negotiationPlan(workspace: CareerWorkspace, offerId: string, assumptionsInput: NegotiationAssumptions = {}) {
  const offer = requireOffer(workspace.db, offerId);
  const assumptions = parseInput(NegotiationAssumptionsSchema, assumptionsInput, "negotiation assumptions");
  if (assumptions.pImprove + assumptions.pWithdraw > 1) {
    throw new AppError("invalid_input", "pImprove + pWithdraw cannot exceed 1");
  }
  const market = readMarket(workspace, offer);
  const numbers = planNumbers(market);
  const split = counterSplit(market, numbers.anchor);
  const proof = proofPoints(workspace.db, workspace.profile, market.job);
  return {
    offerId: offer.id,
    company: offer.company,
    title: offer.title,
    currency: market.currency,
    current: { base: market.comp.base, annualizedTotal: market.current, firstYearTotal: market.comp.firstYearTotal },
    numbers,
    recommendedCounter: {
      annualizedTotal: numbers.anchor,
      base: split.base,
      baseIncrease: split.baseIncrease,
      additionalAnnualEquity: split.remainder,
      signOnAlternative: split.remainder,
      summary: counterSummary(split, market.currency),
    },
    levers: planLevers(market, split, workspace.profile),
    expectedValue: expectedValueOf(market, numbers.anchor, assumptions),
    proofPoints: proof,
    talkingPoints: talkingPoints(market, split, numbers.anchor, numbers.marketSignals, proof),
    risks: planRisks(market, numbers.anchor, workspace.profile.compensation.currency),
    disclaimer: "Computed from your profile targets, the posting and offers on file; not market data, and not financial or legal advice.",
  };
}
