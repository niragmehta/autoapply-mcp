import type { BrowserRunResult } from "../browser/types.js";
import type { SubmissionPacket } from "../packet.js";

export type CareerSite = "google" | "meta" | "amazon" | "apple";

/** Page operations the walkers use; satisfied by Playwright's Page. */
export type SitePage = {
  goto: (url: string, options?: unknown) => Promise<unknown>;
  url: () => string;
  evaluate: (fn: unknown, arg?: unknown) => Promise<unknown>;
  locator: (selector: string) => SiteLocator;
  waitForTimeout: (ms: number) => Promise<void>;
  waitForLoadState: (state: string, options?: unknown) => Promise<void>;
  waitForEvent?: (event: string, options?: unknown) => Promise<{ setFiles: (files: unknown) => Promise<void> }>;
};
export type SiteLocator = {
  first: () => SiteLocator;
  nth: (index: number) => SiteLocator;
  count: () => Promise<number>;
  click: (options?: unknown) => Promise<void>;
  isEnabled?: () => Promise<boolean>;
  setInputFiles: (files: unknown, options?: unknown) => Promise<void>;
  innerText: () => Promise<string>;
};

export type StepFill = { filled: Array<{ label: string; source: string }>; problems: string[] };

/** What the walkers borrow from the generic form filler in browser.ts. */
export type CareerSiteHooks = {
  /** Fills the current step from the packet, the answer bank and the resolvers. */
  fillStep: () => Promise<StepFill | BrowserRunResult>;
  /**
   * The offered option that answers one choice question, decided by the same
   * matching the generic filler uses, or null when nothing on record answers
   * it. For widgets the generic filler cannot see, such as Select2 dropdowns.
   */
  resolveChoice: (label: string, options: readonly string[]) => string | null;
  capture: (stage: string) => Promise<string>;
  readText: () => Promise<string>;
};

export type CareerSiteRun = {
  site: CareerSite;
  page: SitePage;
  packet: SubmissionPacket;
  submit: boolean;
  relocationTargets: readonly string[];
  hooks: CareerSiteHooks;
};
