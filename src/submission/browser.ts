import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { SubmissionPolicy } from "../domain/campaign.js";
import { AppError } from "../util/errors.js";
import { logger } from "../util/logger.js";
import { assertUrlAllowed, checkUrlAllowed } from "./allowlist.js";
import { buildFillPlan, detectCaptcha, type FieldDescriptor } from "./formFields.js";
import type { SubmissionPacket } from "./packet.js";

/**
 * Browser automation for hosted ATS application forms.
 *
 * Playwright is an optional dependency: the rest of the server works without a
 * browser, and this module only loads it on demand. It never solves a CAPTCHA,
 * never leaves the allowlisted host, and only clicks submit when explicitly
 * told to after the approval guards have passed.
 */

type AnyPage = {
  goto: (url: string, options?: unknown) => Promise<unknown>;
  content: () => Promise<string>;
  evaluate: (fn: unknown, arg?: unknown) => Promise<unknown>;
  locator: (selector: string) => AnyLocator;
  screenshot: (options: Record<string, unknown>) => Promise<unknown>;
  url: () => string;
  waitForTimeout: (ms: number) => Promise<void>;
  waitForLoadState: (state: string, options?: unknown) => Promise<void>;
  title: () => Promise<string>;
};
type AnyLocator = {
  first: () => AnyLocator;
  count: () => Promise<number>;
  fill: (value: string, options?: unknown) => Promise<void>;
  selectOption: (value: unknown, options?: unknown) => Promise<unknown>;
  setInputFiles: (files: string, options?: unknown) => Promise<void>;
  check: (options?: unknown) => Promise<void>;
  click: (options?: unknown) => Promise<void>;
  isVisible: () => Promise<boolean>;
  innerText: () => Promise<string>;
};

