import vm from "node:vm";
import { describe, expect, it } from "vitest";

import { buildOverlayClickScript } from "../src/submission/workdayFlow.js";

/**
 * Workday's real markup, reduced to what the click path depends on: a button
 * carrying the data-automation-id and a transparent overlay laid over it.
 */
class FakeElement {
  readonly attrs: Record<string, string>;
  readonly children: FakeElement[] = [];
  parentElement: FakeElement | null = null;
  textContent: string;
  clicked = 0;

  constructor(attrs: Record<string, string> = {}, textContent = "") {
    this.attrs = attrs;
    this.textContent = textContent;
  }

  append(...children: FakeElement[]): this {
    for (const child of children) {
      child.parentElement = this;
      this.children.push(child);
    }
    return this;
  }

  getAttribute(name: string): string | null {
    return this.attrs[name] ?? null;
  }

  click(): void {
    this.clicked += 1;
  }

  private descendants(): FakeElement[] {
    return this.children.flatMap((child) => [child, ...child.descendants()]);
  }

  querySelectorAll(selector: string): FakeElement[] {
    const match = /^\[data-automation-id="(.+)"\]$/.exec(selector);
    if (!match) throw new Error(`unsupported selector: ${selector}`);
    return this.descendants().filter((el) => el.attrs["data-automation-id"] === match[1]);
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

const SIGN_IN = '[data-automation-id="signInSubmitButton"]';

function run(root: FakeElement, selector: string): string {
  const document = { querySelector: (sel: string) => root.querySelector(sel) };
  return vm.runInNewContext(buildOverlayClickScript(selector), { document }) as string;
}

function overlay(label: string): FakeElement {
  return new FakeElement({ "data-automation-id": "click_filter", "aria-label": label });
}

function signInButton(): FakeElement {
  return new FakeElement({ "data-automation-id": "signInSubmitButton" }, "Sign In");
}

describe("clicking a Workday control past its click-filter overlay", () => {
  it("clicks the overlay that intercepts pointer events, not the hidden button", () => {
    const button = signInButton();
    const filter = overlay("Sign In");
    const root = new FakeElement().append(new FakeElement().append(button, filter));

    expect(run(root, SIGN_IN)).toBe("overlay");
    expect(filter.clicked).toBe(1);
    expect(button.clicked, "the aria-hidden button must not be clicked").toBe(0);
  });

  it("picks the overlay whose label matches when several share an ancestor", () => {
    const button = signInButton();
    const wrong = overlay("Create Account");
    const right = overlay("Sign In");
    const root = new FakeElement().append(new FakeElement().append(button, wrong, right));

    expect(run(root, SIGN_IN)).toBe("overlay");
    expect(right.clicked).toBe(1);
    expect(wrong.clicked, "a neighbouring button must never be clicked").toBe(0);
  });

  it("leaves an ambiguous overlay group alone rather than guessing", () => {
    const button = signInButton();
    const first = overlay("Create Account");
    const second = overlay("Cancel");
    const root = new FakeElement().append(new FakeElement().append(button, first, second));

    expect(run(root, SIGN_IN)).toBe("direct");
    expect(first.clicked).toBe(0);
    expect(second.clicked).toBe(0);
    expect(button.clicked, "falls back to the button when no overlay is identifiable").toBe(1);
  });

  it("finds an overlay that sits further up the tree", () => {
    const button = signInButton();
    const filter = overlay("Sign In");
    const root = new FakeElement().append(
      new FakeElement().append(new FakeElement().append(new FakeElement().append(button)), filter),
    );

    expect(run(root, SIGN_IN)).toBe("overlay");
    expect(filter.clicked).toBe(1);
  });

  it("clicks the control directly when the tenant renders no overlay", () => {
    const button = signInButton();
    const root = new FakeElement().append(new FakeElement().append(button));

    expect(run(root, SIGN_IN)).toBe("direct");
    expect(button.clicked).toBe(1);
  });

  it("reports a missing control instead of clicking something else", () => {
    const root = new FakeElement().append(new FakeElement().append(overlay("Sign In")));

    expect(run(root, SIGN_IN)).toBe("missing");
  });

  it("matches on aria-label when the control carries no text", () => {
    const button = new FakeElement({
      "data-automation-id": "signInSubmitButton",
      "aria-label": "Sign In",
    });
    const wrong = overlay("Create Account");
    const right = overlay("Sign In");
    const root = new FakeElement().append(new FakeElement().append(button, wrong, right));

    expect(run(root, SIGN_IN)).toBe("overlay");
    expect(right.clicked).toBe(1);
  });
});
