import { describe, expect, it } from "vitest";
import {
  isTaxCreditOptOutStep,
  optOutOfTaxCreditAssessment,
  type AssessmentPage,
  type AssessmentSurface,
} from "../src/submission/workdayAssessment.js";

const WORKDAY = "https://acme.wd5.myworkdayjobs.com/en-US/careers/job/apply/applyManually";

type FakeElement = {
  tag: string;
  text: string;
  role?: string;
  type?: string;
  value?: string;
  hidden?: boolean;
  onClick?: () => void;
};

function matchesPart(element: FakeElement, part: string): boolean {
  const role = /^\[role="(\w+)"\]$/.exec(part);
  if (role) return element.role === role[1];
  const input = /^input\[type="(\w+)"\]$/.exec(part);
  if (input) return element.tag === "input" && element.type === input[1];
  return element.tag === part;
}

function locatorOver(elements: FakeElement[], clicks: string[]) {
  const single = (element: FakeElement | undefined) => ({
    nth: () => single(element),
    count: async () => (element ? 1 : 0),
    isVisible: async () => Boolean(element && !element.hidden),
    innerText: async () => element?.text ?? "",
    getAttribute: async (name: string) => (name === "value" ? (element?.value ?? null) : null),
    click: async () => {
      if (!element) throw new Error("no element");
      clicks.push(element.text || element.value || element.tag);
      element.onClick?.();
    },
  });
  return {
    nth: (index: number) => single(elements[index]),
    count: async () => elements.length,
    isVisible: async () => elements.length > 0,
    innerText: async () => elements.map((element) => element.text).join("\n"),
    click: async () => single(elements[0]).click(),
  };
}

class FakeSurface implements AssessmentSurface {
  elements: FakeElement[];
  body = "";
  address: string;
  constructor(
    elements: FakeElement[],
    address: string,
    readonly clicks: string[],
  ) {
    this.elements = elements;
    this.address = address;
  }
  url(): string {
    return this.address;
  }
  locator(selector: string) {
    if (selector === "body") return locatorOver([{ tag: "body", text: this.body }], this.clicks);
    const parts = selector.split(",").map((part) => part.trim());
    return locatorOver(
      this.elements.filter((element) => parts.some((part) => matchesPart(element, part))),
      this.clicks,
    );
  }
}

class FakePage extends FakeSurface implements AssessmentPage {
  closed = false;
  framesInside: AssessmentSurface[] = [];
  visited: string[] = [];
  popupFactory: (() => FakePage) | null = null;
  private listener: { resolve: (page: unknown) => void; reject: (error: Error) => void } | null = null;
  readonly main: AssessmentSurface = { locator: (selector) => this.locator(selector), url: () => this.url() };
  /** A closed page throws on every wait and every query, as Playwright's does. */
  async waitForTimeout(): Promise<void> {
    if (this.closed) throw new Error("page.waitForTimeout: Target page, context or browser has been closed");
  }
  override locator(selector: string) {
    if (!this.closed) return super.locator(selector);
    const gone = async (): Promise<never> => {
      throw new Error("locator.count: Target page, context or browser has been closed");
    };
    const dead = { nth: () => dead, count: gone, isVisible: gone, innerText: gone, getAttribute: gone, click: gone };
    return dead;
  }
  async waitForLoadState(): Promise<void> {}
  waitForEvent(): Promise<unknown> {
    return new Promise((resolve, reject) => {
      this.listener = { resolve, reject };
    });
  }
  /** What the launch button does: open the vendor window, or nothing at all. */
  launch(): void {
    if (this.popupFactory) this.listener?.resolve(this.popupFactory());
    else this.listener?.reject(new Error("Timeout 10000ms exceeded while waiting for event \"popup\""));
  }
  async goto(url: string): Promise<void> {
    this.visited.push(url);
    this.address = url;
  }
  frames(): AssessmentSurface[] {
    return [this.main, ...this.framesInside];
  }
  mainFrame(): AssessmentSurface {
    return this.main;
  }
  isClosed(): boolean {
    return this.closed;
  }
  async close(): Promise<void> {
    this.closed = true;
  }
}

