import { describe, expect, it } from "vitest";
import { openDatabase } from "../src/db/database.js";
import { listQueue, saveEvaluation, upsertJobs } from "../src/db/repositories/jobs.js";
import { annualize, checkCompensationFloor } from "../src/ranking/compensation.js";
import { evaluateGates } from "../src/ranking/gates.js";
import { makeCampaign, makeJob, makeProfile } from "./factories.js";

const pay = { min: 220000, max: 300000, currency: "USD", period: "unknown" as const, source: "ats-structured" as const, raw: "220000-300000" };

describe("new-source compensation boundary", () => {
  it("does not annualize an unknown period", () => {
    expect(annualize(300000, "unknown")).toBeNull();
    expect(checkCompensationFloor(pay, "US", makeCampaign().compensation)).toMatchObject({
      status: "unknown", annualizedMax: null, campaignCurrencyMax: null,
    });
  });

  it("distinguishes undisclosed compensation from published pay with unknown units", () => {
    const context = { campaign: makeCampaign(), profile: makeProfile() };
    expect(evaluateGates(makeJob({ ats: "smartrecruiters", compensation: pay }), context).rule)
      .toBe("compensation-period-unknown");
    expect(evaluateGates(makeJob({ ats: "smartrecruiters", compensation: null }), context).passed).toBe(true);
  });

  it("does not use cached acceptance to let unknown salary units meet a filtered threshold", () => {
    const db = openDatabase(":memory:");
    try {
      const job = makeJob({ ats: "recruitee", compensation: pay });
      upsertJobs(db, [job]);
      saveEvaluation(db, {
        jobId: job.id, decision: "accept", gate: { passed: true, rule: null, reason: "old evaluation", evidence: "" },
        trackId: "ai-security", score: 90, tier: "A", components: [], flags: [], evaluatedAt: new Date().toISOString(),
      });
      expect(listQueue(db, { minCompensation: 250000, allowUnknownCompensation: true })).toEqual([]);
    } finally {
      db.close();
    }
  });
});
