import { beforeEach, describe, expect, it } from "vitest";
import type { Workspace } from "../src/config/load.js";
import { campaignAnalytics, normalizeSince } from "../src/analytics/campaign.js";
import { calibrate } from "../src/analytics/calibration.js";
import { loadApplicationRows, submittedCohort } from "../src/analytics/dataset.js";
import { averageRanks, isoWeek, spearman } from "../src/analytics/stats.js";
import { makeWorkspace, seedApplication, seedOutcome, seedRejectedPosting } from "./afterApplyFixtures.js";

const NOW = new Date("2026-10-20T00:00:00.000Z");
let workspace: Workspace;

function seedCampaign(): void {
  const db = workspace.db;
  seedApplication(db, {
    id: "app1", company: "Acme", title: "Staff Engineer", tier: "A", score: 92, companyTier: "A",
    submittedAt: "2026-09-01T00:00:00.000Z", description: "Experience with Kubernetes, Terraform and Python.",
  });
  seedOutcome(db, "app1", "acknowledged", "2026-09-02T00:00:00.000Z");
  seedOutcome(db, "app1", "recruiter_screen", "2026-09-06T00:00:00.000Z");
  seedOutcome(db, "app1", "interview", "2026-09-12T00:00:00.000Z");
  seedOutcome(db, "app1", "offer", "2026-09-20T00:00:00.000Z");
  seedApplication(db, {
    id: "app2", company: "Beta", title: "Platform Engineer", tier: "A", score: 88,
    submittedAt: "2026-09-01T00:00:00.000Z", description: "Kubernetes and Go, distributed systems.",
  });
  seedOutcome(db, "app2", "acknowledged", "2026-09-03T00:00:00.000Z");
  seedOutcome(db, "app2", "recruiter_screen", "2026-09-08T00:00:00.000Z");
  seedOutcome(db, "app2", "rejected", "2026-09-15T00:00:00.000Z");
  seedApplication(db, {
    id: "app3", company: "Gamma", title: "Backend Engineer", ats: "workday", tier: "B", score: 75, trackId: "software",
    submittedAt: "2026-09-02T00:00:00.000Z", description: "Python, AWS, Terraform.",
  });
  seedOutcome(db, "app3", "rejected", "2026-09-11T00:00:00.000Z");
  seedApplication(db, {
    id: "app4", company: "Delta", title: "Backend Engineer", ats: "workday", tier: "B", score: 72, trackId: "software",
    submittedAt: "2026-09-02T00:00:00.000Z", submissionMode: "manual",
  });
  seedOutcome(db, "app4", "acknowledged", "2026-09-05T00:00:00.000Z");
  seedApplication(db, {
    id: "app5", company: "Epsilon", title: "Engineer", ats: "ashby", tier: "C", score: 65, trackId: "software", companyTier: "C",
    submittedAt: "2026-08-01T00:00:00.000Z",
  });
  seedOutcome(db, "app5", "ghosted", "2026-09-20T00:00:00.000Z");
  seedApplication(db, {
    id: "app6", company: "Zeta", title: "Engineer", ats: "ashby", tier: "C", score: 68, trackId: "software", companyTier: "C",
    submittedAt: "2026-10-15T00:00:00.000Z",
  });
  seedApplication(db, { id: "app7", company: "Eta", title: "Engineer", tier: "B", score: 80, submittedAt: "2026-09-03T00:00:00.000Z" });
  seedOutcome(db, "app7", "withdrawn", "2026-09-10T00:00:00.000Z");
  seedApplication(db, { id: "app8", company: "Theta", title: "Engineer", tier: "B", status: "drafted", submittedAt: null, createdAt: "2026-09-05T00:00:00.000Z" });
  seedApplication(db, { id: "app9", company: "Iota", title: "Engineer", tier: "B", status: "approved", submittedAt: null, createdAt: "2026-09-05T00:00:00.000Z" });
  seedRejectedPosting(db, "r1", "seniority-rejected", "title says junior");
  seedRejectedPosting(db, "r2", "seniority-rejected", "title says intern");
  seedRejectedPosting(db, "r3", "location-not-allowed", "London, UK is outside the allowed locations", "ashby");
  seedRejectedPosting(db, "r4", "stale-posting", "posted 120 days ago");
}

/** Every rate anywhere in the report must carry the sample it was taken over. */
function ratesWithoutSample(value: unknown, path = "$"): string[] {
  if (Array.isArray(value)) return value.flatMap((entry, index) => ratesWithoutSample(entry, `${path}[${index}]`));
  if (value === null || typeof value !== "object") return [];
  const record = value as Record<string, unknown>;
  const own = "rate" in record && typeof record.n !== "number" ? [path] : [];
  return [...own, ...Object.entries(record).flatMap(([key, entry]) => ratesWithoutSample(entry, `${path}.${key}`))];
}

beforeEach(() => {
  workspace = makeWorkspace();
  seedCampaign();
});

