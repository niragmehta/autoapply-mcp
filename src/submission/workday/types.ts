export type Page = {
  goto: (url: string, options?: unknown) => Promise<unknown>;
  locator: (selector: string) => Locator;
  url: () => string;
  waitForTimeout: (ms: number) => Promise<void>;
  waitForLoadState: (state: string, options?: unknown) => Promise<void>;
  evaluate: (fn: unknown, arg?: unknown) => Promise<unknown>;
  reload: (options?: unknown) => Promise<unknown>;
  keyboard: {
    press: (key: string) => Promise<void>;
    type: (text: string, options?: unknown) => Promise<void>;
  };
  /** Present on a live page; opens an emailed link beside the application. */
  context?: () => { newPage: () => Promise<BrowserTab> };
};
/** A second tab of the same browser context, sharing its cookies. */
export type BrowserTab = {
  goto: (url: string, options?: unknown) => Promise<unknown>;
  waitForLoadState: (state: string, options?: unknown) => Promise<void>;
  waitForTimeout: (ms: number) => Promise<void>;
  locator: (selector: string) => { allInnerTexts: () => Promise<string[]> };
  close: () => Promise<void>;
};
export type Locator = {
  first: () => Locator;
  nth: (index: number) => Locator;
  count: () => Promise<number>;
  click: (options?: unknown) => Promise<void>;
  fill: (value: string, options?: unknown) => Promise<void>;
  isVisible: () => Promise<boolean>;
  waitFor: (options?: unknown) => Promise<void>;
  locator: (selector: string) => Locator;
  allInnerTexts: () => Promise<string[]>;
  innerText?: () => Promise<string>;
  evaluate?: (fn: unknown, arg?: unknown) => Promise<unknown>;
  elementHandle?: () => Promise<{ dispose: () => Promise<void> } | null>;
};

/**
 * `strayValue` marks a failure that leaves the field stating something nobody
 * approved - a probe's selection that would not undo, or a value an earlier
 * run left that the approved answer could not replace. A blank optional field
 * can be skipped; one of these cannot, because it would be submitted as said.
 */
export type WorkdayPromptResult = { filled: boolean; detail: string; strayValue?: boolean };
