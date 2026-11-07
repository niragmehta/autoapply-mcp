import { AppError } from "../../util/errors.js";

/**
 * Browser automation for hosted ATS application forms.
 *
 * Playwright is an optional dependency: the rest of the server works without a
 * browser, and this module only loads it on demand. It never solves a CAPTCHA,
 * never leaves the allowlisted host, and only clicks submit when explicitly
 * told to after the approval guards have passed.
 */

export type AnyPage = {
  goto: (url: string, options?: unknown) => Promise<unknown>;
  reload: (options?: unknown) => Promise<unknown>;
  content: () => Promise<string>;
  evaluate: (fn: unknown, arg?: unknown) => Promise<unknown>;
  locator: (selector: string) => AnyLocator;
  screenshot: (options: Record<string, unknown>) => Promise<unknown>;
  url: () => string;
  waitForTimeout: (ms: number) => Promise<void>;
  waitForLoadState: (state: string, options?: unknown) => Promise<void>;
  title: () => Promise<string>;
  keyboard: { press: (key: string) => Promise<void>; type: (text: string, options?: unknown) => Promise<void> };
  // Optional so the test doubles do not have to model the event emitter.
  on?: (event: string, handler: (payload: never) => void) => void;
  off?: (event: string, handler: (payload: never) => void) => void;
};
export type AnyLocator = {
  first: () => AnyLocator;
  nth: (index: number) => AnyLocator;
  locator: (selector: string) => AnyLocator;
  count: () => Promise<number>;
  fill: (value: string, options?: unknown) => Promise<void>;
  pressSequentially: (value: string, options?: unknown) => Promise<void>;
  selectOption: (value: unknown, options?: unknown) => Promise<unknown>;
  setInputFiles: (files: string, options?: unknown) => Promise<void>;
  check: (options?: unknown) => Promise<void>;
  uncheck?: (options?: unknown) => Promise<void>;
  isChecked?: () => Promise<boolean>;
  click: (options?: unknown) => Promise<void>;
  isVisible: () => Promise<boolean>;
  isEnabled?: () => Promise<boolean>;
  inputValue?: () => Promise<string>;
  press?: (key: string, options?: unknown) => Promise<void>;
  innerText: () => Promise<string>;
  getAttribute: (name: string) => Promise<string | null>;
  allInnerTexts: () => Promise<string[]>;
  waitFor: (options?: unknown) => Promise<void>;
};

export async function loadPlaywright(): Promise<Record<string, { launch: (options: unknown) => Promise<AnyBrowser> }>> {
  const specifier = "playwright";
  try {
    return (await import(specifier)) as unknown as Record<string, { launch: (options: unknown) => Promise<AnyBrowser> }>;
  } catch {
    throw new AppError(
      "playwright_missing",
      'browser automation needs Playwright. Install it with "npm install playwright" and "npx playwright install chromium".',
    );
  }
}

type AnyBrowser = {
  newContext: (options?: unknown) => Promise<{ newPage: () => Promise<AnyPage>; close: () => Promise<void> }>;
  close: () => Promise<void>;
};

export type PersistentContext = {
  pages: () => AnyPage[];
  newPage: () => Promise<AnyPage>;
  close: () => Promise<void>;
};
export type PersistentLauncher = {
  launchPersistentContext: (userDataDir: string, options: unknown) => Promise<PersistentContext>;
};
