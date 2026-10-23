import { describe, expect, it } from "vitest";
import { mergeSummaries, type PipelineSummary } from "../src/pipeline.js";

function summary(overrides: Partial<PipelineSummary>): PipelineSummary {
  return { evaluated: 0, accepted: 0, review: 0, rejected: 0, duplicates: 0, topRejectionRules: [], ...overrides };
}

describe("mergeSummaries", () => {
  it("adds up per-board summaries, including rejection rules seen on several boards", () => {
    const merged = mergeSummaries([
      summary({ evaluated: 5, accepted: 2, rejected: 3, topRejectionRules: [{ rule: "title-excluded", count: 2 }, { rule: "stale-posting", count: 1 }] }),
      summary({ evaluated: 4, review: 1, rejected: 2, duplicates: 1, topRejectionRules: [{ rule: "stale-posting", count: 2 }] }),
    ]);

    expect(merged).toEqual({
      evaluated: 9,
      accepted: 2,
      review: 1,
      rejected: 5,
      duplicates: 1,
      topRejectionRules: [
        { rule: "stale-posting", count: 3 },
        { rule: "title-excluded", count: 2 },
      ],
    });
  });

  it("is empty when no board returned postings", () => {
    expect(mergeSummaries([])).toEqual(summary({}));
  });
});
