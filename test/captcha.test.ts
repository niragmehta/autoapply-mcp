import { describe, expect, it } from "vitest";
import { hasVisibleCaptchaChallenge } from "../src/submission/captcha.js";

function challengePage(frames: Readonly<Record<string, readonly boolean[]>>) {
  return {
    locator: (selector: string) => ({
      count: async () => frames[selector]?.length ?? 0,
      nth: (index: number) => ({
        isVisible: async () => frames[selector]?.[index] ?? false,
      }),
    }),
  };
}

describe("hasVisibleCaptchaChallenge", () => {
  it("finds a visible challenge after an earlier hidden challenge frame", async () => {
    const page = challengePage({ 'iframe[title*="challenge" i]': [false, true] });

    expect(await hasVisibleCaptchaChallenge(page)).toBe(true);
  });

  it("finds a visible first challenge frame", async () => {
    const page = challengePage({ 'iframe[title*="challenge" i]': [true, false] });

    expect(await hasVisibleCaptchaChallenge(page)).toBe(true);
  });

  it("recognizes an hCaptcha challenge by its frame URL when its title is absent", async () => {
    const page = challengePage({
      'iframe[src*="hcaptcha.com" i][src*="frame=challenge" i]': [false, true],
    });

    expect(await hasVisibleCaptchaChallenge(page)).toBe(true);
  });

  it.each([
    '[role="dialog"] iframe[src*="captcha" i]',
    '[role="dialog"] iframe[src*="turnstile" i]',
  ])("checks every frame in an active challenge dialog: %s", async (selector) => {
    expect(await hasVisibleCaptchaChallenge(challengePage({ [selector]: [false, true] }))).toBe(true);
  });

  it("does not block when all challenge frames are hidden", async () => {
    const page = challengePage({
      'iframe[title*="challenge" i]': [false, false],
      '[role="dialog"] iframe[src*="captcha" i]': [false],
    });

    expect(await hasVisibleCaptchaChallenge(page)).toBe(false);
  });

  it("does not treat a passive checkbox or badge as an active puzzle", async () => {
    const page = challengePage({
      'iframe[title="reCAPTCHA"]': [true],
      'iframe[src*="frame=checkbox"]': [true],
    });

    expect(await hasVisibleCaptchaChallenge(page)).toBe(false);
  });

  it("propagates a failed visibility read rather than treating it as proof of no challenge", async () => {
    const page = {
      locator: () => ({
        count: async () => 1,
        nth: () => ({ isVisible: async () => { throw new Error("Page closed"); } }),
      }),
    };

    await expect(hasVisibleCaptchaChallenge(page)).rejects.toThrow("Page closed");
  });
});
