import { describe, expect, it } from "vitest";
import { detectTrack } from "../src/evaluation/archetype.js";
import { assessLevel } from "../src/evaluation/level.js";
import { buildScorecard, scoreToFive, verdictFor, type ScorecardInput } from "../src/evaluation/scorecard.js";
import { assessExperience } from "../src/hygiene/experienceYears.js";
import { assessLegitimacy } from "../src/hygiene/legitimacy.js";
import { evaluateJob } from "../src/pipeline.js";
import { makeCampaign, makeJob, makeProfile } from "./factories.js";

const campaign = makeCampaign();
const profile = makeProfile();
const thresholds = { tierA: 85, tierB: 75, tierC: 68 };
const longText = `${makeJob().descriptionText} ${"We secure AI systems with policy guardrails and threat modeling. ".repeat(10)}`;

describe("scoreToFive and verdict bands", () => {
  it("lands the campaign's tier thresholds on the verdict bands", () => {
    expect(scoreToFive(85, thresholds)).toBe(4.5);
    expect(scoreToFive(100, thresholds)).toBe(5);
    expect(scoreToFive(75, thresholds)).toBe(4.0);
    expect(scoreToFive(68, thresholds)).toBe(3.5);
    expect(scoreToFive(0, thresholds)).toBe(1);
    expect(scoreToFive(34, thresholds)).toBeCloseTo(2.25, 5);
  });

  it("maps scores to verdicts at the band edges", () => {
    expect(verdictFor(4.5)).toBe("strong-apply");
    expect(verdictFor(4.4)).toBe("apply");
    expect(verdictFor(4.0)).toBe("apply");
    expect(verdictFor(3.9)).toBe("apply-with-reason");
    expect(verdictFor(3.5)).toBe("apply-with-reason");
    expect(verdictFor(3.4)).toBe("do-not-apply");
  });
});

describe("detectTrack", () => {
  it("matches a target track by title and grades depth by keywords", () => {
    const track = detectTrack(makeJob({ descriptionText: longText }), campaign);
    expect(track).toMatchObject({ trackId: "ai-security", target: true, northStar: 5 });
  });

  it("reports no target honestly instead of the nearest label", () => {
    const track = detectTrack(makeJob({ title: "Account Executive", descriptionText: "Sell our product to enterprises." }), campaign);
    expect(track).toMatchObject({ target: false, northStar: 1, trackId: null, label: "Not a target - no close match" });
    const adjacent = detectTrack(makeJob({ title: "Product Manager", descriptionText: "Own the ai security roadmap and threat modeling." }), campaign);
    expect(adjacent).toMatchObject({ target: false, northStar: 3 });
    expect(adjacent.label).toMatch(/closest track: AI Security/);
  });
});

describe("assessLevel", () => {
  const now = new Date("2026-11-01T00:00:00Z");
  const level = (title: string, text: string, candidateYears: number) =>
    assessLevel(makeJob({ title, descriptionText: text }), makeCampaign({ hygiene: { experience: { candidateYears } } }),
      assessExperience({ descriptionText: text }, makeCampaign({ hygiene: { experience: { candidateYears } } }), profile, now));

  it("reads stretch, at-level and below-level", () => {
    expect(level("Staff Security Engineer", "Requirements: 10+ years of experience.", 6).fit).toBe("stretch");
    expect(level("Senior Security Engineer", "Requirements: 5+ years of experience.", 6).fit).toBe("at-level");
    expect(level("Security Engineer", "Requirements: 2+ years of experience.", 9).fit).toBe("below-level");
    const scoped = level("Senior Engineer", "You will set the technical direction across multiple teams.", 6);
    expect(scoped.postingLevel).toBe("staff");
    expect(scoped.advice.length).toBeGreaterThan(0);
  });
});

