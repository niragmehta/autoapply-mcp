type ChallengePage = {
  locator(selector: string): {
    count(): Promise<number>;
    nth(index: number): { isVisible(): Promise<boolean> };
  };
};

const ACTIVE_CAPTCHA_SELECTORS = [
  'iframe[title*="challenge" i]',
  'iframe[src*="hcaptcha.com" i][src*="frame=challenge" i]',
  '[role="dialog"] iframe[src*="captcha" i]',
  '[role="dialog"] iframe[src*="turnstile" i]',
];

export async function hasVisibleCaptchaChallenge(page: ChallengePage): Promise<boolean> {
  for (const selector of ACTIVE_CAPTCHA_SELECTORS) {
    const frames = page.locator(selector);
    const count = await frames.count();
    // Providers can retain hidden challenge frames for several widgets.
    for (let index = 0; index < count; index += 1) {
      if (await frames.nth(index).isVisible()) return true;
    }
  }
  return false;
}
