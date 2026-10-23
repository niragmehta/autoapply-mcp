import { describe, expect, it, vi } from "vitest";
import { checkOption } from "../src/submission/browser.js";

type Fake = Parameters<typeof checkOption>[0];

function fakeBox(options: { check: Array<"ok" | "fail">; checked: boolean }) {
  const rowClick = vi.fn(async () => undefined);
  const check = vi.fn(async () => {
    if (options.check.shift() === "fail") throw new Error("Timeout 4000ms exceeded");
  });
  const box = {
    check,
    isChecked: vi.fn(async () => options.checked),
    locator: () => ({ first: () => ({ click: rowClick }) }),
  } as unknown as Fake;
  return { box, check, rowClick };
}

describe("checkOption", () => {
  it("stops at the first check that works", async () => {
    const { box, check, rowClick } = fakeBox({ check: ["ok"], checked: false });

    await checkOption(box);

    expect(check).toHaveBeenCalledTimes(1);
    expect(rowClick).not.toHaveBeenCalled();
  });

  it("clicks the option row when a styled box defeats both checks", async () => {
    // Cboe's Workday consent box hid its input, and a bare check() waited 30s.
    const { box, rowClick } = fakeBox({ check: ["fail", "fail"], checked: false });

    await checkOption(box);

    expect(rowClick).toHaveBeenCalledTimes(1);
  });

  it("leaves a box that is already ticked alone rather than toggling it off", async () => {
    const { box, rowClick } = fakeBox({ check: ["fail", "fail"], checked: true });

    await checkOption(box);

    expect(rowClick).not.toHaveBeenCalled();
  });
});
