import { afterEach, describe, expect, it } from "vitest";
import { recordLiveness } from "../src/db/repositories/liveness.js";
import { assessLegitimacy, legitimacyTier, payTransparencyJurisdiction, type LegitimacySignal } from "../src/hygiene/legitimacy.js";
import { legitimacyFor } from "../src/hygiene/postingSignals.js";
import { makeJob } from "./factories.js";
import { makeWorkspace, setSeen, storeJobs, type TestWorkspace } from "./hygieneFixtures.js";

const now = new Date("2026-11-01T00:00:00Z");
const longText = `${"We build reliable payment infrastructure in Python and Go on AWS. ".repeat(12)}`;
const ids = (signals: readonly LegitimacySignal[]) => signals.map((signal) => signal.id);

describe("assessLegitimacy", () => {
  it("rates a fresh, live, well-described posting with published pay as high confidence", () => {
    const job = makeJob({ descriptionText: longText, postedAt: "2026-10-28T00:00:00Z" });
    const result = assessLegitimacy(job, { now, liveness: { status: "open", via: "api", detail: "live" } });
    expect(result.tier).toBe("high");
    expect(ids(result.signals)).toEqual(expect.arrayContaining(["liveness-open", "fresh-posting", "pay-published"]));
  });

  it("observes age, absence, reposts and closure", () => {
    const job = makeJob({ descriptionText: longText, postedAt: "2026-07-01T00:00:00Z" });
    const result = assessLegitimacy(job, {
      now,
      liveness: { status: "closed", via: "api", detail: "404" },
      listing: { status: "absent", lastSeenAt: "2026-09-01", boardFetchedAt: "2026-10-30", detail: "missing from the latest fetch" },
      repost: {
        company: "Test Corp", ats: "greenhouse", board: "testcorp", titleIdentity: "x", sampleTitle: "Senior Security Engineer",
        postings: 3, distinctDates: 3, earliestSeenAt: "2026-07-01", latestSeenAt: "2026-10-01", spanDays: 92, reposted: true, members: [],
      },
    });
    expect(result.tier).toBe("suspicious");
    expect(ids(result.signals)).toEqual(expect.arrayContaining(["liveness-closed", "absent-from-listing", "repost-cluster", "stale-posting"]));
    expect(result.signals.find((signal) => signal.id === "stale-posting")?.context).toMatch(/evergreen/);
  });

  it("calls a closed posting closed rather than describing it as a scam", () => {
    const job = makeJob({ descriptionText: longText, postedAt: "2026-10-28T00:00:00Z" });
    const result = assessLegitimacy(job, {
      now,
      liveness: { status: "closed", via: "api", detail: "404" },
      listing: { status: "absent", lastSeenAt: "2026-10-28", boardFetchedAt: "2026-10-30", detail: "missing from the latest fetch" },
    });
    expect(result.tier).toBe("suspicious");
    expect(result.summary).toMatch(/^Closed: /);
    expect(result.summary).not.toMatch(/scam/);
  });

  it("does not claim several indicators when one strong signal decides the tier", () => {
    const job = makeJob({ descriptionText: `${longText}\nCandidates must pay a $200 training fee before the start date.`, postedAt: "2026-10-28T00:00:00Z" });
    const result = assessLegitimacy(job, { now, liveness: { status: "open", via: "api", detail: "live" } });
    expect(result.tier).toBe("suspicious");
    expect(result.summary).not.toMatch(/several/);
  });

  it("quotes agency, contract, commission, fee and AI-screening language", () => {
    const text = [
      longText,
      "We are recruiting on behalf of our client, a fintech firm.",
      "This is a 6-month contract role (W2 contract).",
      "Compensation is commission only.",
      "Candidates must pay a $200 training fee before the start date.",
      "We use AI screening tools to review applications.",
    ].join("\n");
    const result = assessLegitimacy(makeJob({ descriptionText: text }), { now });
    expect(ids(result.signals)).toEqual(
      expect.arrayContaining(["staffing-agency", "contract-terms", "commission-only", "candidate-paid-fees", "ai-screening-disclosed"]),
    );
    expect(result.signals.find((signal) => signal.id === "candidate-paid-fees")).toMatchObject({ severity: "high" });
    expect(result.tier).toBe("suspicious");
  });

  it("does not read a no-fee promise as a fee request", () => {
    const text = `${longText}\nWe will never ask you to pay a training fee or buy equipment.`;
    expect(ids(assessLegitimacy(makeJob({ descriptionText: text }), { now }).signals)).not.toContain("candidate-paid-fees");
  });

  it("observes wide ranges and missing pay in transparency jurisdictions", () => {
    const wide = makeJob({
      descriptionText: longText,
      compensation: { min: 100000, max: 260000, currency: "USD", period: "year", source: "ats-structured", raw: "$100k-$260k" },
    });
    expect(ids(assessLegitimacy(wide, { now }).signals)).toContain("wide-pay-range");
    const unpaid = makeJob({ descriptionText: longText, compensation: null, locationsRaw: ["Seattle, WA"], locationClass: "us-other" });
    expect(assessLegitimacy(unpaid, { now }).signals.find((signal) => signal.id === "pay-missing-in-transparency-jurisdiction")?.observation).toContain("WA");
  });

  it("observes very short and vague descriptions", () => {
    expect(ids(assessLegitimacy(makeJob({ descriptionText: "Great role. Apply now." }), { now }).signals)).toContain("very-short-description");
    const vague = "We are looking for a motivated team player to join our growing company and help us succeed. ".repeat(8);
    expect(ids(assessLegitimacy(makeJob({ descriptionText: vague }), { now }).signals)).toContain("vague-description");
  });

  it("summarises severities into tiers", () => {
    const signal = (severity: LegitimacySignal["severity"]): LegitimacySignal => ({ id: severity, severity, observation: "", evidence: "" });
    expect(legitimacyTier([signal("positive"), signal("info"), signal("low")])).toBe("high");
    expect(legitimacyTier([signal("low"), signal("low")])).toBe("caution");
    expect(legitimacyTier([signal("medium")])).toBe("caution");
    expect(legitimacyTier([signal("medium"), signal("medium")])).toBe("suspicious");
    expect(legitimacyTier([signal("high")])).toBe("suspicious");
  });
});