async function loadPlaywright(): Promise<Record<string, { launch: (options: unknown) => Promise<AnyBrowser> }>> {
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

export type BrowserRunOptions = {
  headless?: boolean;
  submit: boolean;
  artifactsDir: string;
  policy: SubmissionPolicy;
  timeoutMs?: number;
  /**
   * Milliseconds to leave a filled form open for a person to review and submit
   * themselves. Only used when `submit` is false.
   */
  keepOpenMs?: number;
};

export type BrowserRunResult = {
  status: "prepared" | "submitted" | "aborted";
  reason: string;
  filledFields: Array<{ label: string; source: string }>;
  unmatchedRequired: string[];
  unusedAnswers: string[];
  screenshotPath: string | null;
  finalUrl: string;
  confirmationText: string;
  captchaDetected: boolean;
};

/** Runs in the page: tags every form control and returns its descriptor. */
const COLLECT_FIELDS = `() => {
  const controls = Array.from(document.querySelectorAll('input, textarea, select'));
  const visible = (el) => {
    const style = window.getComputedStyle(el);
    return style.display !== 'none' && style.visibility !== 'hidden' && el.type !== 'hidden';
  };
  const labelFor = (el) => {
    if (el.id) {
      const explicit = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (explicit && explicit.innerText.trim()) return explicit.innerText.trim();
    }
    const wrapper = el.closest('label');
    if (wrapper && wrapper.innerText.trim()) return wrapper.innerText.trim();
    const aria = el.getAttribute('aria-label');
    if (aria) return aria.trim();
    const labelledBy = el.getAttribute('aria-labelledby');
    if (labelledBy) {
      const target = document.getElementById(labelledBy);
      if (target && target.innerText.trim()) return target.innerText.trim();
    }
    const placeholder = el.getAttribute('placeholder');
    if (placeholder) return placeholder.trim();
    return el.getAttribute('name') || '';
  };
  const out = [];
  controls.filter(visible).forEach((el, index) => {
    el.setAttribute('data-autoapply-idx', String(index));
    out.push({
      selectorIndex: index,
      label: labelFor(el).slice(0, 200),
      type: (el.tagName.toLowerCase() === 'select' ? 'select' : (el.type || 'text')).toLowerCase(),
      name: el.getAttribute('name') || '',
      required: el.hasAttribute('required') || el.getAttribute('aria-required') === 'true',
    });
  });
  return out;
}`;

const SUBMIT_SELECTORS = [
  'button[type="submit"]',
  'input[type="submit"]',
  'button:has-text("Submit application")',
  'button:has-text("Submit Application")',
  'button:has-text("Submit")',
  'button:has-text("Apply")',
];

/**
 * Opens an application form, fills what the packet supports, and captures a
 * screenshot. Submits only when `submit` is true.
 */
export async function runApplicationForm(packet: SubmissionPacket, options: BrowserRunOptions): Promise<BrowserRunResult> {
  assertUrlAllowed(packet.applyUrl, options.policy);
  const playwright = await loadPlaywright();
  const chromium = playwright.chromium;
  if (!chromium) throw new AppError("playwright_missing", "Playwright chromium driver unavailable");

  mkdirSync(options.artifactsDir, { recursive: true });
  const timeout = options.timeoutMs ?? 45_000;
  const browser = await chromium.launch({ headless: options.headless ?? false });

  try {
    const context = await browser.newContext({ acceptDownloads: false });
    const page = await context.newPage();
    await page.goto(packet.applyUrl, { waitUntil: "domcontentloaded", timeout });
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);

    if (!checkUrlAllowed(page.url(), options.policy).allowed) {
      return aborted(`page redirected off the allowlist to ${page.url()}`, page.url());
    }

    const html = await page.content();
    if (detectCaptcha(html)) {
      const shot = await capture(page, options.artifactsDir, packet.applicationId, "captcha");
      return {
        status: "aborted",
        reason: "anti-bot challenge detected; this application must be completed by a human",
        filledFields: [],
        unmatchedRequired: [],
        unusedAnswers: [],
        screenshotPath: shot,
        finalUrl: page.url(),
        confirmationText: "",
        captchaDetected: true,
      };
    }

    const fields = (await page.evaluate(COLLECT_FIELDS)) as FieldDescriptor[];
    const plan = buildFillPlan(fields, packet.answers);
    const filled: Array<{ label: string; source: string }> = [];

    for (const match of plan.toFill) {
      const locator = page.locator(`[data-autoapply-idx="${match.field.selectorIndex}"]`).first();
      const value = match.answer!.answer;
      try {
        await fillControl(locator, match.field.type, value);
        filled.push({ label: match.field.label, source: match.answer!.source });
      } catch (error) {
        logger.warn("field fill failed", { label: match.field.label, error: String(error) });
      }
    }

    await attachResume(page, packet.resumePath);

    const screenshotPath = await capture(page, options.artifactsDir, packet.applicationId, "prepared");

    if (!options.submit) {
      const keepOpenMs = options.keepOpenMs ?? 0;
      if (keepOpenMs > 0) {
        logger.info("holding form open for human review", { keepOpenMs, url: page.url() });
        await page.waitForTimeout(keepOpenMs);
      }
      return {
        status: "prepared",
        reason:
          keepOpenMs > 0
            ? "form filled and left open for human review and submission"
            : "form filled and captured; submission not requested",
        filledFields: filled,
        unmatchedRequired: plan.unmatchedRequired.map((field) => field.label),
        unusedAnswers: plan.unusedAnswers.map((answer) => answer.label),
        screenshotPath,
        finalUrl: page.url(),
        confirmationText: "",
        captchaDetected: false,
      };
    }

    if (plan.unmatchedRequired.length > 0) {
      return {
        status: "aborted",
        reason: `required field(s) could not be filled: ${plan.unmatchedRequired.map((f) => f.label).join("; ")}`,
        filledFields: filled,
        unmatchedRequired: plan.unmatchedRequired.map((field) => field.label),
        unusedAnswers: plan.unusedAnswers.map((answer) => answer.label),
        screenshotPath,
        finalUrl: page.url(),
        confirmationText: "",
        captchaDetected: false,
      };
    }

    const clicked = await clickSubmit(page);
    if (!clicked) {
      return {
        status: "aborted",
        reason: "no submit control found on the page",
        filledFields: filled,
        unmatchedRequired: [],
        unusedAnswers: plan.unusedAnswers.map((answer) => answer.label),
        screenshotPath,
        finalUrl: page.url(),
        confirmationText: "",
        captchaDetected: false,
      };
    }

    await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => undefined);
    await page.waitForTimeout(1500);
    const confirmationShot = await capture(page, options.artifactsDir, packet.applicationId, "confirmation");
    const confirmationText = (await page.locator("body").first().innerText().catch(() => "")).slice(0, 600);

    return {
      status: "submitted",
      reason: "submit control clicked and confirmation captured",
      filledFields: filled,
      unmatchedRequired: [],
      unusedAnswers: plan.unusedAnswers.map((answer) => answer.label),
      screenshotPath: confirmationShot,
      finalUrl: page.url(),
      confirmationText,
      captchaDetected: false,
    };
  } finally {
    await browser.close().catch(() => undefined);
  }
}

function aborted(reason: string, finalUrl: string): BrowserRunResult {
  return {
    status: "aborted",
    reason,
    filledFields: [],
    unmatchedRequired: [],
    unusedAnswers: [],
    screenshotPath: null,
    finalUrl,
    confirmationText: "",
    captchaDetected: false,
  };
}

async function fillControl(locator: AnyLocator, type: string, value: string): Promise<void> {
  if (type === "select") {
    await locator.selectOption({ label: value });
    return;
  }
  if (type === "checkbox" || type === "radio") {
    if (/^(yes|true|1|on|i agree|agree)$/i.test(value.trim())) await locator.check();
    return;
  }
  if (type === "file") return;
  await locator.fill(value);
}

async function attachResume(page: AnyPage, resumePath: string): Promise<void> {
  if (!resumePath) return;
  const fileInput = page.locator('input[type="file"]').first();
  if ((await fileInput.count()) === 0) return;
  await fileInput.setInputFiles(resumePath).catch((error: unknown) => {
    logger.warn("resume upload failed", { error: String(error) });
  });
}

async function clickSubmit(page: AnyPage): Promise<boolean> {
  for (const selector of SUBMIT_SELECTORS) {
    const locator = page.locator(selector).first();
    if ((await locator.count()) > 0 && (await locator.isVisible().catch(() => false))) {
      await locator.click();
      return true;
    }
  }
  return false;
}

async function capture(page: AnyPage, dir: string, applicationId: string, stage: string): Promise<string> {
  const path = join(dir, `${applicationId}-${stage}-${Date.now()}.png`);
  await page.screenshot({ path, fullPage: true }).catch(() => undefined);
  return path;
}