function workdayStep(clicks: string[]): FakePage {
  const page = new FakePage([], WORKDAY, clicks);
  page.elements = [
    { tag: "button", text: "Back" },
    { tag: "button", text: "Take Assessment", onClick: () => page.launch() },
    { tag: "button", text: "Save and Continue" },
  ];
  return page;
}

const FISERV_STEP =
  "Fiserv participates in the Work Opportunity Tax Credit (WOTC) program, which is a federal benefit " +
  "administered by the U.S. Department of Labor (DOL). Please note that your participation in this " +
  'questionnaire is completely voluntary. If you do not wish to participate, please click "Take ' +
  'Assessment" followed by "Opt Out."';

describe("isTaxCreditOptOutStep", () => {
  it("recognises a tax-credit questionnaire that offers the opt-out", () => {
    expect(isTaxCreditOptOutStep(FISERV_STEP)).toBe(true);
  });

  it("leaves a skills assessment to the candidate", () => {
    expect(isTaxCreditOptOutStep("Please complete the HackerRank coding assessment. You may not opt out.")).toBe(false);
  });

  it("does not decline a tax-credit questionnaire that offers no opt-out", () => {
    expect(isTaxCreditOptOutStep("Complete the Work Opportunity Tax Credit questionnaire to continue.")).toBe(false);
  });
});

