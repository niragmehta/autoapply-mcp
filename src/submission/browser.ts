import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { SubmissionPolicy } from "../domain/campaign.js";
import { AppError } from "../util/errors.js";
import { logger } from "../util/logger.js";
import { assertUrlAllowed, checkUrlAllowed } from "./allowlist.js";
import {
  answerValueForField,
  augmentAnswersForBrowser,
  buildFillPlan,
  detectCaptcha,
  detectSubmissionConfirmation,
  fallbackAnswersForFields,
  looksLikeApplicationForm,
  optionSearchCandidates,
  orderFieldsForBrowser,
  pickOptionIndex,
  type ApprovedAnswerEntry,
  type FieldDescriptor,
  type PersonalResolver,
  type NarrativeResolver,
} from "./formFields.js";
import { validateResumeFile } from "./resume.js";
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
  keyboard: { press: (key: string) => Promise<void> };
};
type AnyLocator = {
  first: () => AnyLocator;
  nth: (index: number) => AnyLocator;
  locator: (selector: string) => AnyLocator;
  count: () => Promise<number>;
  fill: (value: string, options?: unknown) => Promise<void>;
  selectOption: (value: unknown, options?: unknown) => Promise<unknown>;
  setInputFiles: (files: string, options?: unknown) => Promise<void>;
  check: (options?: unknown) => Promise<void>;
  click: (options?: unknown) => Promise<void>;
  isVisible: () => Promise<boolean>;
  innerText: () => Promise<string>;
  getAttribute: (name: string) => Promise<string | null>;
  allInnerTexts: () => Promise<string[]>;
  waitFor: (options?: unknown) => Promise<void>;
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
  candidateCountry?: string;
  /**
   * Pre-approved answers used to fill questions the packet never enumerated,
   * which happens on boards that publish no question schema.
   */
  answerBank?: readonly ApprovedAnswerEntry[];
  /** Resolves stored personal and demographic answers for live field labels. */
  personalResolver?: PersonalResolver;
  /** Resolves employment-history fields from the candidate's stored positions. */
  experienceResolver?: PersonalResolver;
  narrativeResolver?: NarrativeResolver;
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
  /**
   * Fields left for a person: optional questions with no approved answer, and
   * anything the campaign deliberately withholds such as arbitration receipts.
   * Only populated once a form has been analysed.
   */
  leftForHuman?: string[];
  unusedAnswers: string[];
  screenshotPath: string | null;
  finalUrl: string;
  confirmationText: string;
  captchaDetected: boolean;
};

