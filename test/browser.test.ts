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

  it("ignores a bot-trap input that a person could never see", () => {
    // Workday plants this on its account pages: 1px tall, name="website", and
    // display:block so an ordinary visibility test passes it. Filling it marks
    // the applicant as a bot, and "website" would otherwise match a stored
    // portfolio or personal-site answer.
    const honeypot = element({
      type: "text",
      name: "website",
      id: "trap",
      automationId: "beecatcher",
      rect: { width: 1, height: 0.01 },
    });
    const real = element({ type: "text", name: "email", id: "email", rect: { width: 240, height: 32 } });

    const fields = collect([honeypot, real], { trap: "Enter website. This input is for robots only, do not enter if you're human." });

    expect(fields.map((field) => field.name)).toEqual(["email"]);
  });

  it("still collects a zero-sized select, which custom dropdowns rely on", () => {
    // The native select behind a styled dropdown is routinely zero-sized.
    // Treating size alone as a bot trap would break every such question.
    const hiddenSelect = element({ tag: "select", type: "select-one", name: "country", id: "country", rect: { width: 0, height: 0 } });

    const fields = collect([hiddenSelect], { country: "Country" });

    expect(fields).toHaveLength(1);
  });
});

type FakeElementSpec = {
  tag?: string;
  type: string;
  name: string;
  id: string;
  automationId?: string;
  rect: { width: number; height: number };
};

function element(spec: FakeElementSpec): Record<string, unknown> {
  const attributes: Record<string, string> = { name: spec.name };
  if (spec.automationId) attributes["data-automation-id"] = spec.automationId;
  return {
    tagName: (spec.tag ?? "input").toUpperCase(),
    type: spec.type,
    id: spec.id,
    getBoundingClientRect: () => spec.rect,
    getAttribute: (key: string) => attributes[key] ?? null,
    hasAttribute: (key: string) => key in attributes,
    setAttribute: (key: string, value: string) => {
      attributes[key] = value;
    },
    closest: () => null,
  };
}

/** Runs COLLECT_FIELDS against a fake DOM whose labels come from `labels`. */
function collect(elements: Array<Record<string, unknown>>, labels: Record<string, string>): Array<{ name: string }> {
  const evaluate = new Function("document", "window", "CSS", `return ${COLLECT_FIELDS}`);
  const document = {
    querySelectorAll: () => elements,
    querySelector: (selector: string) => {
      const match = /label\[for="(.+)"\]/.exec(selector);
      const text = match ? labels[match[1]!] : undefined;
      return text ? { innerText: text } : null;
    },
    getElementById: () => null,
  };
  return evaluate(document, { getComputedStyle: () => ({ display: "block", visibility: "visible" }) }, {
    escape: (value: string) => value,
  }) as Array<{ name: string }>;
}

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
