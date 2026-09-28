import { describe, expect, it } from "vitest";

import { optionSearchCandidates } from "../src/submission/formFields.js";
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
  /** Rows whose click resolves without selecting anything, like padding that takes no events. */
  refuses: string[] = [];
  /** Whether the widget announces how many values it holds, as Workday does for screen readers. */
  announces = false;
  /** Models keyboard selection: the row Enter commits, and what the cursor is read back as. */
  keys?: { commits: string; readsAs: string };

  constructor(
    private readonly tree: Tree,
    /** "single-picker" is a single-select Workday renders inside a picker's container. */
    private readonly kind: "picker" | "dropdown" | "single-picker" = "picker",
    /** Pills belonging to *other* fields, which must never be treated as choices. */
    private readonly strayPills: string[] = [],
    /** False models a delete click that misses, which is how Adobe kept a stray major. */
    private readonly pillDeletes: boolean = true,
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
        if (self.refuses.includes(label)) return;
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
    if (selector.includes("promptAriaInstruction")) {
      return this.list(selector, this.announces ? [`${this.selected.length} items selected`] : []);
    }
    if (this.keys && selector.includes("selectinput")) {
      const input = { first: () => input, nth: () => input, count: async () => 1, click: async () => undefined };
      return input as never;
    }
    if (selector.includes('role="option"')) {
      // The production selector excludes pills; the fake honours that by only
      // ever returning menu items here, and exposing pills separately.
      return this.list(selector, this.menu);
    }
    if (selector.includes("selectedItem")) {
      const pills = this.kind === "picker" ? this.selected : [];
      const self = this;
      const asPill = (index: number | null) => ({
        first: () => asPill(0),
        last: () => asPill(pills.length - 1),
        nth: (i: number) => asPill(i),
        count: async () => pills.length,
        isVisible: async () => pills.length > 0,
        waitFor: async () => undefined,
        allInnerTexts: async () => pills,
        locator: (child: string) => self.locator(child),
        fill: async () => undefined,
        // A pill is its own delete control on a real widget.
        click: async () => {
          if (!self.pillDeletes) return;
          const at = index ?? 0;
          self.selected = self.selected.filter((_, position) => position !== at);
        },
      });
      return asPill(null);
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
          ? this.kind !== "dropdown"
          : this.kind !== "picker";
      const self = this;
      const target = {
        first: () => target,
        nth: () => target,
        count: async () => (present ? 1 : 0),
        isVisible: async () => present,
        waitFor: async () => undefined,
        allInnerTexts: async () =>
          self.kind === "picker" ? self.selected : [self.selected[0] ?? "Select One"],
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
      evaluate: async () => this.keys?.readsAs ?? "",
      keyboard: {
        press: async (key: string) => {
          if (this.keys && key === "ArrowDown") return;
          if (this.keys && key === "Enter") {
            this.selected = this.kind === "picker" ? [...this.selected, this.keys.commits] : [this.keys.commits];
            this.menu = [];
            return;
          }
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

  it("opens a category on a plain dropdown, which nests as readily as a picker", async () => {
    // The live defect on NVIDIA's "How Did You Hear About Us?": the field is a
    // single-select button rather than a multi-select picker, so the category
    // descent was skipped and the answer was reported as "not offered" while it
    // sat one click below a category the candidate list already named. Step 1 of
    // the wizard then refused to advance, with nothing in the log naming a
    // missing answer.
    const prompt = new FakePrompt(
      {
        Associations: ["Local Chapter"],
        "Job Board": ["Indeed", "Linkedin Jobs"],
        Website: ["Company Website", "NVIDIA.com"],
      },
      "dropdown",
    );

    const result = await fillWorkdayPrompt(prompt.asPage(), fieldOf(prompt), [
      "Website",
      "Company website",
    ]);

    expect(result.filled).toBe(true);
    expect(prompt.selected).toEqual(["Company Website"]);
    expect(result.detail).toContain("under Website");
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

  it("never lets an affirmative answer take the option that negates it", async () => {
    // "acknowledged" is a whole word of "Not acknowledged", so plain word
    // containment chose the refusal of a privacy notice the candidate had
    // agreed to acknowledge.
    const prompt = new FakePrompt({ "I acknowledge": null, "Not acknowledged": null }, "dropdown");

    const result = await fillWorkdayPrompt(prompt.asPage(), fieldOf(prompt), ["Acknowledged"]);

    expect(result.filled).toBe(false);
    expect(prompt.selected).toEqual([]);
  });

  it("acknowledges a notice in the employer's words", async () => {
    // Unity's Global Data Privacy Notice offers "Acknowledged" and "Not
    // Acknowledged"; the approved answer is "Yes".
    const prompt = new FakePrompt({ Acknowledged: null, "Not Acknowledged": null }, "dropdown");

    const result = await fillWorkdayPrompt(prompt.asPage(), fieldOf(prompt), ["Yes", "Acknowledged", "I Acknowledge"]);

    expect(result.filled).toBe(true);
    expect(prompt.selected).toEqual(["Acknowledged"]);
  });

  it("still lets a negative answer take the matching negative option", async () => {
    // Unity's export-control question lists countries and "Not Applicable".
    const prompt = new FakePrompt({ Cuba: null, Iran: null, "Not Applicable": null }, "dropdown");

    const result = await fillWorkdayPrompt(prompt.asPage(), fieldOf(prompt), ["Not Applicable"]);

    expect(result.filled).toBe(true);
    expect(prompt.selected).toEqual(["Not Applicable"]);
  });

  it("does not answer a not-applicable with the bare No inside it", async () => {
    // SCAN asks whether a driving role's licence and insurance can be provided.
    // "No" is a word of the approved "Not Applicable/No Driving Requirements",
    // and being shorter it was chosen over the exact option beside it.
    const prompt = new FakePrompt(
      { Yes: null, No: null, "Not Applicable/No Driving Requirements": null },
      "dropdown",
    );

    const result = await fillWorkdayPrompt(prompt.asPage(), fieldOf(prompt), [
      "Not Applicable/No Driving Requirements",
    ]);

    expect(result.filled).toBe(true);
    expect(prompt.selected).toEqual(["Not Applicable/No Driving Requirements"]);
  });

  it("leaves a not-applicable unanswered rather than saying No", async () => {
    const prompt = new FakePrompt({ Yes: null, No: null }, "dropdown");

    const result = await fillWorkdayPrompt(prompt.asPage(), fieldOf(prompt), [
      "Not Applicable/No Driving Requirements",
    ]);

    expect(result.filled).toBe(false);
    expect(prompt.selected).toEqual([]);
  });

  it("never reads a refusal as a bare No", async () => {
    // Unity asked ethnicity as Yes or No. The refusal "no response" contains
    // the word "no", so a declined disclosure was answered.
    const prompt = new FakePrompt({ Yes: null, No: null }, "dropdown");

    const result = await fillWorkdayPrompt(prompt.asPage(), fieldOf(prompt), [
      "Decline to self-identify",
      "Prefer not to say",
      "no response",
      "not declared",
    ]);

    expect(result.filled).toBe(false);
    expect(prompt.selected).toEqual([]);
  });

  it("still takes a bare No for an answer that opens with it", async () => {
    const prompt = new FakePrompt({ Yes: null, No: null }, "dropdown");

    const result = await fillWorkdayPrompt(prompt.asPage(), fieldOf(prompt), [
      "No, I will not require sponsorship",
    ]);

    expect(result.filled).toBe(true);
    expect(prompt.selected).toEqual(["No"]);
  });

  it("takes the option that says exactly what was approved over a shorter one inside it", async () => {
    const prompt = new FakePrompt({ LinkedIn: null, "LinkedIn Job Posting": null }, "dropdown");

    const result = await fillWorkdayPrompt(prompt.asPage(), fieldOf(prompt), ["LinkedIn Job Posting"]);

    expect(result.filled).toBe(true);
    expect(prompt.selected).toEqual(["LinkedIn Job Posting"]);
  });

  /**
   * Snap and Brex ask whether the candidate lives in the location or will
   * relocate there. A bare "Yes" reads both "Yes, I live here" and "Yes, I plan
   * to relocate", and the shorter one claims a residence he does not have.
   */
  it("takes the relocating option of a live-there-or-relocate prompt", async () => {
    const prompt = new FakePrompt({ "Yes, I live here": null, "Yes, I plan to relocate": null, No: null }, "dropdown");
    const label = "Do you currently live in or are you able to relocate to the location this job is advertised in?";
    const candidates = optionSearchCandidates(
      { selectorIndex: 0, label, type: "select", name: "", required: true },
      {
        questionKey: "relocation-willing",
        label,
        answer: "Yes",
        source: "approved-answer",
        citation: "profile.answers.relocation-willing",
        requiresHuman: false,
        category: "general",
      },
    );

    const result = await fillWorkdayPrompt(prompt.asPage(), fieldOf(prompt), candidates);

    expect(result.filled).toBe(true);
    expect(prompt.selected).toEqual(["Yes, I plan to relocate"]);
  });

  /**
   * Cisco asks "How many years of relevant work experience..." and offers
   * ranges. "5" is a substring of none of them, so a required field stayed on
   * "Select One" and the wizard would not advance past step 3 - three runs in a
   * row, each costing a full sign-in.
   */
  it("places a stated figure in the band that contains it", async () => {
    const prompt = new FakePrompt(
      { "Select One": null, "0-1 year": null, "2-3 years": null, "4+ years": null },
      "dropdown",
    );

    const result = await fillWorkdayPrompt(prompt.asPage(), fieldOf(prompt), ["5"]);

    expect(result.filled).toBe(true);
    expect(prompt.selected).toEqual(["4+ years"]);
  });

  it("never overstates experience to fill a band", async () => {
    // Every band starts above the stated figure, so the honest outcome is to
    // leave it for a person rather than claim more experience than there is.
    const prompt = new FakePrompt(
      { "Select One": null, "8-10 years": null, "10+ years": null },
      "dropdown",
    );

    const result = await fillWorkdayPrompt(prompt.asPage(), fieldOf(prompt), ["5"]);

    expect(result.filled).toBe(false);
    expect(prompt.selected).toEqual([]);
  });

  // Adobe's "Field of Study" is a flat taxonomy of thousands of majors, so
  // every entry the category probe opened was a value rather than a category.
  const MAJORS: Tree = {
    Accounting: null,
    "Actuarial Science": null,
    Advertising: null,
    "Aerospace Engineering": null,
    "African-American Studies": null,
    "African Studies": null,
    "Agricultural/Biological Engineering and Bioengineering": null,
  };

  it("leaves a prompt it could not answer exactly as it found it", async () => {
    const prompt = new FakePrompt(MAJORS);

    const result = await fillWorkdayPrompt(prompt.asPage(), fieldOf(prompt), ["Computer Science"]);

    expect(result.filled).toBe(false);
    // The form must not claim a major that was never studied.
    expect(prompt.selected).toEqual([]);
  });

  it("stops probing once an entry proves to be a value rather than a category", async () => {
    const prompt = new FakePrompt(MAJORS);

    await fillWorkdayPrompt(prompt.asPage(), fieldOf(prompt), ["Computer Science"]);

    // A flat list has no categories to open, so probing the rest of it would
    // only risk another stray selection.
    expect(prompt.clicked.filter((label) => label in MAJORS).length).toBeLessThan(3);
  });

  it("says so when a stray selection cannot be undone", async () => {
    const prompt = new FakePrompt(MAJORS, "picker", [], false);

    const result = await fillWorkdayPrompt(prompt.asPage(), fieldOf(prompt), ["Computer Science"]);

    expect(result.filled).toBe(false);
    expect(result.detail).toContain("could not clear");
    expect(result.detail).toContain("Accounting");
    // A value nobody approved is still on the form, so the run must stop even
    // when the question is optional.
    expect(result.strayValue).toBe(true);
  });

  it("presses Enter when typing alone leaves the list untouched", async () => {
    // Snap's Field of Study: typing "Computer Science" into the search box left
    // the alphabetical first page in place (20 -> 20 rows); the tenant only
    // searches when asked, so the major was reported as not on offer.
    const prompt = new SearchablePrompt(MAJORS, CATALOGUE, "enter");

    const result = await fillWorkdayPrompt(prompt.asPage(), fieldOf(prompt), ["Computer Science"]);

    expect(result.filled).toBe(true);
    expect(prompt.selected).toEqual(["Computer Science"]);
  });

  it("recognises a search that returns as many rows as it replaced", async () => {
    // A virtualised list renders a fixed number of rows, so a narrowed list can
    // be exactly as long as the first page it replaced. The rows, not their
    // count, show whether the search ran.
    const sameLength = [
      "Computer Science",
      "Computer Science and Engineering",
      "Computer Science, General",
      "Computer Science Education",
      "Computer Science and Mathematics",
      "Computer Science and Business",
      "Computer Science and Physics",
    ];
    expect(sameLength).toHaveLength(Object.keys(MAJORS).length);
    const prompt = new SearchablePrompt(MAJORS, sameLength, "keystroke");

    const result = await fillWorkdayPrompt(prompt.asPage(), fieldOf(prompt), ["Computer Science"]);

    expect(result.filled).toBe(true);
    expect(prompt.selected).toEqual(["Computer Science"]);
  });

  it("keeps the answer when Enter selects the only match outright", async () => {
    const prompt = new SearchablePrompt(MAJORS, ["Computer Science", "Computer Engineering"], "enter", true);

    const result = await fillWorkdayPrompt(prompt.asPage(), fieldOf(prompt), ["Computer Science"]);

    expect(result.filled).toBe(true);
    expect(prompt.selected).toEqual(["Computer Science"]);
  });

  it("clears a different major that Enter selected on its own", async () => {
    // The fallback search types only the first word, and "Computer" alone can
    // resolve to a single different major. That is not the degree held.
    const prompt = new SearchablePrompt(MAJORS, ["Computer Engineering"], "enter", true);

    const result = await fillWorkdayPrompt(prompt.asPage(), fieldOf(prompt), ["Computer Science"]);

    expect(result.filled).toBe(false);
    expect(prompt.selected).toEqual([]);
  });

  it("keeps an Enter selection that is another approved name for the answer", async () => {
    // Snap's search for "Computer Science" selected "Computer and Information
    // Science" outright. That name is on the approved list, so undoing it only
    // to search for it again would waste a pass and risk the field.
    const prompt = new SearchablePrompt(MAJORS, ["Computer and Information Science", "Economics"], "enter", true);

    const result = await fillWorkdayPrompt(prompt.asPage(), fieldOf(prompt), [
      "Computer Science",
      "Computer and Information Science",
    ]);

    expect(result.filled).toBe(true);
    expect(prompt.selected).toEqual(["Computer and Information Science"]);
    expect(prompt.enterPresses).toBe(1);
  });

  it("still filters without Enter on a tenant that searches as keys are typed", async () => {
    const prompt = new SearchablePrompt(MAJORS, CATALOGUE, "keystroke");

    const result = await fillWorkdayPrompt(prompt.asPage(), fieldOf(prompt), ["Computer Science"]);

    expect(result.filled).toBe(true);
    expect(prompt.selected).toEqual(["Computer Science"]);
    expect(prompt.enterPresses).toBe(0);
  });

  it("never presses Enter in a search box that belongs to the page", async () => {
    // Enter in the board's own job search would navigate away from the
    // application, taking every answer entered so far with it.
    const prompt = new SearchablePrompt(MAJORS, CATALOGUE, "enter", false, true);

    const result = await fillWorkdayPrompt(prompt.asPage(), fieldOf(prompt), ["Computer Science"]);

    expect(prompt.enterPresses).toBe(0);
    expect(result.filled).toBe(false);
    expect(prompt.selected).toEqual([]);
  });
});

/**
 * Adobe's "Country Phone Code": a single-select that arrives holding the right
 * value. A single-select replaces its value instead of adding a pill, so a
 * probe that swaps it leaves the count of chosen values unchanged - and the
 * pass reported "kept Canada (+1)" while the form read "Anguilla (+1)".
 */
describe("a single-select that a probe replaced", () => {
  const FIRST_PAGE: Tree = {
    "Afghanistan (+93)": null,
    "American Samoa (+1)": null,
    "Anguilla (+1)": null,
  };
  const COUNTRIES = ["Afghanistan (+93)", "American Samoa (+1)", "Anguilla (+1)", "Canada (+1)"];

  it("puts back the value it found when a search commits another", async () => {
    const prompt = new SearchablePrompt(FIRST_PAGE, COUNTRIES, "enter", false, false, {
      kind: "dropdown",
      enterCommitsFirstRow: true,
    });
    prompt.selected = ["Canada (+1)"];

    const result = await fillWorkdayPrompt(prompt.asPage(), fieldOf(prompt), ["604-555-0142"]);

    expect(prompt.selected).toEqual(["Canada (+1)"]);
    expect(result.filled).toBe(true);
    expect(result.detail).toContain("kept Canada (+1)");
  });

  it("says so instead of claiming it kept a value it could not restore", async () => {
    const prompt = new SearchablePrompt(FIRST_PAGE, COUNTRIES.filter((name) => !name.startsWith("Canada")), "enter", false, false, {
      kind: "dropdown",
      enterCommitsFirstRow: true,
    });
    prompt.selected = ["Canada (+1)"];

    const result = await fillWorkdayPrompt(prompt.asPage(), fieldOf(prompt), ["604-555-0142"]);

    expect(result.filled).toBe(false);
    expect(result.detail).not.toContain("kept");
    expect(result.detail).toContain("Canada (+1)");
  });

  it("takes an approved answer in place of a different value left from an earlier run", async () => {
    const firstPage: Tree = { Accounting: null, "Actuarial Science": null, Advertising: null };
    const prompt = new SearchablePrompt(firstPage, CATALOGUE, "keystroke", false, false, { kind: "dropdown" });
    prompt.selected = ["Economics"];

    const result = await fillWorkdayPrompt(prompt.asPage(), fieldOf(prompt), ["Computer Science"]);

    expect(result.filled).toBe(true);
    expect(prompt.selected).toEqual(["Computer Science"]);
  });

  it("does not claim to keep an old value when the approved answer is on offer but will not select", async () => {
    // "Kept" is only honest when nothing approved was on offer. Here the answer
    // was listed and the click did not take, so the vendor an earlier run left
    // behind is still what the form says.
    const prompt = new FakePrompt({ LinkedIn: null, Findem: null, Other: null }, "dropdown");
    prompt.selected = ["Findem"];
    prompt.refuses = ["LinkedIn"];

    const result = await fillWorkdayPrompt(prompt.asPage(), fieldOf(prompt), ["LinkedIn"]);

    expect(result.filled).toBe(false);
    expect(result.detail).not.toContain("kept");
    expect(result.detail).toContain("Findem");
    expect(result.strayValue).toBe(true);
  });

  it("does not read an old value's announcement as the new answer taking", async () => {
    // A single-select holding a value says "1 item selected" before the click
    // and after it, whether or not the click landed.
    const prompt = new FakePrompt({ LinkedIn: null, Findem: null, Other: null }, "dropdown");
    prompt.selected = ["Findem"];
    prompt.refuses = ["LinkedIn"];
    prompt.announces = true;

    const result = await fillWorkdayPrompt(prompt.asPage(), fieldOf(prompt), ["LinkedIn"]);

    expect(result.filled).toBe(false);
    expect(prompt.selected).toEqual(["Findem"]);
  });
});

describe("a row chosen with the keyboard", () => {
  it("does not take a row the keyboard committed in place of the answer it matched", async () => {
    // The cursor's row is read back from the widget, which can name a row other
    // than the one Enter commits; the committed value is what the form says.
    const prompt = new FakePrompt({ LinkedIn: null, Glassdoor: null, Indeed: null });
    prompt.refuses = ["LinkedIn"];
    prompt.keys = { commits: "Glassdoor", readsAs: "LinkedIn" };

    const result = await fillWorkdayPrompt(prompt.asPage(), fieldOf(prompt), ["LinkedIn"]);

    expect(result.filled).toBe(false);
    expect(prompt.selected).toEqual([]);
  });

  it("still takes the answer when the keyboard commits the row it matched", async () => {
    const prompt = new FakePrompt({ LinkedIn: null, Glassdoor: null, Indeed: null });
    prompt.refuses = ["LinkedIn"];
    prompt.keys = { commits: "LinkedIn", readsAs: "LinkedIn" };

    const result = await fillWorkdayPrompt(prompt.asPage(), fieldOf(prompt), ["LinkedIn"]);

    expect(result.filled).toBe(true);
    expect(prompt.selected).toEqual(["LinkedIn"]);
  });
});

/**
 * Adobe's source question nests every answer one level down. The weak fallback
 * "Job board" matched the "Job Board" category first, which lists only named
 * boards, while the employer's own site - "Adobe.com" - sat under "Adobe
 * Source". The pass gave up after opening the one category.
 */
describe("an approved answer under a sibling category", () => {
  const CANDIDATES = ["Company Careers Page", "adobe.com", "Careers page", "Company website", "Website", "Job board", "Job posting", "Other"];

  it("opens the other categories when the one it matched holds nothing approved", async () => {
    const prompt = new FakePrompt({
      "Adobe Source": ["Adobe.com", "Adobe MAX", "Know Someone at the Company"],
      "Job Board": ["Glassdoor", "LinkedIn"],
      "Social Media": ["Facebook"],
    });

    const result = await fillWorkdayPrompt(prompt.asPage(), fieldOf(prompt), CANDIDATES);

    expect(result.filled).toBe(true);
    expect(prompt.selected).toEqual(["Adobe.com"]);
  });

  it("prefers the better-ranked answer even when a weaker one is found first", async () => {
    const prompt = new FakePrompt({
      "Job Board": ["Glassdoor", "LinkedIn"],
      "External Organizations / Events": ["Other"],
      "Adobe Source": ["Adobe.com", "Adobe MAX"],
    });

    const result = await fillWorkdayPrompt(prompt.asPage(), fieldOf(prompt), CANDIDATES);

    expect(result.filled).toBe(true);
    expect(prompt.selected).toEqual(["Adobe.com"]);
  });

  it("undoes a sibling that turns out to be a value rather than a category", async () => {
    const prompt = new FakePrompt({
      "Job Board": ["Glassdoor", "LinkedIn"],
      "Walk-in": null,
      "Adobe Source": ["Adobe.com"],
    });

    const result = await fillWorkdayPrompt(prompt.asPage(), fieldOf(prompt), CANDIDATES);

    expect(result.filled).toBe(true);
    expect(prompt.selected).toEqual(["Adobe.com"]);
  });

  it("keeps sweeping a single-select that is rendered inside a picker's container", async () => {
    // Nothing can be removed from a single-select, but the next choice replaces
    // a stray, so the sweep may go on where a picker's would have to stop.
    const prompt = new FakePrompt(
      { "Job Board": ["Glassdoor", "LinkedIn"], "Walk-in": null, "Adobe Source": ["Adobe.com"] },
      "single-picker",
      [],
      false,
    );

    const result = await fillWorkdayPrompt(prompt.asPage(), fieldOf(prompt), CANDIDATES);

    expect(result.filled).toBe(true);
    expect(prompt.selected).toEqual(["Adobe.com"]);
  });

  it("still reports failure when no category holds an approved answer", async () => {
    const prompt = new FakePrompt({
      "Job Board": ["Glassdoor", "LinkedIn"],
      "Social Media": ["Facebook"],
    });

    const result = await fillWorkdayPrompt(prompt.asPage(), fieldOf(prompt), CANDIDATES);

    expect(result.filled).toBe(false);
    expect(prompt.selected).toEqual([]);
  });
});

/**
 * Salesforce files every source under "Current or Former Employee", "External
 * Career Site Sources" or "Referral". None of them shares a word with "Company
 * Careers Page" or any careers-page fallback, so no category was ever opened,
 * the employer's name was typed into the next prompt's search instead, and the
 * first step would not advance.
 */
describe("a careers-page answer under a career-site category", () => {
  const label = "How Did You Hear About Us?*";
  const candidates = optionSearchCandidates(
    { selectorIndex: 0, label, type: "select", name: "", required: true },
    {
      questionKey: "how-did-you-hear",
      label,
      answer: "Company Careers Page",
      source: "approved-answer",
      citation: "profile.answers.how-did-you-hear",
      requiresHuman: false,
      category: "general",
    },
    "Salesforce",
  );

  it("opens the career-site category and takes the employer's site inside it", async () => {
    // A single-select, which the per-candidate category probe skips.
    const prompt = new FakePrompt(
      {
        "Current or Former Employee": ["Current Salesforce Employee", "Former Salesforce Employee"],
        "External Career Site Sources": ["Glassdoor", "LinkedIn", "Salesforce Careers Website"],
        Referral: ["Employee Referral"],
      },
      "dropdown",
    );

    const result = await fillWorkdayPrompt(prompt.asPage(), fieldOf(prompt), candidates);

    expect(result.filled).toBe(true);
    expect(prompt.selected).toEqual(["Salesforce Careers Website"]);
  });

  it("claims no referral when the career-site category holds nothing approved", async () => {
    const prompt = new FakePrompt(
      {
        "Current or Former Employee": ["Current Salesforce Employee"],
        "External Career Site Sources": ["Glassdoor", "LinkedIn"],
        Referral: ["Employee Referral"],
      },
      "dropdown",
    );

    const result = await fillWorkdayPrompt(prompt.asPage(), fieldOf(prompt), candidates);

    expect(result.filled).toBe(false);
    expect(prompt.selected).toEqual([]);
  });
});

const CATALOGUE = [
  "Accounting",
  "Computer Engineering",
  "Computer Science",
  "Computer Science, General",
  "Economics",
];

/**
 * A taxonomy too long to render, reachable only through its search box.
 *
 * `runsOn` models the two behaviours seen live: Adobe's tenant filters as keys
 * are typed, Snap's leaves the list untouched until Enter is pressed. Some
 * prompts also select a lone result on Enter instead of listing it. With
 * `boxOutsidePrompt` the only search box is the board's own job search.
 */
class SearchablePrompt extends FakePrompt {
  query = "";
  enterPresses = 0;
  private focused = false;

  constructor(
    tree: Tree,
    private readonly catalogue: readonly string[],
    private readonly runsOn: "keystroke" | "enter",
    private readonly enterSelectsSingle = false,
    private readonly boxOutsidePrompt = false,
    /**
     * `enterCommitsFirstRow` models a single-select that treats Enter on a
     * fruitless search as "take the highlighted row" - the way Adobe's
     * country-code prompt ended on a country nobody chose.
     */
    private readonly extra: { kind?: "picker" | "dropdown"; enterCommitsFirstRow?: boolean } = {},
  ) {
    super(tree, extra.kind ?? "picker");
  }

  private results(): string[] {
    // Workday matches every typed word, in any order: Snap's search for
    // "Computer Science" returned "Computer and Information Science".
    const words = this.query.toLowerCase().split(/\s+/).filter(Boolean);
    return this.catalogue.filter((name) => words.every((word) => name.toLowerCase().includes(word)));
  }

  override locator(selector: string) {
    if (!selector.includes('placeholder="Search"')) return super.locator(selector);
    const pageLevel = selector.includes(":visible");
    if (this.boxOutsidePrompt && !pageLevel) return { count: async () => 0 } as never;
    const self = this;
    const box = {
      first: () => box,
      nth: () => box,
      count: async () => 1,
      isVisible: async () => true,
      waitFor: async () => undefined,
      allInnerTexts: async () => [] as string[],
      evaluate: async () => !self.boxOutsidePrompt,
      locator: (child: string) => self.locator(child),
      click: async () => {
        self.focused = true;
      },
      fill: async (value: string) => {
        self.query = value;
      },
    };
    return box as never;
  }

  override asPage() {
    return {
      ...super.asPage(),
      locator: (selector: string) => this.locator(selector),
      keyboard: {
        type: async (text: string) => {
          this.query += text;
          if (this.runsOn === "keystroke") this.menu = this.results();
        },
        press: async (key: string) => {
          if (key === "Enter" && this.focused) {
            this.enterPresses += 1;
            const found = this.results();
            if (this.enterSelectsSingle && found.length === 1) {
              this.selected = [found[0]!];
              this.menu = [];
              this.focused = false;
              return;
            }
            if (this.extra.enterCommitsFirstRow && found.length === 0 && this.menu.length > 0) {
              this.selected = [this.menu[0]!];
              this.menu = [];
              this.focused = false;
              return;
            }
            this.menu = found;
            return;
          }
          this.focused = false;
          this.menu = [];
        },
      },
    };
  }
}

describe("isWorkdayPrompt", () => {
  it("recognises a picker widget", async () => {
    const prompt = new FakePrompt({ Mobile: null });
    expect(await isWorkdayPrompt(fieldOf(prompt))).toBe(true);
  });
});
