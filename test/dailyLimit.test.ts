import { describe, expect, it } from "vitest";
import { SubmissionPolicySchema } from "../src/domain/campaign.js";

describe("daily submission limit configuration", () => {
  it("keeps the existing finite default", () => {
    expect(SubmissionPolicySchema.parse({}).dailyLimit).toBe(25);
  });

  it("preserves an explicitly configured positive limit", () => {
    expect(SubmissionPolicySchema.parse({ dailyLimit: 15 }).dailyLimit).toBe(15);
  });

  it("uses JSON null to explicitly disable the daily cap", () => {
    const policy = SubmissionPolicySchema.parse({ dailyLimit: null });
    expect(policy.dailyLimit).toBeNull();
    expect(JSON.parse(JSON.stringify(policy)).dailyLimit).toBeNull();
  });

  it.each([0, -1, 1.5, Infinity, NaN, "unlimited", "100"])(
    "rejects an invalid daily limit rather than silently disabling it: %s",
    (dailyLimit) => {
      expect(SubmissionPolicySchema.safeParse({ dailyLimit }).success).toBe(false);
    },
  );
});
