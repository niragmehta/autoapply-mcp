import { z } from "zod";
import { ChecklistTickSchema, offerChecklist, setChecklistItem } from "../../career/contract.js";
import { negotiationPlan } from "../../career/negotiation.js";
import { offerComp } from "../../career/offerMath.js";
import { compareOffers, listOffers, OfferInputSchema, recordOffer, requireOffer, updateOffer, UpdateOfferSchema } from "../../career/offers.js";
import { OFFER_STATUSES } from "../../career/types.js";
import { resetAfterApplyCache } from "../queries/afterApply.js";
import { JsonReply, parseBody, parseParams, parseQuery, type Router } from "../router.js";
import { IdParams, queryBool, queryBounded, queryText } from "./shared.js";

/**
 * Offers: recording and editing them, comparing them in one currency with
 * what-if exchange rates, a negotiation plan per offer under assumptions the
 * person sets, and the contract checklist with the clauses they have read.
 */

const blank = (value: unknown) => (value === "" ? undefined : value);

const OffersQuery = z.object({ status: z.preprocess(blank, z.enum(OFFER_STATUSES).optional()), applicationId: queryText() });

/** `fx=EUR:1.1,GBP:1.27`: one unit of each currency in the campaign currency. */
const FxQuery = z.preprocess(
  (value) => {
    if (value === undefined || value === "") return undefined;
    const pairs = String(value)
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0)
      .map((part) => {
        const [code = "", rate = ""] = part.split(":");
        return [code.trim().toUpperCase(), rate.trim() === "" ? Number.NaN : Number(rate)] as const;
      });
    return Object.fromEntries(pairs);
  },
  z
    .record(z.string().regex(/^[A-Z]{3}$/, "a 3-letter currency code"), z.number().positive().finite())
    .refine((rates) => Object.keys(rates).length <= 20, "at most 20 rates")
    .optional(),
);

const CompareQuery = z.object({ includeClosed: queryBool, years: queryBounded(1, 10), fx: FxQuery });

const NegotiationQuery = z.object({
  pImprove: queryBounded(0, 1),
  captureRate: queryBounded(0, 1),
  pWithdraw: queryBounded(0, 1),
  horizonYears: queryBounded(0.5, 10),
});

const OfferBody = OfferInputSchema.strict();
const OfferPatch = UpdateOfferSchema.omit({ id: true }).strict();
const TickBody = ChecklistTickSchema.omit({ offerId: true }).strict();

export function registerRoutes(router: Router): void {
  router.get("/api/offers", (request) => {
    const query = parseQuery(OffersQuery, request);
    const offers = listOffers(request.ctx.workspace(), { status: query.status, applicationId: query.applicationId });
    return { count: offers.length, offers };
  });

  router.post("/api/offers", (request) => {
    const body = parseBody(OfferBody, request);
    const result = recordOffer(request.ctx.workspace(), body);
    resetAfterApplyCache();
    return new JsonReply(201, result);
  });

  router.patch("/api/offers/:id", (request) => {
    const { id } = parseParams(IdParams, request);
    const body = parseBody(OfferPatch, request);
    return updateOffer(request.ctx.workspace(), { ...body, id });
  });

  router.get("/api/offers/:id", (request) => {
    const { id } = parseParams(IdParams, request);
    const offer = requireOffer(request.ctx.workspace().db, id);
    return { offer, comp: offerComp(offer) };
  });

  router.get("/api/offers/compare", (request) => {
    const query = parseQuery(CompareQuery, request);
    return compareOffers(request.ctx.workspace(), { includeClosed: query.includeClosed === true, signOnAmortizationYears: query.years, fx: query.fx });
  });

  /** Unset assumptions take negotiationPlan's documented defaults. */
  router.get("/api/offers/:id/negotiation", (request) => {
    const { id } = parseParams(IdParams, request);
    const query = parseQuery(NegotiationQuery, request);
    const assumptions = Object.fromEntries(Object.entries(query).filter(([, value]) => value !== undefined));
    return negotiationPlan(request.ctx.workspace(), id, assumptions);
  });

  router.get("/api/offers/:id/checklist", (request) => {
    const { id } = parseParams(IdParams, request);
    return offerChecklist(request.ctx.workspace(), id);
  });

  router.post("/api/offers/:id/checklist", (request) => {
    const { id } = parseParams(IdParams, request);
    const body = parseBody(TickBody, request);
    return setChecklistItem(request.ctx.workspace(), { ...body, offerId: id });
  });
}
