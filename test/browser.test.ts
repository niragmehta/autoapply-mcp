import { describe, expect, it } from "vitest";
import { COLLECT_FIELDS, READ_VALIDATION_ERRORS, fillCombobox, repairReportedFields } from "../src/submission/browser.js";
import type { FillPlan } from "../src/submission/formFields.js";

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

  it("groups a Greenhouse checkbox question, which has no Ashby wrapper", () => {
    // Grouping used to be keyed off an Ashby-only container, so on Greenhouse
    // every option arrived as its own required field labelled with the option
    // text. The drafted answer was keyed on the question, matched nothing, and
    // the whole group was reported as eleven unmet requirements.
    const labels = {
      friend: "Someone I know personally (friend, family, former colleague)",
      board: "Job posting on LinkedIn, Indeed, or other job board",
      event: "Industry event or conference",
    };
    const boxes: Array<Record<string, unknown>> = [];
    const container = {
      innerText: [
        "How did you hear about Faire? (Select all that apply)",
        labels.friend,
        labels.board,
        labels.event,
      ].join("\n"),
      querySelectorAll: (selector: string) =>
        selector.includes("checkbox") && !selector.includes(":not") ? boxes : [],
    };
    for (const id of ["friend", "board", "event"]) {
      boxes.push(element({ type: "checkbox", name: id, id, rect: { width: 16, height: 16 }, parent: container }));
    }

    const fields = collect(boxes, labels) as unknown as Array<{
      label: string;
      optionLabel?: string;
      groupKey?: string;
    }>;

    expect(fields.map((field) => field.groupKey)).toEqual(
      Array(3).fill("How did you hear about Faire? (Select all that apply)"),
    );
    expect(fields.map((field) => field.optionLabel)).toEqual([labels.friend, labels.board, labels.event]);
  });

  it("does not group checkboxes that only share an outer form with other inputs", () => {
    // Walking up too far would fuse unrelated questions into one group and
    // report a single label for boxes that answer different things.
    const boxes: Array<Record<string, unknown>> = [];
    const form = {
      innerText: "Apply for this job",
      querySelectorAll: (selector: string) =>
        selector.includes(":not") ? [{}] : selector.includes("checkbox") ? boxes : [],
    };
    for (const id of ["a", "b"]) {
      boxes.push(element({ type: "checkbox", name: id, id, rect: { width: 16, height: 16 }, parent: form }));
    }

    const fields = collect(boxes, { a: "A", b: "B" }) as unknown as Array<{ groupKey?: string }>;

    expect(fields.every((field) => field.groupKey === undefined)).toBe(true);
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
  parent?: Record<string, unknown>;
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
    parentElement: spec.parent ?? null,
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

describe("READ_VALIDATION_ERRORS", () => {
  /** Ashby's refusal block: a heading, then one list item per lost field. */
  function ashbyErrorDom() {
    const item = {
      tagName: "LI",
      children: [] as unknown[],
      textContent: "Missing entry for required field: Phone",
      getBoundingClientRect: () => ({ width: 300, height: 20 }),
      closest: () => null,
      getAttribute: () => null,
      querySelector: () => null,
    };
    const banner = {
      tagName: "DIV",
      children: [item],
      textContent: "Your form needs corrections Missing entry for required field: Phone",
      getBoundingClientRect: () => ({ width: 300, height: 60 }),
      closest: () => null,
      getAttribute: () => null,
      querySelector: () => null,
    };
    return [banner, item];
  }

  function read(elements: unknown[]): string[] {
    // Mirrors page.evaluate(): the constant is evaluated as an expression, so a
    // reader that is merely declared and never invoked yields undefined - which
    // is exactly how this silently returned no errors on every board.
    const evaluate = new Function("document", "window", `return ${READ_VALIDATION_ERRORS}`);
    const document = {
      querySelectorAll: (selector: string) =>
        selector.includes("li, p, span, div") ? elements : [],
    };
    return evaluate(document, { getComputedStyle: () => ({ display: "block", visibility: "visible" }) }) as string[];
  }

  it("is invoked, not merely declared, so page.evaluate gets a value", () => {
    expect(READ_VALIDATION_ERRORS.trim().endsWith("})()")).toBe(true);
    expect(read([])).toEqual([]);
  });

  it("reads a refusal that carries no alert role and no error class", () => {
    // The block Ashby renders has neither, so it is only reachable by wording -
    // and missing it turned a repairable Abridge refusal into an unexplained
    // "no confirmation detected".
    expect(read(ashbyErrorDom())).toContain("Missing entry for required field: Phone");
  });

  it("keeps the field name rather than the wrapper that repeats it", () => {
    const out = read(ashbyErrorDom());
    expect(out).not.toContain("Your form needs corrections Missing entry for required field: Phone");
  });

  it("ignores ordinary page copy", () => {
    const paragraph = {
      tagName: "P",
      children: [],
      textContent: "We review every application we receive.",
      getBoundingClientRect: () => ({ width: 300, height: 20 }),
      closest: () => null,
      getAttribute: () => null,
      querySelector: () => null,
    };
    expect(read([paragraph])).toEqual([]);
  });
});

describe("repairReportedFields", () => {
  type Recorded = { events: string[]; page: Parameters<typeof repairReportedFields>[0] };

  function fakeRepairPage(): Recorded {
    const events: string[] = [];
    const locator = {
      first: () => locator,
      click: async () => events.push("click"),
      fill: async (value: string) => events.push(`fill:${value === "" ? "<clear>" : value}`),
      count: async () => 1,
      locator: () => ({ count: async () => 0, first: () => ({ click: async () => undefined }) }),
      isChecked: async () => false,
      check: async () => events.push("check"),
      selectOption: async () => events.push("select"),
      evaluate: async () => undefined,
      inputValue: async () => "",
    };
    const page = {
      locator: () => locator,
      keyboard: {
        type: async (value: string) => events.push(`type:${value}`),
        press: async (key: string) => events.push(`press:${key}`),
      },
      waitForTimeout: async () => undefined,
    };
    return { events, page: page as unknown as Parameters<typeof repairReportedFields>[0] };
  }

  function match(label: string, type: string, value: string) {
    return {
      field: { label, type, selectorIndex: 0, required: true, name: label, role: "textbox" },
      answer: { label, answer: value, questionKey: label, source: "profile", required: true },
      confidence: 1,
    } as unknown as FillPlan["toFill"][number];
  }

  it("retypes a text field the board reported empty, then blurs it", async () => {
    const fake = fakeRepairPage();
    const repaired = await repairReportedFields(fake.page, [match("Full Name", "text", "Nirag Mehta")], [
      "Missing entry for required field: Full Name",
    ]);
    expect(repaired).toEqual(["Full Name"]);
    // fill() is what the board ignored the first time, so the value has to be
    // re-entered as real keystrokes and committed with a blur.
    expect(fake.events).toEqual(["click", "fill:<clear>", "type:Nirag Mehta", "press:Tab"]);
  });

  it("leaves fields the board did not complain about alone", async () => {
    const fake = fakeRepairPage();
    const repaired = await repairReportedFields(
      fake.page,
      [match("Full Name", "text", "Nirag Mehta"), match("Email", "email", "n@example.com")],
      ["Missing entry for required field: Full Name"],
    );
    expect(repaired).toEqual(["Full Name"]);
    expect(fake.events).not.toContain("type:n@example.com");
  });

  it("reports nothing repaired when the errors name no field it filled", async () => {
    const fake = fakeRepairPage();
    const repaired = await repairReportedFields(fake.page, [match("Full Name", "text", "Nirag Mehta")], [
      "Please complete the captcha",
    ]);
    expect(repaired).toEqual([]);
    expect(fake.events).toEqual([]);
  });

  it("re-marks the form when a validation re-render replaced the field it must repair", async () => {
    const events: string[] = [];
    let marked = false;
    const locator = {
      first: () => locator,
      count: async () => (marked ? 1 : 0),
      click: async () => events.push("click"),
      fill: async () => events.push("clear"),
    };
    const page = {
      locator: () => locator,
      evaluate: async () => {
        marked = true;
        events.push("re-mark");
        return [];
      },
      keyboard: { type: async () => events.push("type"), press: async () => events.push("blur") },
      waitForTimeout: async () => undefined,
    } as unknown as Parameters<typeof repairReportedFields>[0];
    const repaired = await repairReportedFields(page, [match("Full Name", "text", "Nirag Mehta")], [
      "Missing entry for required field: Full Name",
    ]);
    expect(repaired).toEqual(["Full Name"]);
    expect(events[0]).toBe("re-mark");
  });
});

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
