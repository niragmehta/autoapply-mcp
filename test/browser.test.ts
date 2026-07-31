import { describe, expect, it } from "vitest";
import { COLLECT_FIELDS, fillCombobox } from "../src/submission/browser.js";

describe("COLLECT_FIELDS", () => {
  it("executes immediately and returns field descriptors", () => {
    const evaluate = new Function("document", "window", "CSS", `return ${COLLECT_FIELDS}`);
    const result = evaluate(
      { querySelectorAll: () => [] },
      { getComputedStyle: () => ({ display: "block", visibility: "visible" }) },
      { escape: (value: string) => value },
    );

    expect(result).toEqual([]);
  });
});

type FakeCombobox = {
  page: Parameters<typeof fillCombobox>[0];
  locator: Parameters<typeof fillCombobox>[1];
  events: string[];
};

function fakeCombobox(optionsByFilter: Record<string, string[]>): FakeCombobox {
  const events: string[] = [];
  let filter = "";
  const optionsFor = () => optionsByFilter[filter] ?? [];
  const optionLocator = {
    count: async () => optionsFor().length,
    allInnerTexts: async () => optionsFor(),
    nth: (index: number) => ({
      click: async () => {
        events.push(`click-option:${optionsFor()[index]}`);
      },
    }),
  };
  const page = {
    locator: () => optionLocator,
    waitForTimeout: async () => undefined,
    keyboard: {
      press: async (key: string) => {
        events.push(`key:${key}`);
        filter = "";
      },
    },
  };
  const locator = {
    locator: () => ({ count: async () => 1, click: async () => events.push("toggle") }),
    fill: async (value: string) => {
      events.push(`fill:${value}`);
      filter = value;
    },
    click: async () => events.push("click-input"),
  };
  return {
    page: page as unknown as Parameters<typeof fillCombobox>[0],
    locator: locator as unknown as Parameters<typeof fillCombobox>[1],
    events,
  };
}

describe("fillCombobox", () => {
  it("selects the first candidate that produces a matching option", async () => {
    const fake = fakeCombobox({ Yes: ["Yes", "No"] });
    await fillCombobox(fake.page, fake.locator, ["Yes"]);
    expect(fake.events).toContain("click-option:Yes");
  });

  it("closes the flyout when no candidate matches so the next field stays clickable", async () => {
    const fake = fakeCombobox({ Yes: ["Alpha", "Beta"], "": ["Alpha", "Beta"] });
    await expect(fillCombobox(fake.page, fake.locator, ["Yes"])).rejects.toThrow(/no visible option/);
    expect(fake.events.at(-1)).toBe("key:Escape");
  });

  it("closes the flyout after a successful selection", async () => {
    const fake = fakeCombobox({ Yes: ["Yes"] });
    await fillCombobox(fake.page, fake.locator, ["Yes"]);
    expect(fake.events.at(-1)).toBe("key:Escape");
  });
});