/** Runs in the page: tags every form control and returns its descriptor. */
export const COLLECT_FIELDS = `(() => {
  const controls = Array.from(document.querySelectorAll('input, textarea, select'));
  const visible = (el) => {
    const style = window.getComputedStyle(el);
    const ashbyBoolean = el.type === 'checkbox' && el.closest('.ashby-application-form-field-entry');
    return ashbyBoolean || (style.display !== 'none' && style.visibility !== 'hidden' && el.type !== 'hidden');
  };
  const labelFor = (el) => {
    if (el.id) {
      const explicit = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (explicit && explicit.innerText.trim()) return explicit.innerText.trim();
    }
    const wrapper = el.closest('label');
    const ashbyEntry = el.closest('.ashby-application-form-field-entry');
    const ashbyLabel = ashbyEntry && ashbyEntry.querySelector('.ashby-application-form-question-title');
    if (ashbyLabel && ashbyLabel.innerText.trim()) return ashbyLabel.innerText.trim();
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
  const optionLabelFor = (el) => {
    if (el.id) {
      const explicit = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (explicit && explicit.innerText.trim()) return explicit.innerText.trim();
    }
    // Ashby nests the input inside its option label, with no id to point at.
    const wrapper = el.closest('label');
    if (wrapper && wrapper.innerText.trim()) return wrapper.innerText.trim();
    const sibling = el.nextElementSibling;
    if (sibling && sibling.innerText && sibling.innerText.trim()) return sibling.innerText.trim();
    const aria = el.getAttribute('aria-label');
    if (aria && aria.trim()) return aria.trim();
    return (el.getAttribute('value') || '').trim();
  };
  const groupLabel = (el) => {
    const fieldset = el.closest('fieldset');
    if (fieldset) {
      const selectors = [
        ':scope > legend',
        ':scope > .ashby-application-form-question-title',
        ':scope > label',
      ];
      for (const selector of selectors) {
        const title = fieldset.querySelector(selector);
        if (title && title.innerText.trim()) return title.innerText.trim();
      }
    }
    const ashbyEntry = el.closest('.ashby-application-form-field-entry');
    const ashbyTitle = ashbyEntry && ashbyEntry.querySelector('.ashby-application-form-question-title');
    if (ashbyTitle && ashbyTitle.innerText.trim()) return ashbyTitle.innerText.trim();
    const radiogroup = el.closest('[role="radiogroup"]');
    const aria = radiogroup && radiogroup.getAttribute('aria-label');
    return aria ? aria.trim() : '';
  };
  const out = [];
  controls.filter(visible).forEach((el) => {
    const isRadio = el.type === 'radio';
    const optionLabel = (isRadio ? optionLabelFor(el) : labelFor(el)).slice(0, 200);
    const group = isRadio ? groupLabel(el).slice(0, 200) : '';
    const label = group || optionLabel;
    const name = el.getAttribute('name') || '';
    const role = el.getAttribute('role') || '';
    const ashbyEntry = el.closest('.ashby-application-form-field-entry');
    const ashbyLabel = ashbyEntry && ashbyEntry.querySelector('.ashby-application-form-question-title');
    if (!label && !name && !el.id && role !== 'combobox') return;
    const index = out.length;
    el.setAttribute('data-autoapply-idx', String(index));
    out.push({
      selectorIndex: index,
      label,
      optionLabel: group ? optionLabel : undefined,
      type: (el.tagName.toLowerCase() === 'select' ? 'select' : (el.type || 'text')).toLowerCase(),
      name,
      required:
        el.hasAttribute('required') ||
        el.getAttribute('aria-required') === 'true' ||
        Boolean(ashbyLabel && String(ashbyLabel.className).includes('_required_')),
      role,
    });
  });
  return out;
})()`;

const SUBMIT_SELECTORS = [
  'button[type="submit"]',
  'input[type="submit"]',
  'button:has-text("Submit application")',
  'button:has-text("Submit Application")',
  'button:has-text("Submit")',
  'button:has-text("Apply")',
];