describe("campaign analytics", () => {
  it("builds the funnel with cumulative stages", () => {
    const { funnel } = campaignAnalytics(workspace, { now: NOW });
    expect(funnel).toMatchObject({
      discovered: 13,
      evaluated: 13,
      accepted: { total: 9, byTier: { A: 2, B: 5, C: 2 } },
      prepared: 9,
      approved: 8,
      submitted: 7,
      acknowledged: 3,
      replied: 3,
      screenOrAssessment: 2,
      interview: 1,
      offer: 1,
      rejected: 2,
      ghosted: 1,
      withdrawn: 1,
      inFlight: 1,
    });
    const stage = (name: string) => funnel.stages.find((entry) => entry.stage === name);
    expect(stage("acknowledged")).toMatchObject({ count: 3, fromPrevious: { n: 7, count: 3, rate: 0.429 }, fromSubmitted: { n: 7, count: 3 } });
    expect(stage("interview")).toMatchObject({ fromPrevious: { n: 2, count: 1, rate: 0.5 } });
    expect(stage("discovered")?.fromPrevious).toBeNull();
    expect(stage("submitted")?.fromSubmitted).toBeNull();
  });

  it("slices conversion by ATS channel and score band, with n on every rate", () => {
    const report = campaignAnalytics(workspace, { now: NOW });
    expect(report.conversion.ats.map((group) => [group.key, group.submitted])).toEqual([
      ["greenhouse", 3],
      ["ashby", 2],
      ["workday", 2],
    ]);
    expect(report.conversion.ats[0]).toMatchObject({
      replied: { n: 3, count: 2, rate: 0.667 },
      advanced: { n: 3, count: 2 },
      offered: { n: 3, count: 1 },
      rejected: { n: 3, count: 1 },
      inFlight: 0,
    });
    expect(report.conversion.ats[1]).toMatchObject({ key: "ashby", replied: { count: 0 }, inFlight: 1 });
    expect(report.conversion.scoreBand.map((group) => [group.key, group.submitted])).toEqual([
      ["<70", 2],
      ["70-79", 2],
      ["80-89", 2],
      ["90+", 1],
    ]);
    expect(report.conversion.submissionMode.map((group) => group.key).sort()).toEqual(["auto", "manual"]);
    expect(report.conversion.weekSubmitted.map((group) => group.key)).toEqual(["2026-W31", "2026-W36", "2026-W42"]);
    expect(ratesWithoutSample(report)).toEqual([]);
  });

  it("measures reply times from submission", () => {
    const { responseTimes, velocity } = campaignAnalytics(workspace, { now: NOW });
    expect(responseTimes.firstReply).toMatchObject({ n: 4, median: 2.5, p75: 4.5 });
    const byKind = Object.fromEntries(responseTimes.byKind.map((entry) => [entry.kind, entry]));
    expect(byKind.acknowledged).toMatchObject({ n: 3, median: 2 });
    expect(byKind.recruiter_screen).toMatchObject({ n: 2, median: 6 });
    expect(byKind.rejected).toMatchObject({ n: 2, median: 11.5 });
    expect(velocity.weeks).toHaveLength(12);
    expect(velocity.weeks.find((week) => week.week === "2026-W36")).toMatchObject({ submitted: 5, firstReplies: 3 });
    expect(velocity).toMatchObject({ submittedLast7Days: 1, submittedLast30Days: 1 });
    expect(velocity.stageHops.find((hop) => hop.from === "screen or assessment")).toMatchObject({ n: 1, median: 6 });
  });

  it("finds where applications are lost", () => {
    const { rejectionPatterns, discards } = campaignAnalytics(workspace, { now: NOW });
    expect(rejectionPatterns.total).toBe(2);
    expect(rejectionPatterns.byStage).toEqual([
      { stage: "before any reply", count: 1, share: { n: 2, count: 1, rate: 0.5 } },
      { stage: "after screen", count: 1, share: { n: 2, count: 1, rate: 0.5 } },
    ]);
    expect(rejectionPatterns.highestRejectionRates[0]).toMatchObject({ dimension: "submissionMode", key: "auto", rejected: { n: 6, count: 2 } });
    expect(rejectionPatterns.gateRules[0]).toEqual({ rule: "seniority-rejected", count: 2, share: { n: 4, count: 2, rate: 0.5 } });
    expect(discards.totals).toEqual({ evaluated: 13, accepted: 9, review: 0, rejected: 4 });
    expect(discards.byRule.find((rule) => rule.rule === "seniority-rejected")?.examples.sort()).toEqual(["title says intern", "title says junior"]);
    expect(discards.byAts.find((entry) => entry.ats === "ashby")?.rejected).toEqual({ n: 3, count: 1, rate: 0.333 });
  });

  it("withholds calibration on a small sample and says why", () => {
    const { calibration } = campaignAnalytics(workspace, { now: NOW });
    expect(calibration.insufficientData).toBe(true);
    expect(calibration.rankCorrelation.rho).toBeNull();
    expect(calibration.sample).toMatchObject({ resolved: 5, inFlight: 1, excludedWithdrawn: 1 });
    expect(calibration.reason).toContain("only 5 resolved");
    expect(calibration.reading).toContain("Not enough evidence");
  });

  it("reports skill gaps the profile does not cover, and its strengths", () => {
    const { skillGaps } = campaignAnalytics(workspace, { now: NOW });
    expect(skillGaps.postingsAnalyzed).toBe(9);
    expect(skillGaps.gaps.slice(0, 2).map((gap) => gap.term).sort()).toEqual(["Kubernetes", "Terraform"]);
    expect(skillGaps.gaps.map((gap) => gap.term)).toEqual(expect.arrayContaining(["Go", "AWS", "distributed systems"]));
    expect(skillGaps.gaps.map((gap) => gap.term)).not.toContain("Python");
    expect(skillGaps.strengths).toContainEqual({ term: "Python", postings: { n: 9, count: 2, rate: 0.222 } });
    expect(skillGaps.gaps[0]?.trend).toBe("insufficient-data");
  });

  it("limits every count to activity since a date", () => {
    const report = campaignAnalytics(workspace, { now: NOW, since: "2026-09-02" });
    expect(report.since).toBe("2026-09-02T00:00:00.000Z");
    expect(report.funnel.submitted).toBe(4);
    expect(report.funnel.prepared).toBe(2);
    expect(() => normalizeSince("next week")).toThrow(/since must be a date/);
  });
});

