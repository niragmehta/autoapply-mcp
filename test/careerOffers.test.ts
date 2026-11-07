import { beforeEach, describe, expect, it } from "vitest";
import { listOutcomes } from "../src/db/repositories/applications.js";
import { contractChecklist, contractChecklistFor } from "../src/career/contract.js";
import { negotiationPlan } from "../src/career/negotiation.js";
import { median, offerComp, pctDelta, postingRange } from "../src/career/offerMath.js";
import { compareOffers, listOffers, recordOffer, updateOffer } from "../src/career/offers.js";
import type { Offer } from "../src/career/types.js";
import { careerProfile, careerWorkspace, errorCode, seedApplication, type TestWorkspace } from "./careerFixtures.js";

let workspace: TestWorkspace;
let applicationId: string;

beforeEach(() => {
  workspace = careerWorkspace();
  applicationId = seedApplication(workspace.db).application.id;
});

function offer(overrides: Partial<Offer>): Offer {
  return {
    id: "offer_x",
    applicationId: null,
    company: "Initech",
    title: "Security Engineer",
    level: "",
    currency: "USD",
    base: 200000,
    bonusTargetAmount: null,
    bonusTargetPct: null,
    equityValueAnnual: null,
    equityDetails: "",
    signOn: null,
    relocation: null,
    benefitsNotes: "",
    location: "",
    remotePolicy: "",
    startDate: null,
    deadline: null,
    status: "received",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("offer math", () => {
  it("normalizes first-year and annualized totals", () => {
    const comp = offerComp(offer({ bonusTargetPct: 15, equityValueAnnual: 40000, signOn: 20000, relocation: 10000 }));
    expect(comp).toMatchObject({
      targetBonus: 30000,
      bonusBasis: "pct",
      recurringTotal: 270000,
      firstYearTotal: 290000,
      annualizedTotal: 275000,
      relocation: 10000,
      signOnAmortizationYears: 4,
    });
    expect(offerComp(offer({ signOn: 20000 }), 2).annualizedTotal).toBe(210000);
  });

  it("prefers a stated bonus amount over a percentage", () => {
    expect(offerComp(offer({ bonusTargetAmount: 25000, bonusTargetPct: 15 })).targetBonus).toBe(25000);
  });

  it("computes percentage deltas, annual ranges and medians", () => {
    expect(pctDelta(250000, 280000)).toBe(12);
    expect(pctDelta(0, 10)).toBeNull();
    expect(pctDelta(null, 10)).toBeNull();
    const hourly = postingRange({ compensation: { min: 100, max: 120, currency: "usd", period: "hour", source: "description-text", raw: "$100-$120/hr" } });
    expect(hourly).toMatchObject({ currency: "USD", min: 208000, max: 249600, mid: 228800 });
    expect(postingRange({ compensation: { min: 1, max: 2, currency: "USD", period: "unknown", source: "none", raw: "" } })).toBeNull();
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 2, 3])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});

describe("recordOffer and updateOffer", () => {
  it("fills the role from the application and records the offer outcome once", () => {
    const first = recordOffer(workspace, { applicationId, currency: "usd", base: 240000, bonusTargetPct: 10, deadline: "2030-01-15" });
    expect(first.offer).toMatchObject({ company: "Acme Robotics", title: "Senior Security Engineer", currency: "USD", deadline: "2030-01-15" });
    expect(first.outcomeRecorded).toBe("offer");
    expect(first.comp.annualizedTotal).toBe(264000);
    const revised = recordOffer(workspace, { applicationId, currency: "USD", base: 250000 });
    expect(revised.outcomeRecorded).toBeNull();
    expect(listOutcomes(workspace.db, applicationId).map((outcome) => outcome.status)).toEqual(["offer"]);
  });

  it("needs a company without an application, and real dates", () => {
    expect(errorCode(() => recordOffer(workspace, { currency: "USD", base: 100000 }))).toBe("invalid_input");
    expect(errorCode(() => recordOffer(workspace, { company: "Initech", currency: "USD", base: 100000, startDate: "2030-02-30" }))).toBe(
      "invalid_input",
    );
    expect(errorCode(() => recordOffer(workspace, { company: "Initech", currency: "US", base: 100000 }))).toBe("invalid_input");
    expect(recordOffer(workspace, { company: "Initech", currency: "USD", base: 100000 }).offer.applicationId).toBeNull();
  });

  it("warns about inconsistent bonus figures and equity without a value", () => {
    const { warnings } = recordOffer(workspace, {
      company: "Initech",
      currency: "USD",
      base: 200000,
      bonusTargetAmount: 25000,
      bonusTargetPct: 15,
      equityDetails: "0.1% in options",
    });
    expect(warnings.join(" ")).toContain("differs from 15% of base");
    expect(warnings.join(" ")).toContain("no equityValueAnnual");
  });

  it("patches fields, clears with null and lists changes", () => {
    const { offer: created } = recordOffer(workspace, { company: "Initech", currency: "USD", base: 200000, signOn: 15000 });
    const { offer: updated, changed } = updateOffer(workspace, {
      id: created.id,
      base: 210000,
      signOn: null,
      status: "negotiating",
      deadline: "2030-01-20",
    });
    expect(changed.sort()).toEqual(["base", "deadline", "signOn", "status"]);
    expect(updated).toMatchObject({ base: 210000, signOn: null, status: "negotiating", deadline: "2030-01-20", createdAt: created.createdAt });
    expect(listOffers(workspace, { status: "negotiating" })[0]?.comp.annualizedTotal).toBe(210000);
    expect(errorCode(() => updateOffer(workspace, { id: "offer_missing", base: 1 }))).toBe("offer_not_found");
  });
});

describe("compareOffers", () => {
  it("compares totals in the profile currency against targets, the posting and the salary gap", () => {
    const usd = recordOffer(workspace, { applicationId, currency: "USD", base: 250000, bonusTargetPct: 10, equityValueAnnual: 50000, signOn: 20000 }).offer;
    const cad = recordOffer(workspace, { company: "Maple Systems", currency: "CAD", base: 260000 }).offer;
    const eur = recordOffer(workspace, { company: "Euro GmbH", currency: "EUR", base: 100000 }).offer;
    recordOffer(workspace, { company: "Declined Co", currency: "USD", base: 500000, status: "declined" });

    const result = compareOffers(workspace);
    expect(result.currency).toBe("USD");
    const byId = new Map(result.offers.map((row) => [row.offerId, row]));

    const a = byId.get(usd.id);
    expect(a?.comp).toMatchObject({ firstYearTotal: 345000, annualizedTotal: 330000 });
    expect(a?.vsTarget).toEqual({ target: 300000, delta: 30000, pct: 10 });
    expect(a?.vsMinimum?.meets).toBe(true);
    expect(a?.posting).toMatchObject({ min: 220000, max: 280000, mid: 250000, positionInRange: 0.5, baseVsMidPct: 0, baseVsTopPct: -10.7 });
    expect(a?.salaryGap).toMatchObject({
      desired: 300000,
      advertisedMid: 250000,
      advertisedTop: 280000,
      offeredBase: 250000,
      offeredTotal: 330000,
      advertisedMidToOfferedBasePct: 0,
      advertisedTopToOfferedBasePct: -10.7,
      desiredToOfferedTotalPct: 10,
      desiredToAdvertisedTopPct: -6.7,
    });

    const b = byId.get(cad.id);
    expect(b?.inProfileCurrency).toMatchObject({ converted: true, annualizedTotal: 189800 });
    expect(b?.vsMinimum).toEqual({ minimum: 220000, delta: -30200, meets: false });
    expect(b?.posting).toBeNull();
    expect(b?.salaryGap.notes).toContain("No published range on the posting.");

    const e = byId.get(eur.id);
    expect(e?.inProfileCurrency).toBeNull();
    expect(e?.vsTarget).toBeNull();
    expect(e?.salaryGap.notes.join(" ")).toContain("No FX rate for EUR->USD");

    expect(result.ranking.map((row) => row.offerId)).toEqual([usd.id, cad.id]);
    expect(result.aggregates).toEqual({
      offers: 3,
      meetsMinimum: 1,
      atOrAboveTarget: 1,
      advertisedCompared: 1,
      atOrAboveAdvertisedMid: 1,
      meanAdvertisedMidToOfferedBasePct: 0,
      medianAdvertisedMidToOfferedBasePct: 0,
    });
    expect(compareOffers(workspace, { includeClosed: true }).offers).toHaveLength(4);
  });
});

describe("negotiationPlan", () => {
  it("anchors on the posted range top, sets walk-away at the best competing offer and splits the counter", () => {
    const { offer: target } = recordOffer(workspace, { applicationId, currency: "USD", base: 200000, bonusTargetPct: 10, equityValueAnnual: 30000 });
    recordOffer(workspace, { company: "Maple Systems", currency: "USD", base: 260000 });
    const plan = negotiationPlan(workspace, target.id);

    expect(plan.current.annualizedTotal).toBe(250000);
    expect(plan.numbers).toMatchObject({ anchor: 338000, target: 338000, walkAway: 260000 });
    expect(plan.numbers.basis.walkAway).toContain("Maple Systems");
    expect(plan.numbers.basis.anchor).toBe("target plus up to 7%, capped at 25% above the offer unless the target itself is higher");
    expect(plan.recommendedCounter).toMatchObject({ annualizedTotal: 338000, base: 280000, baseIncrease: 80000, additionalAnnualEquity: 0 });
    expect(plan.expectedValue).toMatchObject({ value: 92400, positive: true, breakEvenWithdrawProbability: 1 });
    expect(plan.expectedValue.inputs).toMatchObject({ requestedIncrease: 88000, gainIfImproved: 132000, lossIfWithdrawn: 0 });
    expect(plan.levers.map((lever) => lever.lever)).toEqual(["base", "sign_on", "equity", "level", "start_date", "remote", "immigration"]);
    expect(plan.levers.find((lever) => lever.lever === "immigration")?.current).toContain("TN");
    const risks = plan.risks.join(" ");
    expect(risks).toContain("35% above the offer");
    expect(risks).toContain("competing offer you actually hold");
    expect(plan.talkingPoints[1]).toContain("280,000 USD");
  });

  it("anchors above the target when the market gives no signal, and prices the risk of withdrawal", () => {
    const { offer: solo } = recordOffer(workspace, { company: "Initech", currency: "USD", base: 280000 });
    const plan = negotiationPlan(workspace, solo.id);
    expect(plan.numbers).toMatchObject({ anchor: 321000, target: 300000, walkAway: 220000 });
    expect(plan.recommendedCounter).toMatchObject({ base: 321000, baseIncrease: 41000 });
    expect(plan.expectedValue).toMatchObject({ value: 37450, positive: true, breakEvenWithdrawProbability: 0.154 });
    expect(plan.risks.join(" ")).toContain("No posted range or competing offer");
    expect(plan.levers.some((lever) => lever.lever === "immigration")).toBe(false);

    const cautious = negotiationPlan(workspace, solo.id, { pWithdraw: 0.25 });
    expect(cautious.expectedValue.positive).toBe(false);
    expect(errorCode(() => negotiationPlan(workspace, solo.id, { pImprove: 0.9, pWithdraw: 0.2 }))).toBe("invalid_input");
  });

  it("asks modestly when the offer already beats every signal, and flags an offer below the minimum", () => {
    const rich = recordOffer(workspace, { company: "Initech", currency: "USD", base: 400000 }).offer;
    const generous = negotiationPlan(workspace, rich.id);
    expect(generous.numbers).toMatchObject({ target: 420000, anchor: 449000 });
    expect(generous.numbers.basis.target).toContain("modest 5% ask");
    updateOffer(workspace, { id: rich.id, status: "declined" });

    const low = recordOffer(workspace, { company: "Lowball Inc", currency: "USD", base: 180000, deadline: new Date().toISOString() }).offer;
    const plan = negotiationPlan(workspace, low.id);
    expect(plan.numbers.anchor).toBe(300000);
    const risks = plan.risks.join(" ");
    expect(risks).toContain("below your minimum");
    expect(risks).toContain("ask for more time");
    expect(errorCode(() => negotiationPlan(workspace, "offer_missing"))).toBe("offer_not_found");
  });

  it("adds an immigration lever only for a country the profile lists", () => {
    const remote = seedApplication(workspace.db, { id: "7", job: { country: "unknown" } }).application.id;
    const { offer: remoteOffer } = recordOffer(workspace, { applicationId: remote, currency: "USD", base: 250000 });
    expect(negotiationPlan(workspace, remoteOffer.id).levers.some((lever) => lever.lever === "immigration")).toBe(false);
    expect(contractChecklistFor(workspace, remoteOffer.id).clauses.find((clause) => clause.id === "immigration")?.relevance).toBeNull();

    const sponsored = careerWorkspace(
      careerProfile({
        workAuthorization: {
          citizenships: ["Canada"],
          authorizedIn: ["CA"],
          requiresSponsorshipIn: ["GB"],
          statement: "Canadian citizen; UK roles need sponsorship.",
        },
      }),
    );
    const london = seedApplication(sponsored.db, { id: "8", job: { country: "GB" } }).application.id;
    const { offer: ukOffer } = recordOffer(sponsored, { applicationId: london, currency: "USD", base: 250000 });
    expect(negotiationPlan(sponsored, ukOffer.id).levers.find((lever) => lever.lever === "immigration")?.current).toContain("sponsorship required");
    expect(contractChecklistFor(sponsored, ukOffer.id).clauses.find((clause) => clause.id === "immigration")?.relevance).toContain(
      "sponsorship is needed",
    );
  });

  it("caps the base increase at the posted top and moves the rest to equity or sign-on", () => {
    const capped = seedApplication(workspace.db, {
      id: "6",
      job: { compensation: { min: 200000, max: 210000, currency: "USD", period: "year", source: "ats-structured", raw: "$200k-$210k" } },
    }).application.id;
    const { offer: tight } = recordOffer(workspace, { applicationId: capped, currency: "USD", base: 200000 });
    const plan = negotiationPlan(workspace, tight.id);
    expect(plan.numbers).toMatchObject({ target: 300000, anchor: 300000 });
    expect(plan.recommendedCounter).toMatchObject({ base: 210000, baseIncrease: 10000, additionalAnnualEquity: 90000, signOnAlternative: 90000 });
  });
});

describe("contractChecklist", () => {
  const required = [
    "at_will",
    "non_compete",
    "non_solicit",
    "ip_assignment",
    "confidentiality",
    "arbitration",
    "clawbacks",
    "equity",
    "background_check",
    "immigration",
    "start_and_notice",
  ];

  it("covers every required clause with checks and lawyer questions, as information only", () => {
    const checklist = contractChecklist();
    const ids = checklist.clauses.map((clause) => clause.id);
    expect(ids).toEqual(expect.arrayContaining(required));
    for (const clause of checklist.clauses) {
      expect(clause.whatToCheck.length).toBeGreaterThan(0);
      expect(clause.questionsForLawyer.length).toBeGreaterThan(0);
      expect(clause.tags.length).toBeGreaterThan(0);
      expect(`${clause.whatToCheck.join(" ")} ${clause.questionsForLawyer.join(" ")}`).not.toMatch(/safe to sign|is unenforceable|is illegal/i);
    }
    expect(checklist.disclaimer).toContain("not legal advice");
    expect(checklist.generalQuestionsForLawyer.length).toBeGreaterThan(0);
    expect(checklist.clauses.some((clause) => clause.relevantToThisOffer)).toBe(false);
  });

  it("flags the clauses a stored offer makes relevant", () => {
    const { offer: stored } = recordOffer(workspace, {
      applicationId,
      currency: "USD",
      base: 220000,
      signOn: 25000,
      equityDetails: "RSUs vesting over 4 years with a 1-year cliff",
      startDate: "2030-02-01",
    });
    const checklist = contractChecklistFor(workspace, stored.id);
    const byId = new Map(checklist.clauses.map((clause) => [clause.id, clause]));
    expect(byId.get("clawbacks")?.relevance).toContain("25,000 USD sign-on bonus");
    expect(byId.get("equity")?.relevantToThisOffer).toBe(true);
    expect(byId.get("start_and_notice")?.relevance).toContain("2030-02-01");
    expect(byId.get("immigration")?.relevance).toContain("TN");
    expect(byId.get("at_will")?.relevantToThisOffer).toBe(false);
    expect(errorCode(() => contractChecklistFor(workspace, "offer_missing"))).toBe("offer_not_found");
  });
});
