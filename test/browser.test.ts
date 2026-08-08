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

  it("reads the question and its required flag from Ashby's newer fieldset container", () => {
    // Ashby ships two container conventions. When only the older class was
    // matched, this field fell back to its placeholder for a label and looked
    // optional, so the run reported nothing missing and then failed validation.
    const entry = ashbyFieldset("What brought you to this job posting", { required: true });
    const input = element({ type: "text", name: "", id: "", rect: { width: 200, height: 30 }, entry });
    input.getAttribute = (key: string) => (key === "role" ? "combobox" : key === "placeholder" ? "Start typing..." : null);

    const [field] = collect([input], {}) as unknown as Array<{ label: string; required: boolean }>;

    expect(field!.label).toBe("What brought you to this job posting");
    expect(field!.required).toBe(true);
  });

  it("gives every box of one multi-select question the same group key", () => {
    // A required "select all that apply" is answered by ticking any one box.
    // Without a shared key each untouched box reads as its own unmet
    // requirement, so a fully answered question still blocks submission.
    const entry = ashbyFieldset("Why are you interested in working at Plaid?", { required: true, checkboxes: 3 });
    const boxes = ["mission", "products", "culture"].map((id) =>
      element({ type: "checkbox", name: id, id, rect: { width: 16, height: 16 }, entry }),
    );

    const fields = collect(boxes, { mission: "Mission", products: "Products", culture: "Culture" }) as unknown as Array<{
      groupKey?: string;
      required: boolean;
    }>;

    expect(fields.map((field) => field.groupKey)).toEqual(Array(3).fill("Why are you interested in working at Plaid?"));
    expect(fields.every((field) => field.required)).toBe(true);
  });

  it("leaves a lone checkbox ungrouped, so it stands on its own", () => {
    const entry = ashbyFieldset("I agree to the terms", { required: true, checkboxes: 1 });
    const box = element({ type: "checkbox", name: "agree", id: "agree", rect: { width: 16, height: 16 }, entry });

    const [field] = collect([box], { agree: "I agree" }) as unknown as Array<{ groupKey?: string }>;

    expect(field!.groupKey).toBeUndefined();
  });

  it("carries the question a lone acknowledgement box sits under", () => {
    // The box itself reads only "I understand", which matches no stored answer.
    // The question above it is the only text saying what is being agreed to.
    const question = "I understand that offers of employment are conditional on satisfactory completion of a background check.";
    const entry = ashbyFieldset(question, { required: true, checkboxes: 1 });
    const box = element({ type: "checkbox", name: "bg", id: "bg", rect: { width: 16, height: 16 }, entry });

    const [field] = collect([box], { bg: "I understand" }) as unknown as Array<{ label: string; questionLabel?: string }>;

    expect(field!.label).toBe("I understand");
    expect(field!.questionLabel).toBe(question);
  });
});

/** Models Ashby's newer `<fieldset class="..._fieldEntry_...">` question wrapper. */
function ashbyFieldset(title: string, options: { required?: boolean; checkboxes?: number }): Record<string, unknown> {
  const className = `_heading_f7cvd_52 ${options.required ? "_required_f7cvd_91 " : ""}_label_1e3gg_42 ashby-application-form-question-title`;
  const titleNode = { innerText: title, className };
  return {
    tagName: "FIELDSET",
    className: "_container_wz442_28 _fieldEntry_1e3gg_28",
    querySelector: (selector: string) =>
      selector.includes("ashby-application-form-question-title") ? titleNode : null,
    querySelectorAll: (selector: string) =>
      selector.includes("checkbox") ? new Array(options.checkboxes ?? 0).fill({}) : [],
  };
}

type FakeElementSpec = {
  tag?: string;
  type: string;
  name: string;
  id: string;
  automationId?: string;
  rect: { width: number; height: number };
  entry?: Record<string, unknown>;
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
    // Only the newer fieldset wrapper is modelled, so a test that still matched
    // the older class selector would fail rather than quietly pass.
    closest: (selector: string) =>
      spec.entry && (selector.includes("_fieldEntry_") || selector === "fieldset") ? spec.entry : null,
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