describe("optOutOfTaxCreditAssessment", () => {
  it("opts out in a vendor window and reports only the vendor's host", async () => {
    const clicks: string[] = [];
    const page = workdayStep(clicks);
    page.popupFactory = () => {
      const popup = new FakePage([], "https://wotc.example.com/survey/start?candidate=12345&token=secret", clicks);
      popup.elements = [
        { tag: "button", text: "Begin Questionnaire" },
        { tag: "button", text: "Opt Out", onClick: () => (popup.closed = true) },
      ];
      return popup;
    };

    const outcome = await optOutOfTaxCreditAssessment(page);

    expect(outcome.optedOut).toBe(true);
    expect(clicks).toEqual(["Take Assessment", "Opt Out"]);
    expect(outcome.detail).toContain("vendor window");
    expect(outcome.detail).toContain("wotc.example.com");
    expect(outcome.detail).not.toMatch(/token|secret|12345/);
  });

  it("survives a vendor window that closes itself on Opt Out, as Fiserv's does", async () => {
    const clicks: string[] = [];
    const page = workdayStep(clicks);
    page.popupFactory = () => {
      const popup = new FakePage([], "https://wotc.example.com/fiserv/start", clicks);
      popup.elements = [
        { tag: "a", text: "Select Language" },
        { tag: "button", text: "CONTINUE" },
        { tag: "a", text: "Opt Out", onClick: () => (popup.closed = true) },
        { tag: "a", text: "Privacy Policy" },
      ];
      return popup;
    };

    const outcome = await optOutOfTaxCreditAssessment(page);

    expect(outcome).toEqual({ optedOut: true, detail: 'pressed "Opt Out" in a vendor window at wotc.example.com' });
    expect(clicks).toEqual(["Take Assessment", "Opt Out"]);
  });

  it("answers an explicit are-you-sure prompt and nothing that merely says yes", async () => {
    const clicks: string[] = [];
    const page = workdayStep(clicks);
    page.popupFactory = () => {
      const popup = new FakePage([], "https://wotc.example.com/survey", clicks);
      popup.elements = [
        { tag: "button", text: "Yes, I want to participate" },
        {
          tag: "a",
          text: "Opt Out",
          onClick: () => {
            popup.body = "Are you sure you want to opt out of the tax credit screening?";
            popup.elements = [
              { tag: "button", text: "No" },
              { tag: "button", text: "Yes", onClick: () => (popup.closed = true) },
            ];
          },
        },
      ];
      return popup;
    };

    const outcome = await optOutOfTaxCreditAssessment(page);

    expect(outcome.optedOut).toBe(true);
    expect(clicks).toEqual(["Take Assessment", "Opt Out", "Yes"]);
  });

  it("follows a vendor that takes over the tab and comes back to Workday", async () => {
    const clicks: string[] = [];
    const page = new FakePage([], WORKDAY, clicks);
    const step = [{ tag: "button", text: "Save and Continue" }];
    page.elements = [
      {
        tag: "button",
        text: "Take Assessment",
        onClick: () => {
          page.launch();
          page.address = "https://screening.example.net/s/abc?session=xyz";
          page.elements = [
            { tag: "input", type: "submit", text: "", value: "Opt Out", onClick: () => {
              page.address = WORKDAY;
              page.elements = step;
            } },
          ];
        },
      },
    ];

    const outcome = await optOutOfTaxCreditAssessment(page);

    expect(outcome.optedOut).toBe(true);
    expect(clicks).toEqual(["Take Assessment", "Opt Out"]);
    expect(outcome.detail).toContain("same tab");
    expect(outcome.detail).toContain("screening.example.net");
    expect(outcome.detail).not.toContain("session");
    expect(page.visited).toEqual([]);
  });

  it("chooses the opt-out inside a frame and sends it", async () => {
    const clicks: string[] = [];
    const page = new FakePage([], WORKDAY, clicks);
    const frame = new FakeSurface([], "https://inline.example.org/wotc", clicks);
    page.elements = [
      {
        tag: "button",
        text: "Take Assessment",
        onClick: () => {
          page.launch();
          frame.elements = [
            { tag: "label", text: "Yes, I would like to participate" },
            { tag: "label", text: "No, I want to opt out" },
            { tag: "button", text: "Next", onClick: () => (frame.elements = [{ tag: "p", text: "Thank you" }]) },
          ];
          page.framesInside = [frame];
        },
      },
    ];

    const outcome = await optOutOfTaxCreditAssessment(page);

    expect(outcome.optedOut).toBe(true);
    expect(clicks).toEqual(["Take Assessment", "No, I want to opt out", "Next"]);
    expect(outcome.detail).toContain("inside the step");
  });

  it("ignores a cookie opt-out, reports what the vendor offered and closes its window", async () => {
    const clicks: string[] = [];
    const page = workdayStep(clicks);
    const opened: FakePage[] = [];
    page.popupFactory = () => {
      const popup = new FakePage(
        [
          { tag: "a", text: "Opt out of cookies" },
          { tag: "button", text: "Start" },
        ],
        "https://wotc.example.com/start",
        clicks,
      );
      opened.push(popup);
      return popup;
    };

    const outcome = await optOutOfTaxCreditAssessment(page);

    expect(outcome.optedOut).toBe(false);
    expect(clicks).toEqual(["Take Assessment"]);
    expect(outcome.detail).toContain("no opt-out control appeared");
    expect(outcome.detail).toContain('"Start"');
    expect(opened[0]?.closed).toBe(true);
  });

  it("returns a tab the vendor kept to the step it came from", async () => {
    const clicks: string[] = [];
    const page = new FakePage([], WORKDAY, clicks);
    page.elements = [
      {
        tag: "button",
        text: "Take Assessment",
        onClick: () => {
          page.launch();
          page.address = "https://screening.example.net/s/abc";
          page.elements = [{ tag: "button", text: "Begin" }];
        },
      },
    ];

    const outcome = await optOutOfTaxCreditAssessment(page);

    expect(outcome.optedOut).toBe(false);
    expect(page.visited).toEqual([WORKDAY]);
  });

  it("does nothing on a step without a Take Assessment button", async () => {
    const clicks: string[] = [];
    const page = new FakePage([{ tag: "button", text: "Save and Continue" }], WORKDAY, clicks);

    const outcome = await optOutOfTaxCreditAssessment(page);

    expect(outcome).toEqual({ optedOut: false, detail: "the step shows no Take Assessment button" });
    expect(clicks).toEqual([]);
  });
});
