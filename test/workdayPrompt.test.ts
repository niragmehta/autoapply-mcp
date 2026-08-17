import { describe, expect, it } from "vitest";

import { fillWorkdayPrompt, isWorkdayPrompt } from "../src/submission/workdayFlow.js";

/**
 * A Workday prompt widget reduced to the behaviour that broke the wizard.
 *
 * Modelled on a live NVIDIA tenant: the choice is not an input, the menu is
 * nested one level, and an already-chosen value is rendered as a pill that also
 * carries `role="option"` — so a page-wide option query sees other fields'
 * answers as if they were selectable choices.
 */
type Tree = Record<string, string[] | null>;

class FakePrompt {
  menu: string[] = [];
  selected: string[] = [];
  readonly clicked: string[] = [];

  constructor(
    private readonly tree: Tree,
    private readonly kind: "picker" | "dropdown" = "picker",
    /** Pills belonging to *other* fields, which must never be treated as choices. */
    private readonly strayPills: string[] = [],
  ) {}

  private top(): string[] {
    return Object.keys(this.tree);
  }

  private list(selector: string, items: string[]) {
    const self = this;
    const make = (index: number | null) => ({
      first: () => make(0),
      nth: (i: number) => make(i),
      count: async () => items.length,
      isVisible: async () => items.length > 0,
      waitFor: async () => undefined,
      allInnerTexts: async () => items,
      locator: (child: string) => self.locator(child),
      fill: async () => undefined,
      click: async () => {
        const label = items[index ?? 0];
        if (label === undefined) throw new Error(`nothing at ${index} for ${selector}`);
        self.clicked.push(label);
        const children = self.tree[label];
        if (children === undefined) {
          // A leaf inside an open category.
          self.selected = [label];
          self.menu = [];
          return;
        }
        if (children === null) {
          self.selected = [label];
          self.menu = [];
          return;
        }
        self.menu = children;
      },
    });
    return make(null);
  }

  locator(selector: string) {
    if (selector.includes('role="option"')) {
      // The production selector excludes pills; the fake honours that by only
      // ever returning menu items here, and exposing pills separately.
      return this.list(selector, this.menu);
    }
    if (selector.includes("selectedItem")) {
      return this.list(selector, this.kind === "picker" ? this.selected : []);
    }
    if (selector.includes("multiSelectContainer") || selector.includes("aria-haspopup")) {
      // The production code asks three different questions with this markup:
      // "is it a prompt at all" (either widget), "is it a picker"
      // (multiSelectContainer alone) and "what does the dropdown button read"
      // (aria-haspopup alone). The fake has to answer each honestly.
      const both = selector.includes("multiSelectContainer") && selector.includes("aria-haspopup");
      const present = both
        ? true
        : selector.includes("multiSelectContainer")
          ? this.kind === "picker"
          : this.kind === "dropdown";
      const self = this;
      const target = {
        first: () => target,
        nth: () => target,
        count: async () => (present ? 1 : 0),
        isVisible: async () => present,
        waitFor: async () => undefined,
        allInnerTexts: async () =>
          self.kind === "dropdown" ? [self.selected[0] ?? "Select One"] : self.selected,
        locator: (child: string) => self.locator(child),
        fill: async () => undefined,
        click: async () => {
          self.menu = self.top();
        },
      };
      return target;
    }
    return this.list(selector, []);
  }

  asPage() {
    return {
      goto: async () => undefined,
      locator: (selector: string) => this.locator(selector),
      url: () => "https://nvidia.wd5.myworkdayjobs.com/NVIDIAExternalCareerSite/job/x",
      waitForTimeout: async () => undefined,
      waitForLoadState: async () => undefined,
      evaluate: async () => "",
      keyboard: {
        press: async () => {
          this.menu = [];
        },
      },
    };
  }

  /** The widget wrapper the production code is handed. */
  asField() {
    return this.locator("wrapper-root") as never;
  }
}

/** Wrapper whose child lookups go back to the fake, mirroring a real locator. */
function fieldOf(prompt: FakePrompt) {
  return {
    first: () => fieldOf(prompt),
    nth: () => fieldOf(prompt),
    count: async () => 1,
    isVisible: async () => true,
    waitFor: async () => undefined,
    allInnerTexts: async () => [],
    fill: async () => undefined,
    click: async () => undefined,
    locator: (selector: string) => prompt.locator(selector),
  } as never;
}

