import { describe, expect, it, vi } from "vitest";
import { fillLeverLocation } from "../src/submission/leverLocation.js";

const canada = "Vancouver, British Columbia, Canada";
const usa = "Vancouver, Washington, United States";
function driver(options = [usa, canada]) {
  return {
    search: vi.fn().mockResolvedValue(undefined),
    options: vi.fn().mockResolvedValue(options),
    pick: vi.fn().mockResolvedValue(undefined),
    selection: vi.fn().mockResolvedValue({ display: canada, encoded: JSON.stringify({ name: canada }) }),
    hasChallenge: vi.fn().mockResolvedValue(false),
  };
}

describe("Lever native current-location selection", () => {
  it("chooses the qualified Canadian location rather than the first same-name US city", async () => {
    const ui = driver();
    await fillLeverLocation(ui, [canada, "Vancouver"]);
    expect(ui.pick).toHaveBeenCalledWith(1);
    expect(ui.selection).toHaveBeenCalledOnce();
  });

  it("may search by city but still selects only the full approved location", async () => {
    const ui = driver();
    ui.options.mockResolvedValueOnce([]);
    await fillLeverLocation(ui, [canada, "Vancouver"]);
    expect(ui.search.mock.calls).toEqual([[canada], ["Vancouver"]]);
    expect(ui.pick).toHaveBeenCalledWith(1);
  });

  it("never falls back to a matching city in the wrong country", async () => {
    const ui = driver([usa]);
    await expect(fillLeverLocation(ui, [canada, "Vancouver"])).rejects.toThrow(/approved current location/i);
    expect(ui.pick).not.toHaveBeenCalled();
  });

  it("requires the site's native selected-location record, not just typed text", async () => {
    const ui = { ...driver(), selection: vi.fn().mockResolvedValue({ display: canada, encoded: "" }) };
    await expect(fillLeverLocation(ui, [canada])).rejects.toThrow(/retain.*location/i);
  });

  it("rejects a native selection that disagrees with the displayed approved location", async () => {
    const ui = {
      ...driver(),
      selection: vi.fn().mockResolvedValue({ display: canada, encoded: JSON.stringify({ name: usa }) }),
    };
    await expect(fillLeverLocation(ui, [canada])).rejects.toThrow(/retain.*location/i);
  });

  it("rejects malformed native selection JSON", async () => {
    const ui = { ...driver(), selection: vi.fn().mockResolvedValue({ display: canada, encoded: "invalid" }) };
    await expect(fillLeverLocation(ui, [canada])).rejects.toThrow(/retain.*location/i);
  });

  it("rejects a missing display value even if native metadata exists", async () => {
    const ui = { ...driver(), selection: vi.fn().mockResolvedValue({ display: "", encoded: JSON.stringify({ name: canada }) }) };
    await expect(fillLeverLocation(ui, [canada])).rejects.toThrow(/retain.*location/i);
  });

  it("rejects an invalid result shape explicitly", async () => {
    const ui = { ...driver(), selection: vi.fn().mockResolvedValue(null) };
    await expect(fillLeverLocation(ui, [canada])).rejects.toThrow(/retain.*location/i);
  });

  it("stops before any interaction if an interactive challenge is visible", async () => {
    const ui = { ...driver(), hasChallenge: vi.fn().mockResolvedValue(true) };
    await expect(fillLeverLocation(ui, [canada])).rejects.toThrow(/captcha/i);
    expect(ui.search).not.toHaveBeenCalled();
  });

  it("does not select an option after lookup triggers a challenge", async () => {
    const ui = driver();
    ui.hasChallenge.mockResolvedValueOnce(false).mockResolvedValue(true);
    await expect(fillLeverLocation(ui, [canada])).rejects.toThrow(/captcha/i);
    expect(ui.pick).not.toHaveBeenCalled();
  });

  it("does not try another query after the native lookup refuses the request", async () => {
    const ui = driver();
    ui.options.mockRejectedValue(new Error("Native lookup refused (HTTP 403)"));
    await expect(fillLeverLocation(ui, [canada, "Vancouver"])).rejects.toThrow(/403/);
    expect(ui.search).toHaveBeenCalledOnce();
    expect(ui.pick).not.toHaveBeenCalled();
  });

  it("rejects a missing approved location", async () => {
    await expect(fillLeverLocation(driver(), [])).rejects.toThrow(/approved current location/i);
  });
});

describe("Lever canonical location notation", () => {
  const leverCanada = "Vancouver, BC, CAN";
  const leverUsa = "Vancouver, WA, USA";
  function notationDriver(options) {
    return {
      search: vi.fn().mockResolvedValue(undefined),
      options: vi.fn().mockResolvedValue(options),
      pick: vi.fn().mockResolvedValue(undefined),
      selection: vi.fn().mockResolvedValue({ display: leverCanada, encoded: JSON.stringify({ name: leverCanada }) }),
      hasChallenge: vi.fn().mockResolvedValue(false),
    };
  }

  it("accepts the site's abbreviated rendering of the approved location", async () => {
    const ui = notationDriver([leverUsa, leverCanada]);
    await fillLeverLocation(ui, [canada, "Vancouver"]);
    expect(ui.pick).toHaveBeenCalledWith(1);
  });

  it("still refuses a same-city suggestion in another country", async () => {
    const ui = notationDriver([leverUsa]);
    await expect(fillLeverLocation(ui, [canada, "Vancouver"])).rejects.toThrow(/approved current location/i);
    expect(ui.pick).not.toHaveBeenCalled();
  });

  it("refuses a suggestion naming a different region of the approved country", async () => {
    const ui = notationDriver(["Vancouver, ON, CAN"]);
    await expect(fillLeverLocation(ui, [canada, "Vancouver"])).rejects.toThrow(/approved current location/i);
    expect(ui.pick).not.toHaveBeenCalled();
  });

  it("refuses a bare city with no country to compare", async () => {
    const ui = notationDriver(["Vancouver"]);
    await expect(fillLeverLocation(ui, [canada, "Vancouver"])).rejects.toThrow(/approved current location/i);
    expect(ui.pick).not.toHaveBeenCalled();
  });
});