function input(overrides: Partial<ScorecardInput> = {}): ScorecardInput {
  const job = makeJob({ descriptionText: longText });
  const evaluation = evaluateJob(job, campaign, profile);
  return {
    job,
    evaluation,
    campaign,
    profile,
    requirements: [
      { importance: "required", weightSource: "structure", tier: "direct", text: "Python" },
      { importance: "required", weightSource: "structure", tier: "direct", text: "Threat modeling" },
      { importance: "required", weightSource: "jd-wording", tier: "adjacent", text: "AWS" },
      { importance: "preferred", weightSource: "structure", tier: "none", text: "Rust" },
    ],
    track: detectTrack(job, campaign),
    legitimacy: assessLegitimacy(job, {}),
    liveness: { status: "open", via: "api", detail: "live" },
    experience: assessExperience(job, campaign, profile),
    ...overrides,
  };
}

describe("buildScorecard", () => {
  it("derives a 1-5 score with per-dimension evidence and a verdict in its band", () => {
    const card = buildScorecard(input());
    expect(card.dimensions.map((dimension) => dimension.dimension)).toEqual(["cvMatch", "northStar", "compensation", "redFlags", "culture"]);
    expect(card.dimensions.find((dimension) => dimension.dimension === "culture")).toMatchObject({ score: null, status: "unknown" });
    expect(card.dimensions.find((dimension) => dimension.dimension === "cvMatch")?.score).toBeCloseTo(3.9, 1);
    expect(card.verdict).toBe(verdictFor(card.globalScore));
    expect(card.adjustments[0]).toMatch(/^base /);
    expect(card.confidence).toBe("medium");
  });

  it("scores compensation against the candidate's targets and leaves unpublished pay unknown", () => {
    const rich = input({ job: makeJob({ descriptionText: longText, compensation: { min: 280000, max: 320000, currency: "USD", period: "year", source: "ats-structured", raw: "$280k-$320k" } }) });
    expect(buildScorecard(rich).dimensions.find((dimension) => dimension.dimension === "compensation")).toMatchObject({ score: 5, status: "supported" });
    const between = input({ job: makeJob({ descriptionText: longText, compensation: { min: 200000, max: 250000, currency: "USD", period: "year", source: "description-text", raw: "$200k-$250k" } }) });
    expect(buildScorecard(between).dimensions.find((dimension) => dimension.dimension === "compensation")).toMatchObject({ score: 4, status: "partial" });
    const card = buildScorecard(input({ job: makeJob({ descriptionText: longText, compensation: null }) }));
    expect(card.dimensions.find((dimension) => dimension.dimension === "compensation")).toMatchObject({ score: null, status: "unknown" });
    expect(card.confidence).toBe("low");
  });

  it("caps a role that matches no target and zeroes a closed or gated posting", () => {
    const job = makeJob({ title: "Account Executive", descriptionText: longText });
    const offTarget = buildScorecard(input({ job, track: detectTrack({ title: "Account Executive", descriptionText: "Sell things." }, campaign) }));
    expect(offTarget.globalScore).toBeLessThanOrEqual(3.4);
    expect(offTarget.verdict).toBe("do-not-apply");
    expect(buildScorecard(input({ liveness: { status: "closed", via: "api", detail: "404" } })).globalScore).toBe(1);
    const intern = makeJob({ title: "Security Intern", descriptionText: longText });
    const gated = buildScorecard(input({ job: intern, evaluation: evaluateJob(intern, campaign, profile) }));
    expect(gated).toMatchObject({ globalScore: 1, verdict: "do-not-apply" });
    expect(gated.dimensions.find((dimension) => dimension.dimension === "redFlags")?.score).toBe(1);
  });

  it("reports an unknown CV match when no requirements were read", () => {
    const card = buildScorecard(input({ requirements: [] }));
    expect(card.dimensions.find((dimension) => dimension.dimension === "cvMatch")?.status).toBe("unknown");
    expect(card.confidence).toBe("low");
    expect(card.verificationPriorities.length).toBeGreaterThan(0);
  });
});
