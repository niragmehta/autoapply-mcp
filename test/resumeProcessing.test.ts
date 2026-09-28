import { describe, expect, it, vi } from "vitest";
import { waitForResumeProcessing } from "../src/submission/resumeProcessing.js";

describe("waiting for native resume processing", () => {
  it("leaves forms without an active parser unchanged", async () => {
    const indicator = { isVisible: vi.fn().mockResolvedValue(false), waitFor: vi.fn() };
    await waitForResumeProcessing(indicator, 45000);
    expect(indicator.waitFor).not.toHaveBeenCalled();
  });

  it("waits for the active parser to finish before returning to field filling", async () => {
    const indicator = { isVisible: vi.fn().mockResolvedValue(true), waitFor: vi.fn().mockResolvedValue(undefined) };
    await waitForResumeProcessing(indicator, 45000);
    expect(indicator.waitFor).toHaveBeenCalledWith({ state: "hidden", timeout: 45000 });
  });

  it("surfaces a processing timeout instead of filling fields that can be overwritten", async () => {
    const indicator = {
      isVisible: vi.fn().mockResolvedValue(true),
      waitFor: vi.fn().mockRejectedValue(new Error("processing timeout")),
    };
    await expect(waitForResumeProcessing(indicator, 45000)).rejects.toThrow(/resume analysis did not finish/i);
  });
});