describe("calibration on a sample large enough to judge", () => {
  it("finds that higher scores go further", () => {
    const fresh = makeWorkspace();
    for (let index = 0; index < 40; index += 1) {
      const score = 60 + index;
      const id = `cal${index}`;
      seedApplication(fresh.db, { id, company: `Company ${index}`, title: "Engineer", score, submittedAt: "2026-07-01T00:00:00.000Z" });
      if (score >= 88) seedOutcome(fresh.db, id, "interview", "2026-07-10T00:00:00.000Z");
      else if (score >= 78) seedOutcome(fresh.db, id, "recruiter_screen", "2026-07-08T00:00:00.000Z");
      else if (score >= 70) seedOutcome(fresh.db, id, "rejected", "2026-07-05T00:00:00.000Z");
    }
    const cohort = submittedCohort(loadApplicationRows(fresh.db), null);
    const result = calibrate(cohort, NOW, 45);
    expect(result.insufficientData).toBe(false);
    expect(result.rankCorrelation.n).toBe(40);
    expect(result.rankCorrelation.rho).toBeGreaterThan(0.8);
    expect(result.bands.find((band) => band.band === "90+")?.advanced).toEqual({ n: 10, count: 10, rate: 1 });
    expect(result.bands.find((band) => band.band === "<70")?.replied).toEqual({ n: 10, count: 0, rate: 0 });
    expect(result.reading).toContain("a strong relationship");
  });
});

describe("skill gap trends", () => {
  it("compares the recent window with the one before it once both are large enough", () => {
    const fresh = makeWorkspace();
    for (let index = 0; index < 40; index += 1) {
      const recent = index < 20;
      const description = recent ? "Kubernetes and Terraform on AWS." : "Kafka and Terraform on AWS. Some Kubernetes.".slice(0, index % 2 === 0 ? 31 : 43);
      seedApplication(fresh.db, {
        id: `post${index}`,
        company: `Company ${index}`,
        title: "Engineer",
        status: "drafted",
        submittedAt: null,
        description,
        firstSeenAt: recent ? "2026-10-10T00:00:00.000Z" : "2026-08-01T00:00:00.000Z",
      });
    }
    const { skillGaps } = campaignAnalytics(fresh, { now: NOW });
    const trend = Object.fromEntries(skillGaps.gaps.map((gap) => [gap.term, gap.trend]));
    expect(trend).toMatchObject({ Kubernetes: "rising", Kafka: "falling", Terraform: "steady", AWS: "steady" });
    expect(skillGaps.gaps.find((gap) => gap.term === "Kubernetes")).toMatchObject({
      recent: { n: 20, count: 20, rate: 1 },
      prior: { n: 20, count: 10, rate: 0.5 },
    });
  });
});

describe("statistics helpers", () => {
  it("ranks ties by their average and correlates by rank", () => {
    expect(averageRanks([10, 20, 20, 30])).toEqual([1, 2.5, 2.5, 4]);
    expect(spearman([1, 2, 3, 4], [10, 20, 30, 40])).toBe(1);
    expect(spearman([1, 2, 3, 4], [4, 3, 2, 1])).toBe(-1);
    expect(spearman([1, 2, 3], [5, 5, 5])).toBeNull();
  });

  it("names ISO weeks across a year boundary", () => {
    expect(isoWeek("2026-01-01T12:00:00Z")).toBe("2026-W01");
    expect(isoWeek("2027-01-01T12:00:00Z")).toBe("2026-W53");
    expect(isoWeek("2026-10-20T00:00:00Z")).toBe("2026-W43");
  });
});