describe("fillWorkdayPrompt", () => {
  it("selects a value that is offered at the top level", async () => {
    const prompt = new FakePrompt({ "Canada (+1)": null, "United States (+1)": null });

    const result = await fillWorkdayPrompt(prompt.asPage(), fieldOf(prompt), ["Canada"]);

    expect(result.filled).toBe(true);
    expect(prompt.selected).toEqual(["Canada (+1)"]);
  });

  it("opens a category to reach a value the top level does not offer", async () => {
    // NVIDIA nests "Linkedin Jobs" under "Job Board", and typing does not
    // search into the categories, so the leaf is only reachable by opening it.
    const prompt = new FakePrompt({
      Associations: ["Local Chapter"],
      "Job Board": ["Indeed", "Linkedin Jobs"],
      "Social Media": ["Facebook", "Twitter"],
    });

    const result = await fillWorkdayPrompt(prompt.asPage(), fieldOf(prompt), ["LinkedIn"]);

    expect(result.filled).toBe(true);
    expect(prompt.selected).toEqual(["Linkedin Jobs"]);
    expect(result.detail).toContain("Job Board");
  });

  it("reports failure instead of claiming success when nothing matches", async () => {
    // The original defect: the fill silently did nothing and was counted as
    // filled, so the run only failed later when Workday refused to save.
    const prompt = new FakePrompt({ Associations: ["Local Chapter"], Website: ["Careers Page"] });

    const result = await fillWorkdayPrompt(prompt.asPage(), fieldOf(prompt), ["Carrier Pigeon"]);

    expect(result.filled).toBe(false);
    expect(prompt.selected).toEqual([]);
    expect(result.detail).toContain("Carrier Pigeon");
  });

  it("confirms a dropdown by its button text, which renders no pill", async () => {
    const prompt = new FakePrompt({ Mobile: null, Landline: null }, "dropdown");

    const result = await fillWorkdayPrompt(prompt.asPage(), fieldOf(prompt), ["Mobile"]);

    expect(result.filled).toBe(true);
    expect(prompt.selected).toEqual(["Mobile"]);
  });

  it("leaves a value a previous pass already chose", async () => {
    const prompt = new FakePrompt({ "Canada (+1)": null });
    prompt.selected = ["Canada (+1)"];

    const result = await fillWorkdayPrompt(prompt.asPage(), fieldOf(prompt), ["Canada"]);

    expect(result.filled).toBe(true);
    expect(prompt.clicked).toEqual([]);
    expect(prompt.selected).toEqual(["Canada (+1)"]);
  });

  it("treats a dropdown placeholder as empty rather than as a chosen value", async () => {
    const prompt = new FakePrompt({ Mobile: null }, "dropdown");

    const result = await fillWorkdayPrompt(prompt.asPage(), fieldOf(prompt), ["Mobile"]);

    expect(result.filled).toBe(true);
    expect(prompt.clicked).toContain("Mobile");
  });
  it("does not mistake the placeholder for a choice", async () => {
    // Workday lists "Select One" as a selectable option, so a loose match would
    // "choose" the placeholder and leave the field empty while reporting success.
    const prompt = new FakePrompt({ "Select One": null, Home: null }, "dropdown");

    const result = await fillWorkdayPrompt(prompt.asPage(), fieldOf(prompt), ["Select"]);

    expect(result.filled).toBe(false);
    expect(prompt.clicked).toEqual([]);
  });

  it("tries the employer's vocabulary for the same choice", async () => {
    // NVIDIA calls a mobile number "Home Cellular"; a stored answer of "Mobile"
    // matches nothing without the synonym.
    const prompt = new FakePrompt({ Home: null, "Home Cellular": null }, "dropdown");

    const result = await fillWorkdayPrompt(prompt.asPage(), fieldOf(prompt), ["Mobile"]);

    expect(result.filled).toBe(true);
    expect(prompt.selected).toEqual(["Home Cellular"]);
  });

  it("recognises a refusal the employer spells differently", async () => {
    // NVIDIA's demographic menus offer "Decline to State (United States of
    // America)". The stored answer says "decline to self-identify", so three
    // required fields were left blank and the step could never save.
    const prompt = new FakePrompt(
      {
        "Asian (Not Hispanic or Latino) (United States of America)": null,
        "Decline to State (United States of America)": null,
      },
      "dropdown",
    );

    const result = await fillWorkdayPrompt(prompt.asPage(), fieldOf(prompt), [
      "Decline to self-identify",
    ]);

    expect(result.filled).toBe(true);
    expect(prompt.selected).toEqual(["Decline to State (United States of America)"]);
  });

  it("recognises a refusal spelled as a sentence", async () => {
    // The same NVIDIA step spells the veteran refusal a third way.
    const prompt = new FakePrompt(
      { "I AM NOT A VETERAN": null, "I DO NOT WISH TO SELF-IDENTIFY": null },
      "dropdown",
    );

    const result = await fillWorkdayPrompt(prompt.asPage(), fieldOf(prompt), [
      "Decline to self-identify",
    ]);

    expect(result.filled).toBe(true);
    expect(prompt.selected).toEqual(["I DO NOT WISH TO SELF-IDENTIFY"]);
  });

  it("never turns a real answer into a refusal", async () => {
    // Both sides must be refusals, or a stored "No" would take whichever
    // decline option happened to be offered.
    const prompt = new FakePrompt({ "I DO NOT WISH TO SELF-IDENTIFY": null }, "dropdown");

    const result = await fillWorkdayPrompt(prompt.asPage(), fieldOf(prompt), ["No"]);

    expect(result.filled).toBe(false);
    expect(prompt.selected).toEqual([]);
  });

  it("does not let a bare No hide inside another word", async () => {
    // "no" is a substring of "NOT", so this answered a veteran question with
    // the opposite of a decline.
    const prompt = new FakePrompt({ "I AM NOT A VETERAN": null }, "dropdown");

    const result = await fillWorkdayPrompt(prompt.asPage(), fieldOf(prompt), ["No"]);

    expect(result.filled).toBe(false);
  });

  it("does not read a qualified Yes as a No", async () => {
    const prompt = new FakePrompt({ "Yes, no restriction": null, No: null }, "dropdown");

    const result = await fillWorkdayPrompt(prompt.asPage(), fieldOf(prompt), ["No"]);

    expect(result.filled).toBe(true);
    expect(prompt.selected).toEqual(["No"]);
  });

  it("prefers the least qualified of several matching options", async () => {
    const prompt = new FakePrompt({ "Work Cellular": null, Cellular: null }, "dropdown");

    const result = await fillWorkdayPrompt(prompt.asPage(), fieldOf(prompt), ["Cellular"]);

    expect(result.filled).toBe(true);
    expect(prompt.selected).toEqual(["Cellular"]);
  });
});

describe("isWorkdayPrompt", () => {
  it("recognises a picker widget", async () => {
    const prompt = new FakePrompt({ Mobile: null });
    expect(await isWorkdayPrompt(fieldOf(prompt))).toBe(true);
  });
});