const ACTIVE_CAPTCHA_SELECTORS = [
  'iframe[title*="challenge" i]',
  '[role="dialog"] iframe[src*="captcha" i]',
  '[role="dialog"] iframe[src*="turnstile" i]',
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

    const pageText = await readBodyText(page);
    // A passive reCAPTCHA v3 badge only leaves "protected by reCAPTCHA" in the
    // page text and needs no human action, so it must not abort a fill-only
    // (assisted) run. Anything actually interactive still aborts, and a
    // self-submitting run stays strict.
    const interactiveChallenge = await hasVisibleCaptchaChallenge(page);
    if (interactiveChallenge || (options.submit && detectCaptcha(pageText))) {
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

    await attachResume(page, packet.resumePath);
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
    if (/\.ashbyhq\.com$/i.test(new URL(page.url()).hostname)) {
      await page
        .locator("text=Autofill completed!")
        .first()
        .waitFor({ state: "visible", timeout: 15_000 })
        .catch(() => undefined);
    }
    await page.waitForTimeout(1000);

    const fields = (await page.evaluate(COLLECT_FIELDS)) as FieldDescriptor[];
    if (!looksLikeApplicationForm(fields)) {
      const shot = await capture(page, options.artifactsDir, packet.applicationId, "no-form");
      return {
        status: "aborted",
        reason:
          "no application form found at the final URL; the posting has most likely been removed and the board redirected to its job index",
        filledFields: [],
        unmatchedRequired: [],
        unusedAnswers: [],
        screenshotPath: shot,
        finalUrl: page.url(),
        confirmationText: "",
        captchaDetected: false,
      };
    }
    const packetAnswers = augmentAnswersForBrowser(packet.answers, options.candidateCountry);
    const plan = buildFillPlan(fields, [
      ...packetAnswers,
      ...fallbackAnswersForFields(
        fields,
        packetAnswers,
        options.answerBank ?? [],
        options.personalResolver,
        options.narrativeResolver,
        options.experienceResolver,
      ),
    ]);
    const filled: Array<{ label: string; source: string }> = [];
    const failedRequired: string[] = [];
    const choiceLog: ChoiceSelection[] = [];

    for (const match of orderFieldsForBrowser(plan.toFill)) {
      const locator = page.locator(`[data-autoapply-idx="${match.field.selectorIndex}"]`).first();
      const value = answerValueForField(match.field, match.answer!);
      const candidates = optionSearchCandidates(match.field, match.answer!);
      try {
        await fillControl(page, locator, match.field, value, candidates, choiceLog);
        filled.push({ label: match.field.label, source: match.answer!.source });
      } catch (error) {
        logger.warn("field fill failed", { label: match.field.label, error: String(error) });
        if (match.field.required) failedRequired.push(match.field.label);
      }
    }

    const lostChoices = await reassertChoices(page, choiceLog);
    for (const label of lostChoices) {
      logger.warn("choice would not hold", { label });
      const index = filled.findIndex((entry) => entry.label === label);
      if (index >= 0) filled.splice(index, 1);
      failedRequired.push(label);
    }

    const screenshotPath = await capture(page, options.artifactsDir, packet.applicationId, "prepared");
    const inertIndexes = await inertControlIndexes(
      page,
      plan.unmatchedRequired.map((entry) => entry.selectorIndex),
    );
    const unmatchedRequired = [
      ...plan.unmatchedRequired
        // Some required controls switch themselves off in response to another
        // answer: ticking "Current role" disables the end-date selects. A
        // disabled control submits nothing, so it cannot be what is missing,
        // and filling it would contradict the answer that disabled it.
        .filter((entry) => !inertIndexes.has(entry.selectorIndex))
        .map((field) => field.label),
      ...failedRequired,
    ].filter((label, index, labels) => labels.indexOf(label) === index);

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
        unmatchedRequired,
        leftForHuman: plan.unfilled.map((entry) => entry.label),
        unusedAnswers: plan.unusedAnswers.map((answer) => answer.label),
        screenshotPath,
        finalUrl: page.url(),
        confirmationText: "",
        captchaDetected: false,
      };
    }

    if (unmatchedRequired.length > 0) {
      return {
        status: "aborted",
        reason: `required field(s) could not be filled: ${unmatchedRequired.join("; ")}`,
        filledFields: filled,
        unmatchedRequired,
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
    const postSubmitText = await readBodyText(page);
    const captchaDetected = detectCaptcha(postSubmitText) || (await hasVisibleCaptchaChallenge(page));
    if (captchaDetected) {
      const shot = await capture(page, options.artifactsDir, packet.applicationId, "captcha");
      return {
        status: "aborted",
        reason: "anti-bot challenge activated after submit; this application must be completed by a human",
        filledFields: filled,
        unmatchedRequired: [],
        unusedAnswers: plan.unusedAnswers.map((answer) => answer.label),
        screenshotPath: shot,
        finalUrl: page.url(),
        confirmationText: "",
        captchaDetected: true,
      };
    }

    if (!checkUrlAllowed(page.url(), options.policy).allowed) {
      return aborted(`page redirected off the allowlist to ${page.url()}`, page.url());
    }

    const confirmationShot = await capture(page, options.artifactsDir, packet.applicationId, "confirmation");
    if (!detectSubmissionConfirmation(postSubmitText, page.url())) {
      return {
        status: "aborted",
        reason: "submit control clicked but no submission confirmation was detected; verify this application manually",
        filledFields: filled,
        unmatchedRequired: [],
        unusedAnswers: plan.unusedAnswers.map((answer) => answer.label),
        screenshotPath: confirmationShot,
        finalUrl: page.url(),
        confirmationText: "",
        captchaDetected: false,
      };
    }

    const confirmationText = postSubmitText.slice(0, 600);

    return {
      status: "submitted",
      reason: "submission confirmation detected and captured",
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

/**
 * Controls the page has switched off since it was scanned. Forms disable
 * dependent fields once another answer makes them meaningless - ticking
 * "Current role" disables the end-date selects - and the scan runs before any
 * answer is entered, so this can only be read after filling.
 */
async function inertControlIndexes(page: AnyPage, indexes: readonly number[]): Promise<Set<number>> {
  if (indexes.length === 0) return new Set();
  // Written as a plain string because it runs in the page, not in Node, and the
  // server is not built against the DOM library.
  const script = `((wanted) => {
    const out = [];
    for (const index of wanted) {
      const el = document.querySelector('[data-autoapply-idx="' + index + '"]');
      if (!el) continue;
      const style = window.getComputedStyle(el);
      const hidden = style.display === 'none' || style.visibility === 'hidden';
      if (el.disabled || el.readOnly || el.getAttribute('aria-disabled') === 'true' || hidden) out.push(index);
    }
    return out;
  })(${JSON.stringify(indexes)})`;
  try {
    const inert = (await page.evaluate(script)) as number[];
    return new Set(inert);
  } catch {
    // A page that will not answer this question is not evidence that anything
    // is disabled, so report nothing and let the required check stand.
    return new Set();
  }
}

function aborted(reason: string, finalUrl: string): BrowserRunResult {  return {
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

type ChoiceSelection = { button: AnyLocator; label: string; choice: string };

async function fillControl(
  page: AnyPage,
  locator: AnyLocator,
  field: FieldDescriptor,
  value: string,
  candidates: readonly string[] = [value],
  choiceLog?: ChoiceSelection[],
): Promise<void> {
  if (field.role === "combobox") {
    await fillCombobox(page, locator, candidates);
    return;
  }
  if (field.type === "select") {
    await fillNativeSelect(locator, candidates);
    return;
  }
  if (field.type === "checkbox" || field.type === "radio") {
    const affirmative = /^(yes|true|1|on|i agree|agree)$/i.test(value.trim());
    const negative = /^(no|false|0|off)$/i.test(value.trim());
    const ashbyChoice = affirmative ? "Yes" : negative ? "No" : null;
    const button = ashbyChoice
      ? locator.locator(
          `xpath=ancestor::div[contains(@class,"ashby-application-form-field-entry")][1]//button[normalize-space()="${ashbyChoice}"]`,
        )
      : null;
    if (button && (await button.count()) === 1) {
      await clickUntilActive(page, button, field.label, ashbyChoice!);
      choiceLog?.push({ button, label: field.label, choice: ashbyChoice! });
      return;
    }
    if (field.optionLabel) {
      await checkOption(locator);
      return;
    }
    if (affirmative) await locator.check();
    return;
  }
  if (field.type === "file") return;
  await locator.fill(value);
}

/**
 * Ashby's Yes/No controls are buttons over a hidden checkbox that never changes
 * its own checked state, so the only evidence a choice registered is the
 * `_active_` class the board adds. Without checking it a lost click is reported
 * as a filled field and the reviewer finds the question blank.
 */
async function clickUntilActive(
  page: AnyPage,
  button: AnyLocator,
  label: string,
  choice: string,
): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await button.click({ timeout: 4000 });
    await page.waitForTimeout(300);
    if (await isActive(button)) return;
  }
  throw new Error(`"${choice}" did not register for "${label}"`);
}

async function isActive(button: AnyLocator): Promise<boolean> {
  const className = (await button.getAttribute("class")) ?? "";
  return className.includes("_active_");
}

/**
 * Ashby re-renders the form while it parses the uploaded resume, which can drop
 * a choice that was verified as active moments earlier. Re-assert every choice
 * once the rest of the form has settled, and report the ones that will not hold.
 */
async function reassertChoices(
  page: AnyPage,
  choices: ChoiceSelection[],
): Promise<string[]> {
  if (choices.length === 0) return [];
  const lost: string[] = [];
  for (let pass = 0; pass < 2; pass += 1) {
    await page.waitForTimeout(1500);
    lost.length = 0;
    for (const entry of choices) {
      if (await isActive(entry.button)) continue;
      try {
        await clickUntilActive(page, entry.button, entry.label, entry.choice);
      } catch {
        lost.push(entry.label);
      }
    }
  }
  return lost;
}

const OPTION_WAIT_MS = 6000;

/**
 * The group was already reduced to the one option that states the approved
 * answer, so this option is simply selected. Boards style radios by hiding the
 * real input behind its own label, which defeats a plain check(), so fall back
 * to forcing it and then to clicking the surrounding option row.
 */
async function checkOption(locator: AnyLocator): Promise<void> {
  try {
    await locator.check({ timeout: 4000 });
    return;
  } catch {
    // Falls through to the styled-control strategies below.
  }
  try {
    await locator.check({ timeout: 4000, force: true });
    return;
  } catch {
    // Falls through to clicking the visible option row.
  }
  await locator.locator("xpath=ancestor::*[self::label or self::div][1]").first().click({ timeout: 4000 });
}

/**
 * React-select comboboxes render their listbox asynchronously, and location
 * pickers query a remote geocoder, so options can take seconds to appear.
 * Candidates are tried in order because boards word the same choice
 * differently; the trailing empty filter lists everything as a last resort.
 *
 * The flyout is always dismissed on the way out — an open listbox overlays the
 * fields below it and makes every later click time out.
 */
export async function fillCombobox(
  page: AnyPage,
  locator: AnyLocator,
  candidates: readonly string[],
): Promise<void> {
  try {
    for (const candidate of [...candidates, ""]) {
      await closeFlyout(page);
      await openFlyout(locator);
      await locator.fill(candidate);
      const optionTexts = await waitForVisibleOptions(page, OPTION_WAIT_MS);
      const index = pickOptionIndex(optionTexts, candidates);
      if (index >= 0) {
        await page.locator('[role="option"]:visible').nth(index).click();
        return;
      }
    }
    throw new Error(`no visible option matched ${JSON.stringify(candidates)}`);
  } finally {
    await closeFlyout(page);
  }
}

async function closeFlyout(page: AnyPage): Promise<void> {
  await page.keyboard.press("Escape").catch(() => undefined);
}

async function openFlyout(locator: AnyLocator): Promise<void> {
  const toggle = locator.locator(
    'xpath=ancestor::div[contains(@class,"select__control")][1]//button[@aria-label="Toggle flyout"]',
  );
  if ((await toggle.count()) > 0) {
    await toggle.click();
    return;
  }
  await locator.click();
}

async function waitForVisibleOptions(page: AnyPage, timeoutMs: number): Promise<string[]> {
  const options = page.locator('[role="option"]:visible');
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if ((await options.count()) > 0) return await options.allInnerTexts();
    if (Date.now() >= deadline) return [];
    await page.waitForTimeout(250);
  }
}

async function fillNativeSelect(locator: AnyLocator, candidates: readonly string[]): Promise<void> {
  const optionTexts = await locator.locator("option").allInnerTexts();
  const index = pickOptionIndex(optionTexts, candidates);
  if (index < 0) {
    throw new Error(`no option matched ${JSON.stringify(candidates)}`);
  }
  await locator.selectOption({ label: optionTexts[index]!.trim() });
}

async function attachResume(page: AnyPage, resumePath: string): Promise<void> {
  const check = validateResumeFile(resumePath);
  if (!check.ok) {
    throw new AppError("resume_unusable", check.reason, { path: resumePath });
  }
  const fileInput = page.locator('input[type="file"]').first();
  if ((await fileInput.count()) === 0) {
    logger.warn("no file input found on the application form", { url: page.url() });
    return;
  }
  // A failed upload must abort: submitting without the resume is worse than
  // failing loudly and handing the application back to a person.
  try {
    await fileInput.setInputFiles(resumePath);
  } catch (error) {
    throw new AppError("resume_upload_failed", `could not attach resume: ${String(error)}`, { path: resumePath });
  }
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

async function readBodyText(page: AnyPage): Promise<string> {
  return page.locator("body").first().innerText().catch(() => "");
}

async function hasVisibleCaptchaChallenge(page: AnyPage): Promise<boolean> {
  for (const selector of ACTIVE_CAPTCHA_SELECTORS) {
    const locator = page.locator(selector).first();
    if ((await locator.count()) > 0 && (await locator.isVisible().catch(() => false))) return true;
  }
  return false;
}

async function capture(page: AnyPage, dir: string, applicationId: string, stage: string): Promise<string> {
  const path = join(dir, `${applicationId}-${stage}-${Date.now()}.png`);
  await page.screenshot({ path, fullPage: true }).catch(() => undefined);
  return path;
}