describe("payTransparencyJurisdiction", () => {
  it("reads state codes, names, major cities and remote-US postings", () => {
    const base = { country: "US", locationClass: "us-other" as const };
    expect(payTransparencyJurisdiction({ ...base, locationsRaw: ["US, CA, Santa Clara"] })).toBe("CA");
    expect(payTransparencyJurisdiction({ ...base, locationsRaw: ["Washington, DC"] })).toBe("DC");
    expect(payTransparencyJurisdiction({ ...base, locationsRaw: ["Denver"] })).toBe("CO");
    expect(payTransparencyJurisdiction({ ...base, locationsRaw: ["Austin, TX"] })).toBeNull();
    expect(payTransparencyJurisdiction({ ...base, locationClass: "remote-us", locationsRaw: ["Remote"] })).toMatch(/remote US/);
    expect(payTransparencyJurisdiction({ country: "CA", locationClass: "canada", locationsRaw: ["Toronto, ON"] })).toBeNull();
  });
});

describe("legitimacyFor", () => {
  let workspace: TestWorkspace;
  afterEach(() => workspace.cleanup());

  it("gathers the stored liveness, listing and repost context without the network", () => {
    workspace = makeWorkspace();
    const job = makeJob({ id: "job_ctx", descriptionText: longText });
    storeJobs(workspace, [job]);
    setSeen(workspace, job.id, "2026-10-01T00:00:00.000Z");
    recordLiveness(workspace.db, { jobId: job.id, status: "open", via: "api", detail: "live", checkedAt: now.toISOString() });
    const result = legitimacyFor(workspace, job, now);
    expect(result.liveness?.status).toBe("open");
    expect(result.listing.status).toBe("unknown");
    expect(result.repost).toMatchObject({ postings: 1, reposted: false });
    expect(ids(result.signals)).toContain("liveness-open");
  });
});
