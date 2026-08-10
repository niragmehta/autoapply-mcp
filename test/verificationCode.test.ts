import { describe, expect, it } from "vitest";

import { detectVerificationCodeGate, fillSegmentedCode, submitVerificationCode } from "../src/submission/browser.js";

/**
 * Greenhouse renders the code as one box per character, so a single fill()
 * would deliver one character and leave the rest blank.
 */
function segmentedPage(boxCount: number, options: { visible?: boolean; rejects?: boolean } = {}) {
  const values: string[] = new Array(boxCount).fill("");
  const boxes = {
    count: async () => boxCount,
    nth: (index: number) => ({
      isVisible: async () => options.visible ?? true,
      fill: async (value: string) => {
        values[index] = options.rejects ? "" : value;
      },
      inputValue: async () => values[index] ?? "",
    }),
  };
  return {
    values,
    page: { locator: (selector: string) => (selector === 'input[maxlength="1"]' ? boxes : { count: async () => 0 }) },
  };
}

/** Verbatim from Stripe's Greenhouse form on 2026-08-08. */
const STRIPE = `A verification code was sent to candidate@example.com. To submit your
application, enter the 8-character code to confirm you're a human. Security code`;

describe("emailed verification code detection", () => {
  it("names the gate instead of reporting an unexplained failure", () => {
    expect(detectVerificationCodeGate(STRIPE)).toBe(
      "A verification code was sent to candidate@example.com.",
    );
  });

  it("recognises the code prompt on its own", () => {
    expect(
      detectVerificationCodeGate("Please enter the 6-character code to confirm you're a human."),
    ).toContain("6-character code");
  });

  it("recognises other one-time code phrasings", () => {
    expect(detectVerificationCodeGate("We sent a one-time code to n@example.com.")).toBeDefined();
    expect(detectVerificationCodeGate("Check your email for a verification code")).toBeDefined();
  });

  it("does not fire on an ordinary confirmation page", () => {
    expect(
      detectVerificationCodeGate("Thank you for applying. Your application has been received."),
    ).toBeUndefined();
  });

  it("does not fire on a validation error", () => {
    expect(detectVerificationCodeGate("This field is required.")).toBeUndefined();
  });
});

describe("segmented code entry", () => {
  it("puts one character in each box", async () => {
    const { page, values } = segmentedPage(8);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await fillSegmentedCode(page as any, "N8NFAEQw")).not.toBeNull();
    expect(values.join("")).toBe("N8NFAEQw");
  });

  it("refuses when the box count does not match the code length", async () => {
    // A partial code would be submitted as if complete.
    const { page, values } = segmentedPage(6);

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await fillSegmentedCode(page as any, "N8NFAEQw")).toBeNull();
    expect(values.join("")).toBe("");
  });

  it("refuses when a box does not keep the character it was given", async () => {
    const { page } = segmentedPage(8, { rejects: true });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await fillSegmentedCode(page as any, "N8NFAEQw")).toBeNull();
  });

  it("ignores hidden boxes", async () => {
    const { page } = segmentedPage(8, { visible: false });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await fillSegmentedCode(page as any, "N8NFAEQw")).toBeNull();
  });

  it("reports no segmented layout when the page has none", async () => {
    const page = { locator: () => ({ count: async () => 0 }) };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await fillSegmentedCode(page as any, "N8NFAEQw")).toBeNull();
  });
});

describe("submitting the code", () => {
  /**
   * A job post keeps its own apply control in the document while the code gate
   * is showing, so an unscoped search finds the wrong button and the typed code
   * is never sent.
   */
  function gatedPage() {
    const clicked: string[] = [];
    const control = (name: string, visible = true) => ({
      first: () => ({
        count: async () => 1,
        isVisible: async () => visible,
        click: async () => {
          clicked.push(name);
        },
      }),
    });
    return {
      clicked,
      page: {
        locator: (selector: string) => {
          if (selector.startsWith("form:has(input[maxlength=")) return control("code-form-submit");
          if (selector === 'button[type="submit"]') return control("page-apply");
          return { first: () => ({ count: async () => 0, isVisible: async () => false }) };
        },
      },
    };
  }

  it("clicks the button belonging to the code form, not the job post's apply button", async () => {
    const { page, clicked } = gatedPage();
    const box = { press: async () => undefined };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await submitVerificationCode(page as any, box as any)).toBe(true);
    expect(clicked).toEqual(["code-form-submit"]);
  });

  it("presses Enter in the code field when the gate has no button of its own", async () => {
    const clicked: string[] = [];
    const page = {
      locator: () => ({ first: () => ({ count: async () => 0, isVisible: async () => false }) }),
    };
    const box = {
      press: async (key: string) => {
        clicked.push(key);
      },
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(await submitVerificationCode(page as any, box as any)).toBe(true);
    expect(clicked).toEqual(["Enter"]);
  });
});