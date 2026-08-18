import { mkdirSync } from "node:fs";
import { readFile, rm, writeFile } from "node:fs/promises";
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
  detectSubmissionRejection,
  fallbackAnswersForFields,
  isAffirmativeAnswer,
  looksLikeApplicationForm,
  normalizeLabel,
  optionSearchCandidates,
  orderFieldsForBrowser,
  pickOptionIndex,
  type ApprovedAnswerEntry,
  type FieldDescriptor,
  type FillPlan,
  type PersonalResolver,
  type NarrativeResolver,
} from "./formFields.js";
import { validateResumeFile } from "./resume.js";
import { redactSecrets } from "./credentials.js";
import {
  advanceWorkdayStep,
  recoverWorkdayError,
  enterWorkdayApplication,
  fillWorkdayPrompt,
  isWorkdayPrompt,
  isWorkdayUrl,
  workdayStepName,
} from "./workdayFlow.js";

/**
 * Ceiling on wizard pages walked, so a tenant that keeps offering a next button
 * cannot loop forever. Workday's own flow is six pages; this leaves headroom
 * for tenants that add their own without letting a broken page spin.
 */
const WORKDAY_MAX_STEPS = 12;
/** How many times a step may be reloaded after Workday's transient fault. */
const WORKDAY_MAX_RETRIES = 3;
import {
  fetchVerificationCode,
  readVerificationInboxConfig,
  type VerificationInboxConfig,
} from "./verificationInbox.js";
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
  isEnabled?: () => Promise<boolean>;
  inputValue?: () => Promise<string>;
  press?: (key: string, options?: unknown) => Promise<void>;
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
  /** Email for boards that require an account, defaulting to the profile's own. */
  accountEmail?: string;
  /**
   * Permits registering a new account on an employer's tenant. Off by default:
   * creating a credentialed account in the candidate's name is a larger step
   * than filling a public form and should be a deliberate choice.
   */
  allowAccountCreation?: boolean;
  /**
   * Milliseconds to leave a filled form open for a person to review and submit
   * themselves. Only used when `submit` is false.
   */
  keepOpenMs?: number;
  /**
   * The one-time code a board emails before it will accept a submission.
   * Greenhouse increasingly gates submission this way. Supplying it lets a
   * single automated run finish what would otherwise need a person to sit in
   * front of a browser.
   */
  verificationCode?: string;
  /**
   * How long to hold the browser open at a verification gate while waiting for
   * the code to appear at `codeFilePath`.
   *
   * A code cannot be carried between runs: clicking submit is what causes one
   * to be emailed, so a second run invalidates whatever the first produced.
   * Waiting inside the run is the only way an automated submission can clear
   * the gate.
   */
  codeWaitMs?: number;
  /** File polled for the code while `codeWaitMs` has not elapsed. */
  codeFilePath?: string;
  /**
   * Mailbox polled alongside `codeFilePath`. Defaults to whatever the
   * environment configures, and is absent unless deliberately switched on.
   */
  verificationInbox?: VerificationInboxConfig | null;
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
  // Workday renders a dropdown as a button, not an input, so a query for form
  // controls alone cannot see it. Those buttons are required fields, and the
  // page will not save without them, so they are collected too. The attribute
  // is specific enough that no other board's controls are pulled in.
  const controls = Array.from(
    document.querySelectorAll(
      'input, textarea, select, button[aria-haspopup="listbox"], [data-automation-id="dateInputWrapper"]',
    ),
  );
  // Some boards plant a decoy input to catch bots that fill every field. Workday
  // ships one on its account pages: 1px tall, name="website", labelled "This
  // input is for robots only, do not enter if you're human." It is display:block
  // and visibility:visible, so it passes an ordinary visibility test, and its
  // name would happily match a stored portfolio or personal-site answer.
  const honeypot = (el) => {
    if (el.getAttribute('data-automation-id') === 'beecatcher') return true;
    const described = el.id ? document.querySelector('label[for="' + CSS.escape(el.id) + '"]') : null;
    const text = ((described && described.innerText) || el.getAttribute('aria-label') || '').toLowerCase();
    if (text.includes('for robots only') || text.includes("do not enter if you're human")) return true;
    // Size is only a safe signal for free-text controls. File inputs and the
    // native select behind a custom dropdown are legitimately zero-sized, and
    // rejecting those would break resume upload and working dropdown fills.
    const textLike = el.tagName.toLowerCase() === 'textarea' || ['text', 'email', 'tel', 'url', 'search'].includes(el.type);
    if (!textLike) return false;
    const rect = el.getBoundingClientRect();
    return rect.width < 2 || rect.height < 2;
  };
  // Ashby ships two field-container conventions. Older forms mark the wrapper
  // with a stable class; newer ones use a <fieldset> whose only stable hook is a
  // hashed "_fieldEntry_" class. Matching just the old one silently cost every
  // newer question its label and its required flag, so the run reported nothing
  // missing and then failed validation at submit.
  const ashbyEntry = (el) =>
    el.closest('.ashby-application-form-field-entry') || el.closest('fieldset[class*="_fieldEntry_"]');
  const ashbyTitle = (el) => {
    const entry = ashbyEntry(el);
    return entry ? entry.querySelector('.ashby-application-form-question-title') : null;
  };
  const visible = (el) => {
    const style = window.getComputedStyle(el);
    const ashbyBoolean = el.type === 'checkbox' && ashbyEntry(el);
    if (honeypot(el)) return false;
    return ashbyBoolean || (style.display !== 'none' && style.visibility !== 'hidden' && el.type !== 'hidden');
  };
  const labelFor = (el) => {
    if (el.id) {
      const explicit = document.querySelector('label[for="' + CSS.escape(el.id) + '"]');
      if (explicit && explicit.innerText.trim()) return explicit.innerText.trim();
    }
    const wrapper = el.closest('label');
    const ashbyLabel = ashbyTitle(el);
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
    const entryTitle = ashbyTitle(el);
    if (entryTitle && entryTitle.innerText.trim()) return entryTitle.innerText.trim();
    const radiogroup = el.closest('[role="radiogroup"]');
    const aria = radiogroup && radiogroup.getAttribute('aria-label');
    return aria ? aria.trim() : '';
  };
  // A required multi-select question is satisfied by ticking any one of its
  // boxes, so the options have to be reported as one group. Without this each
  // unticked box counts as its own unmet requirement and a fully answered
  // question still reads as blocking.
  //
  // The container holding the options is ATS-specific, so it is found
  // structurally: the nearest ancestor that holds more than one checkbox and is
  // not the whole form. Keying this off an Ashby-only wrapper meant Greenhouse
  // "select all that apply" groups were never grouped at all - each option
  // arrived as its own required field labelled with the option text, so the
  // question label never matched a drafted answer and the group stayed empty.
  const checkboxGroup = (el) => {
    if (el.type !== 'checkbox') return undefined;
    const entry = ashbyEntry(el);
    if (entry && entry.querySelectorAll('input[type="checkbox"]').length >= 2) return entry;
    // Workday names the group outright. Its options are rendered in a virtual
    // list beside hidden companion inputs, so the structural walk below bails
    // out and every option arrives as its own required field labelled with the
    // option text - which is how the disability form stayed blank.
    const workdayGroup = el.closest('[data-automation-id$="-CheckboxGroup"]');
    if (workdayGroup && workdayGroup.querySelectorAll('input[type="checkbox"]').length >= 2) {
      return workdayGroup;
    }
    let node = el.parentElement;
    while (node && node !== document.body) {
      const boxes = node.querySelectorAll('input[type="checkbox"]').length;
      // Stop before a container that has swallowed unrelated questions.
      if (boxes >= 2) {
        if (node.querySelectorAll('input:not([type="checkbox"]), select, textarea').length > 0) return undefined;
        return node;
      }
      node = node.parentElement;
    }
    return undefined;
  };
  // The question sits above the options, so it is the container text with every
  // option's own text removed.
  const checkboxGroupLabel = (el, container) => {
    const explicit = groupLabel(el);
    if (explicit) return explicit;
    const options = Array.from(container.querySelectorAll('input[type="checkbox"]')).map((box) =>
      optionLabelFor(box),
    );
    const NL = String.fromCharCode(10);
    let text = (container.innerText || '').trim();
    for (const option of options) {
      if (option) text = text.split(option).join(NL);
    }
    const lines = text
      .split(NL)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    // Workday renders the options inside a bare fieldset and keeps the question
    // outside it, so the container carries no text of its own. Without this the
    // group has no label, every option becomes a standalone required field
    // labelled with its own text, and nothing can answer it.
    return lines[0] || workdayLabel(el) || workdayName(el);
  };
  const out = [];
  // A Workday dropdown button carries no usable label of its own - its text is
  // the placeholder - so the label and the required marker come from the field
  // wrapper that encloses it.
  const workdayField = (el) => el.closest('[data-automation-id^="formField-"]');
  // The wrapper labels its control two different ways. My Information uses a
  // <label for>; the questionnaire steps use <fieldset><legend>, where the
  // question is rich text. Reading only <label> left every questionnaire field
  // nameless, so nothing matched it and nothing reported it as required.
  const workdayLabel = (el) => {
    const wrapper = workdayField(el);
    if (!wrapper) return '';
    const holder = wrapper.querySelector('label, legend');
    return holder ? holder.innerText.replace(/\\*/g, '').replace(/\\s+/g, ' ').trim() : '';
  };
  const workdayRequired = (el) => {
    const wrapper = workdayField(el);
    if (!wrapper) return false;
    if (wrapper.querySelector('label abbr, legend abbr')) return true;
    // NVIDIA marks the questionnaire dropdowns only on the control itself.
    return /\\brequired\\b/i.test(el.getAttribute('aria-label') || '');
  };
  // Workday names every field in its automation id, and that name is often the
  // only usable description of what a control asks. The disability checkboxes
  // are legended "Please check one of the boxes below:", which describes no
  // subject at all, while the wrapper is plainly "formField-disabilityStatus".
  const workdayName = (el) => {
    const wrapper = workdayField(el);
    if (!wrapper) return '';
    return (wrapper.getAttribute('data-automation-id') || '')
      .replace(/^formField-/, '')
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/[-_]+/g, ' ')
      .trim();
  };
  controls.filter(visible).forEach((el) => {
    const isListbox = el.tagName.toLowerCase() === 'button';
    const isDateGroup = el.getAttribute('data-automation-id') === 'dateInputWrapper';
    const isRadio = el.type === 'radio';
    const container = isListbox || isDateGroup ? null : checkboxGroup(el);
    const optionLabel = (isListbox || isDateGroup
      ? workdayLabel(el) || labelFor(el)
      : isRadio || container
        ? optionLabelFor(el)
        : labelFor(el)
    ).slice(0, 200);
    const group = isRadio
      ? groupLabel(el).slice(0, 200)
      : container
        ? checkboxGroupLabel(el, container).slice(0, 200)
        : '';
    const label = group || optionLabel;
    const name = el.getAttribute('name') || '';
    const role = el.getAttribute('role') || '';
    const ashbyLabel = ashbyTitle(el);
    const questionTitle = (ashbyLabel ? ashbyLabel.innerText.trim() : workdayName(el)).slice(0, 200);
    if (!label && !name && !el.id && role !== 'combobox') return;
    const index = out.length;
    el.setAttribute('data-autoapply-idx', String(index));
    out.push({
      selectorIndex: index,
      label,
      optionLabel: group ? optionLabel : undefined,
      questionLabel: questionTitle && questionTitle !== label ? questionTitle : undefined,
      groupKey: container ? (group || undefined) : undefined,
      type: (isDateGroup
        ? 'date'
        : isListbox
          ? 'select'
          : el.tagName.toLowerCase() === 'select'
            ? 'select'
            : el.type || 'text'
      ).toLowerCase(),
      name,
      domId: el.id || undefined,
      required:
        el.hasAttribute('required') ||
        el.getAttribute('aria-required') === 'true' ||
        Boolean((isListbox || isDateGroup) && workdayRequired(el)) ||
        Boolean(ashbyLabel && String(ashbyLabel.className).includes('_required_')),
      role,
      value: (isListbox || isDateGroup
        ? el.innerText || ''
        : el.type === 'checkbox' || el.type === 'radio'
          ? el.checked
            ? 'checked'
            : ''
          : el.value || ''
      )
        .replace(/\\s+/g, ' ')
        .trim()
        .slice(0, 120),
    });
  });
  return out;
})()`;

const VERIFICATION_SUBMIT_SELECTORS = [
  'form:has(input[maxlength="1"]) button[type="submit"]',
  'form:has(input[maxlength="1"]) button:has-text("Submit")',
  'form:has(input[maxlength="1"]) button:has-text("Confirm")',
  'form:has(input[maxlength="1"]) button:has-text("Verify")',
];

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
/**
 * Fills every field currently on screen and reports what happened.
 *
 * Split out of the single-page run so the Workday wizard can reuse it: that
 * flow spreads one application across six pages, each of which must be filled
 * and saved before the next exists, and every page needs exactly this handling.
 *
 * Reports `hasForm: false` rather than throwing when the page holds no form, so
 * the single-page path can abort with its own diagnosis while the wizard treats
 * it as the end of the walk.
 */
async function fillFormPage(
  page: AnyPage,
  packet: SubmissionPacket,
  options: BrowserRunOptions,
  /**
   * Inside a wizard the page is already known to belong to the application, so
   * the "does this look like a form?" heuristic must not run. It asks for a
   * name, an email or a file upload, and a later step of a Workday application
   * has none of those: NVIDIA's "Application Questions" step is two work
   * authorization dropdowns and nothing else, which the heuristic read as a
   * non-form and skipped, leaving both required questions blank forever.
   */
  knownApplicationPage = false,
): Promise<{
  hasForm: boolean;
  plan: FillPlan;
  filled: Array<{ label: string; source: string }>;
  failedRequired: string[];
  choiceLog: ChoiceSelection[];
  answeredGroups: Set<string>;
}> {
  const fields = (await page.evaluate(COLLECT_FIELDS)) as FieldDescriptor[];
  const empty = {
    plan: { toFill: [], unfilled: [], unmatchedRequired: [], unusedAnswers: [] } as unknown as FillPlan,
    filled: [] as Array<{ label: string; source: string }>,
    failedRequired: [] as string[],
    choiceLog: [] as ChoiceSelection[],
    answeredGroups: new Set<string>(),
  };
  if (!knownApplicationPage && !looksLikeApplicationForm(fields)) return { hasForm: false, ...empty };
  // A wizard step with no controls at all really is the end of the walk.
  if (knownApplicationPage && fields.length === 0) return { hasForm: false, ...empty };

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
  const answeredGroups = new Set<string>();

  for (const match of orderFieldsForBrowser(plan.toFill)) {
    const locator = page.locator(`[data-autoapply-idx="${match.field.selectorIndex}"]`).first();
    const value = answerValueForField(match.field, match.answer!);
    const candidates = optionSearchCandidates(match.field, match.answer!);
    try {
      await fillControl(page, locator, match.field, value, candidates, choiceLog);
      filled.push({ label: match.field.label, source: match.answer!.source });
      if (match.field.groupKey) answeredGroups.add(match.field.groupKey);
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

  return { hasForm: true, plan, filled, failedRequired, choiceLog, answeredGroups };
}

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

    // Workday hides the form behind an advert, a modal and a sign-in wall, so it
    // needs a walk-in step before there is anything to fill.
    const priorFilled: Array<{ label: string; source: string }> = [];
    const priorFailedRequired: string[] = [];
    let workdayRetries = 0;
    let resumeAttached = false;
    if (isWorkdayUrl(page.url())) {
      const entry = await enterWorkdayApplication(page, options.accountEmail ?? "", {
        allowAccountCreation: options.allowAccountCreation ?? false,
      });
      if (entry.reached !== "form") {
        const shot = await capture(page, options.artifactsDir, packet.applicationId, "workday-entry");
        return {
          ...aborted(redactSecrets(entry.detail), page.url()),
          screenshotPath: shot,
        };
      }
      logger.info("workday application entered", { detail: entry.detail, createdAccount: entry.createdAccount });
      await page.waitForTimeout(1500);

      // Workday spreads one application over roughly six pages - My Information,
      // My Experience, Application Questions, Voluntary Disclosures, Self
      // Identify, Review - and each has to be saved before the next exists. Walk
      // to the last page here so the code below sees a form it can finish, the
      // same way it does on a single-page board.
      let stalledOn = "";
      let stalls = 0;
      for (let step = 0; step < WORKDAY_MAX_STEPS; step += 1) {
        await recoverWorkdayError(page as never);
        const name = await workdayStepName(page);
        // A step that refuses to advance - Adobe's Education block rejects the
        // form until every one of its prompts is answered - otherwise burns the
        // whole step budget re-filling the same page and then reports whatever
        // the last iteration happened to see. Three attempts is enough to tell a
        // slow save from a blocked one.
        if (name && name === stalledOn) {
          stalls += 1;
          if (stalls >= 3) {
            logger.warn("workday step will not advance", { step: name });
            // Reported, not just logged: a wizard that never reached Review has
            // not filled the application, and without this the run ends
            // "unmatched required: []" and looks ready to submit.
            priorFailedRequired.push(`${name.replace(/\s+/g, " ").trim()} would not advance`);
            break;
          }
        } else {
          stalledOn = name;
          stalls = 0;
        }
        // The resume upload lives on My Experience rather than the first page,
        // so it is offered on every step and lands on whichever one accepts it.
        // The upload is asynchronous and does sometimes drop, so it is retried
        // until the board shows the file name back.
        for (let attempt = 0; attempt < 3; attempt += 1) {
          if (resumeAttached) break;
          // Checked before attaching: Workday keeps the file on the saved
          // profile, so uploading again adds a second identical copy rather
          // than replacing the first.
          if (await resumeIsAttached(page, packet.resumePath)) {
            resumeAttached = true;
            break;
          }
          await attachResume(page, packet.resumePath);
          await page.waitForTimeout(1200);
          if (await resumeIsAttached(page, packet.resumePath)) {
            resumeAttached = true;
            break;
          }
        }
        if (resumeAttached) await dedupeResumeAttachments(page);
        const stepFill = await fillFormPage(page, packet, options, true);
        await clearPhoneExtension(page);
        // The transient fault can also arrive part-way through a step, after
        // the recovery above has already run. The step then collects nothing
        // and the run ends up reporting a live posting as removed, so the same
        // step is reloaded and retried before that conclusion is drawn.
        const collected = stepFill.plan.toFill.length + stepFill.plan.unfilled.length;
        if (collected === 0 && workdayRetries < WORKDAY_MAX_RETRIES) {
          workdayRetries += 1;
          logger.warn("workday step collected nothing, retrying", { step: name || `step ${step + 1}` });
          await recoverWorkdayError(page as never);
          step -= 1;
          continue;
        }
        priorFilled.push(...stepFill.filled);
        priorFailedRequired.push(...stepFill.failedRequired);
        // A required question left unmatched on an earlier wizard page is just
        // as blocking as one on the last page, but only the last page's plan
        // reaches the report. Without this the run ends "unmatched required: []"
        // while a saved step still refuses to advance - the exact silent success
        // this whole path was built to stop.
        const stepUnmatched = stepFill.plan.unmatchedRequired
          .filter((entry) => !(entry.groupKey && stepFill.answeredGroups.has(entry.groupKey)))
          .map((entry) => entry.label);
        priorFailedRequired.push(...stepUnmatched);
        logger.info("workday step filled", {
          step: name || `step ${step + 1}`,
          filled: stepFill.filled.length,
          collected: stepFill.plan.toFill.length + stepFill.plan.unfilled.length,
          failedRequired: stepFill.failedRequired.length,
          unmatchedRequired: stepUnmatched,
        });
        // The last step is Review, and its footer button is Submit, not Save
        // and Continue. Advancing past it sends the application - which a
        // fill-only run must never do, and a submitting run must only do
        // through the guarded submit path below. So the walk stops here.
        if (/review/i.test(name)) break;
        if (!(await advanceWorkdayStep(page))) break;
        await page.waitForTimeout(1500);
      }
      // Workday does not mark Resume/CV required, so a dropped upload reaches
      // Review as "No Response" without a word of complaint. Reporting it is
      // what stops an application being submitted with no resume at all.
      if (!resumeAttached) {
        priorFailedRequired.push("Resume/CV (upload did not take)");
      }
    }

    // The wizard has already attached and verified the resume; re-offering it on
    // the review page would add a second copy to the saved profile.
    if (!resumeAttached) {
      await attachResume(page, packet.resumePath);
    }
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
    if (/\.ashbyhq\.com$/i.test(new URL(page.url()).hostname)) {
      await page
        .locator("text=Autofill completed!")
        .first()
        .waitFor({ state: "visible", timeout: 15_000 })
        .catch(() => undefined);
    }
    await page.waitForTimeout(1000);

    const pageFill = await fillFormPage(page, packet, options);
    // A page with no inputs is normally a dead posting. After a wizard has
    // already filled and saved earlier pages it is instead the Review page,
    // which has nothing to fill and everything to submit.
    if (!pageFill.hasForm && priorFilled.length === 0) {
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
    const { plan, choiceLog, answeredGroups } = pageFill;
    // Pages saved earlier in a multi-step wizard are part of this application,
    // so what they filled has to survive into the final report.
    const filled = [...priorFilled, ...pageFill.filled];
    const failedRequired = [...priorFailedRequired, ...pageFill.failedRequired];

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
        // One tick answers a whole multi-select question; the boxes left clear
        // are choices declined, not requirements left unmet.
        .filter((entry) => !(entry.groupKey && answeredGroups.has(entry.groupKey)))
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

    // Choices were verified before the screenshot, but every fill after that
    // point re-renders the form, and Ashby drops a selection when it re-renders
    // the control that holds it. Harvey rejected two submissions for a missing
    // work-authorisation answer that the run had verified as set moments
    // earlier. Verify again with nothing left to disturb the form, so what is
    // submitted is what was checked.
    const lostAtSubmit = await reassertChoices(page, choiceLog);
    if (lostAtSubmit.length > 0) {
      for (const label of lostAtSubmit) logger.warn("choice would not hold at submit", { label });
      return {
        status: "aborted",
        reason: `choice(s) would not stay selected, so nothing was submitted: ${lostAtSubmit.join("; ")}`,
        filledFields: filled.filter((entry) => !lostAtSubmit.includes(entry.label)),
        unmatchedRequired: lostAtSubmit,
        unusedAnswers: plan.unusedAnswers.map((answer) => answer.label),
        screenshotPath,
        finalUrl: page.url(),
        confirmationText: "",
        captchaDetected: false,
      };
    }

    // A submit that leaves us on the page is ambiguous: the request may have
    // been rejected by the board, or never sent at all. Recording what the
    // network actually did is the difference between a diagnosable failure and
    // a shrug, and it is the only way to see a server-side refusal that the
    // page never renders.
    const failedCalls: string[] = [];
    const onResponse = (response: { status: () => number; url: () => string }) => {
      const status = response.status();
      if (status < 400) return;
      const url = response.url();
      if (!/appl|submit|graphql|candidate/i.test(url)) return;
      failedCalls.push(`${status} ${url.split("?")[0]}`);
    };
    page.on?.("response", onResponse as (payload: never) => void);

    const submitState = await describeSubmitControl(page);
    // The board emails its code the moment this click lands, so this is the
    // only honest measure of that code's age. Reading the clock later - after
    // the page settles, the outcome is polled and a screenshot is taken - dates
    // the code minutes into the future and rejects the very email being waited
    // for.
    const submitClickedAt = new Date();
    const clicked = await clickSubmit(page);
    if (!clicked) {
      page.off?.("response", onResponse as (payload: never) => void);
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
    const postSubmitText = await waitForSubmissionOutcome(page);
    page.off?.("response", onResponse as (payload: never) => void);
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
      const verification = detectVerificationCodeGate(postSubmitText);
      const code = verification
        ? options.verificationCode ?? (await awaitVerificationCode(options, page, submitClickedAt))
        : undefined;
      if (verification && code) {
        const entered = await enterVerificationCode(page, code);
        if (entered) {
          await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => undefined);
          const codeText = await waitForSubmissionOutcome(page, {
            gateIsOutcome: false,
            timeoutMs: VERIFIED_SUBMIT_TIMEOUT_MS,
          });
          const codeShot = await capture(page, options.artifactsDir, packet.applicationId, "confirmation");
          if (detectSubmissionConfirmation(codeText, page.url())) {
            return {
              status: "submitted",
              reason: "verification code accepted; submission confirmation detected and captured",
              filledFields: filled,
              unmatchedRequired: [],
              unusedAnswers: plan.unusedAnswers.map((answer) => answer.label),
              screenshotPath: codeShot,
              finalUrl: page.url(),
              confirmationText: codeText.slice(0, 600),
              captchaDetected: false,
            };
          }
          // A code that is wrong, already used or expired is worth saying
          // plainly: the remedy is a fresh code, not another attempt at this
          // one, and each attempt emails a new code. A gate that reports no
          // error at all usually means the code was never sent rather than
          // refused, so the controls it offers are recorded to tell the two
          // apart without burning another code on a guess.
          const codeErrors = await readValidationErrors(page);
          const stillGated = detectVerificationCodeGate(codeText);
          const gate = codeErrors.length ? "" : await describeVerificationGate(page);
          return {
            status: "aborted",
            reason: `verification code was entered but the submission was not confirmed${
              codeErrors.length ? `; page reported: ${codeErrors.join(" | ")}` : ""
            }${stillGated ? " The gate is still on screen after the wait, so the code was most likely refused and a new one has been emailed." : ""}${
              ` Code entry: ${entered}.`
            }${gate ? ` Gate controls: ${gate}` : ""}`,
            filledFields: filled,
            unmatchedRequired: [],
            unusedAnswers: plan.unusedAnswers.map((answer) => answer.label),
            screenshotPath: codeShot,
            finalUrl: page.url(),
            confirmationText: "",
            captchaDetected: false,
          };
        }
      }
      if (verification) {
        return {
          status: "aborted",
          reason: `${verification} Every field is filled. A code cannot be carried over from an earlier run, because clicking submit is what causes one to be sent; re-run with waitForCodeSeconds so the browser holds this session open, or in assisted mode and enter it by hand.`,
          filledFields: filled,
          unmatchedRequired: [],
          unusedAnswers: plan.unusedAnswers.map((answer) => answer.label),
          screenshotPath: confirmationShot,
          finalUrl: page.url(),
          confirmationText: "",
          captchaDetected: false,
        };
      }
      const pageErrors = await readValidationErrors(page);
      const detail = pageErrors.length ? ` page reported: ${pageErrors.join(" | ")}` : "";
      const network = failedCalls.length ? ` submit request failed: ${failedCalls.join("; ")}` : "";
      const control = submitState ? ` ${submitState}` : "";
      const finalText = await readBodyText(page);
      if (detectSubmissionRejection(finalText) || detectSubmissionRejection(postSubmitText)) {
        return {
          status: "aborted",
          reason: `the employer refused the submission, so nothing was sent - do not treat this as possibly submitted. Submit this one by hand.${detail}${network}`,
          filledFields: filled,
          unmatchedRequired: [],
          unusedAnswers: plan.unusedAnswers.map((answer) => answer.label),
          screenshotPath: confirmationShot,
          finalUrl: page.url(),
          confirmationText: "",
          captchaDetected: false,
        };
      }
      // The board has told us which fields it thinks are empty. Repair exactly
      // those and click once more: validation failed, so nothing was sent, and
      // a second click cannot produce a second application. Only one repair is
      // attempted - if the board still refuses, the problem is not a lost value.
      const repairedFields = await repairReportedFields(page, plan.toFill, pageErrors);
      if (repairedFields.length > 0) {
        logger.info("repairing fields the board reported empty", { fields: repairedFields });
        await reassertChoices(page, choiceLog);
        if (await clickSubmit(page)) {
          await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => undefined);
          const retryText = await waitForSubmissionOutcome(page);
          const retryShot = await capture(page, options.artifactsDir, packet.applicationId, "confirmation");
          if (detectSubmissionConfirmation(retryText, page.url())) {
            page.off?.("response", onResponse as (payload: never) => void);
            return {
              status: "submitted",
              reason: `submission confirmed after re-entering ${repairedFields.join("; ")}, which the board had reported empty`,
              filledFields: filled,
              unmatchedRequired: [],
              unusedAnswers: plan.unusedAnswers.map((answer) => answer.label),
              screenshotPath: retryShot,
              finalUrl: page.url(),
              confirmationText: retryText.slice(0, 600),
              captchaDetected: false,
            };
          }
          // A code gate after the repair means the form was accepted and only
          // the code is outstanding. That needs the full gated path, which this
          // repair deliberately does not duplicate, so say so plainly rather
          // than guess at the outcome.
          const retryGate = detectVerificationCodeGate(retryText);
          const retryErrors = await readValidationErrors(page);
          page.off?.("response", onResponse as (payload: never) => void);
          return {
            status: "aborted",
            reason: retryGate
              ? `${retryGate} The form was repaired and accepted, so re-run this application to clear the code gate.`
              : `re-entered ${repairedFields.join("; ")} and clicked submit again, but the board still did not confirm.${
                  retryErrors.length ? ` page reported: ${retryErrors.join(" | ")}` : ""
                }`,
            filledFields: filled,
            unmatchedRequired: retryErrors.length > 0 ? repairedFields : [],
            unusedAnswers: plan.unusedAnswers.map((answer) => answer.label),
            screenshotPath: retryShot,
            finalUrl: page.url(),
            confirmationText: "",
            captchaDetected: false,
          };
        }
      }
      return {
        status: "aborted",
        reason: `submit control clicked but no submission confirmation was detected; verify this application manually.${control}${detail}${network}`,
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
 * How long to keep looking for a confirmation before deciding one never came.
 * Single-page boards re-render in place after the POST returns, so "load state
 * is idle" is not the same as "the outcome is on screen".
 */
const SUBMISSION_OUTCOME_TIMEOUT_MS = 30_000;
// A code-verified submit is slower than an ordinary one: the board revalidates
// the whole application behind the gate, and its button sits disabled with a
// spinner the entire time.
const VERIFIED_SUBMIT_TIMEOUT_MS = 120_000;
const SUBMISSION_OUTCOME_POLL_MS = 1_000;

/**
 * Reads the page repeatedly until it shows a submission outcome.
 *
 * Sampling once shortly after the click reports "no confirmation" for any board
 * that takes a moment to render one, and that verdict is worse than a slow
 * answer: it says an application failed when it was in fact accepted, and the
 * obvious response - submit again - sends the employer a duplicate.
 *
 * Polling stops early on a confirmation, and also on a validation error, since
 * a form that is objecting to its own contents is not going to confirm.
 */
/**
 * The verification gate is an outcome the first time it appears - the board
 * asked for a code, so there is nothing left to wait for. After a code has been
 * sent it is the opposite: the gate stays on screen with its button spinning
 * while the submission is in flight, so treating it as an outcome ends the wait
 * before the board has answered and reports an accepted code as a refused one.
 */
export async function waitForSubmissionOutcome(
  page: AnyPage,
  options: { gateIsOutcome?: boolean; timeoutMs?: number } = {},
): Promise<string> {
  const gateIsOutcome = options.gateIsOutcome ?? true;
  const deadline = Date.now() + (options.timeoutMs ?? SUBMISSION_OUTCOME_TIMEOUT_MS);
  let text = await readBodyText(page);
  while (Date.now() < deadline) {
    if (detectSubmissionConfirmation(text, page.url())) return text;
    if (gateIsOutcome && detectVerificationCodeGate(text)) return text;
    if ((await readValidationErrors(page)).length > 0) return text;
    await page.waitForTimeout(SUBMISSION_OUTCOME_POLL_MS);
    text = await readBodyText(page);
  }
  return text;
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

/**
 * Re-fills the fields a board's own validation says are empty.
 *
 * The board naming a field is far better evidence than anything inferable from
 * the page, and a form that failed validation was not submitted, so repairing
 * and clicking again cannot double-send. Ashby rejected a fully filled Abridge
 * form as missing "Full Name" and a radio group that were both visibly set on
 * screen: the board's own form state had not taken what Playwright wrote. The
 * run gave up with "verify this application manually" on an application that
 * needed one more click.
 *
 * Text is re-entered through the keyboard and blurred rather than set with
 * fill(), because a React form that ignored a programmatic value change will
 * still see real keystrokes and a blur.
 */
export async function repairReportedFields(
  page: AnyPage,
  toFill: FillPlan["toFill"],
  errors: readonly string[],
): Promise<string[]> {
  const reported = errors.map((error) => normalizeLabel(error));
  const repaired: string[] = [];
  for (const match of toFill) {
    if (!match.answer) continue;
    const label = normalizeLabel(match.field.label);
    // A one or two character label cannot be matched against prose without
    // hitting every error message on the page.
    if (label.length < 3) continue;
    if (!reported.some((error) => error.includes(label))) continue;
    const locator = page.locator(`[data-autoapply-idx="${match.field.selectorIndex}"]`).first();
    const value = answerValueForField(match.field, match.answer);
    const candidates = optionSearchCandidates(match.field, match.answer);
    try {
      const typeable =
        match.field.role !== "combobox" &&
        ["text", "email", "tel", "url", "textarea", "number"].includes(match.field.type);
      if (typeable) {
        await locator.click();
        await locator.fill("");
        await page.keyboard.type(value, { delay: 25 });
        await page.keyboard.press("Tab");
      } else {
        await fillControl(page, locator, match.field, value, candidates);
      }
      repaired.push(match.field.label);
    } catch (error) {
      logger.warn("could not repair a field the board reported empty", {
        label: match.field.label,
        error: String(error),
      });
    }
  }
  return repaired;
}

async function fillControl(
  page: AnyPage,
  locator: AnyLocator,
  field: FieldDescriptor,
  value: string,
  candidates: readonly string[] = [value],
  choiceLog?: ChoiceSelection[],
): Promise<void> {
  // Checked before the generic branches: Workday renders dropdowns as a widget
  // beside a hidden text input, and the collector only sees that input, so
  // every one of them would otherwise be filled invisibly and reported filled.
  if (field.type !== "checkbox" && field.type !== "radio" && field.type !== "file" && isWorkdayUrl(page.url())) {
    // A Workday date is three keyboard-driven sections in a div, not an input.
    // Typing all eight digits at one focus point puts them into whichever
    // section happens to hold it - the year ended up "8162" - so each section
    // is filled on its own.
    if (field.type === "date") {
      const digits = value.replace(/\D/g, "");
      if (digits.length < 8) throw new Error(`cannot type "${value}" into a date field`);
      const iso = /^\d{4}\D/.test(value);
      const month = iso ? digits.slice(4, 6) : digits.slice(0, 2);
      const day = iso ? digits.slice(6, 8) : digits.slice(2, 4);
      const year = iso ? digits.slice(0, 4) : digits.slice(4, 8);
      const parts: Array<[string, string]> = [
        ["Month", month],
        ["Day", day],
        ["Year", year],
      ];
      // The section inputs are visually hidden spinbuttons behind their own
      // display divs, so Playwright refuses to click them. Focusing through the
      // DOM is what actually reaches them.
      const groupId = await locator.getAttribute("id");
      for (const [section, part] of parts) {
        const sectionId = groupId ? `${groupId}-dateSection${section}-input` : "";
        const focused = sectionId
          ? await page.evaluate(
              `(() => { const el = document.getElementById(${JSON.stringify(sectionId)}); if (!el) return false; el.focus(); return document.activeElement === el; })()`,
            )
          : false;
        if (!focused) {
          const display = locator.locator(`[data-automation-id="dateSection${section}-display"]`).first();
          if ((await display.count()) === 0) throw new Error(`no ${section} section in the date field`);
          await display.click({ timeout: 10_000 });
        }
        await page.keyboard.type(part, { delay: 80 });
        await page.waitForTimeout(200);
      }
      await page.waitForTimeout(400);
      return;
    }
    const wrapper = locator.locator('xpath=ancestor::div[starts-with(@data-automation-id,"formField-")][1]');
    if ((await wrapper.count()) > 0 && (await isWorkdayPrompt(wrapper as never))) {
      const result = await fillWorkdayPrompt(page as never, wrapper as never, candidates);
      if (!result.filled) throw new Error(result.detail);
      return;
    }
  }
  if (field.role === "combobox") {
    await fillCombobox(page, locator, candidates);
    return;
  }
  if (field.type === "select") {
    await fillNativeSelect(locator, candidates);
    return;
  }
  if (field.type === "checkbox" || field.type === "radio") {
    const affirmative = isAffirmativeAnswer(value);
    const negative = /^(no|false|0|off|decline)\b/i.test(value.trim());
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
/**
 * Ashby renders yes/no questions as a pair of buttons over a hidden checkbox,
 * and those buttons are toggles: clicking the option that is already selected
 * clears the answer. A 300ms wait was not always enough for the class to
 * appear, so a slow render made this click a second time and switch the answer
 * back off, leaving the question unanswered. Never click a control that is
 * already in the wanted state, and wait properly before deciding a click missed.
 */
async function clickUntilActive(
  page: AnyPage,
  button: AnyLocator,
  label: string,
  choice: string,
): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    if (await isActive(button)) return;
    await button.click({ timeout: 4000 });
    if (await waitForActive(page, button)) return;
  }
  throw new Error(`"${choice}" did not register for "${label}"`);
}

async function waitForActive(page: AnyPage, button: AnyLocator): Promise<boolean> {
  for (let waited = 0; waited < 2000; waited += 200) {
    await page.waitForTimeout(200);
    if (await isActive(button)) return true;
  }
  return false;
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
 * The flyout is always dismissed on the way out â€” an open listbox overlays the
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

/**
 * Removes a phone number that an earlier run wrote into the extension field.
 *
 * Workday saves the candidate profile per tenant, so a value written once is
 * offered back on every later application to that employer. The matcher no
 * longer writes it, which does nothing for the ones already stored, and the
 * result is an undialable "+1 (604) 6536919 x604-653-6919" on the review page.
 * A real extension is a handful of digits, so anything phone-length is wrong.
 */
async function clearPhoneExtension(page: AnyPage): Promise<void> {
  try {
    await page.evaluate(`(() => {
      const inputs = Array.prototype.slice.call(document.querySelectorAll('input'));
      for (const input of inputs) {
        const id = input.getAttribute('data-automation-id') || '';
        const name = input.getAttribute('name') || '';
        const aria = input.getAttribute('aria-label') || '';
        if (!/extension/i.test(id + ' ' + name + ' ' + aria)) continue;
        const digits = (input.value || '').replace(/\\D/g, '');
        if (digits.length < 7) continue;
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        setter.call(input, '');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }
    })()`);
  } catch {
    // Best effort: a page without an extension field must not fail the run.
  }
}

/**
 * Removes duplicate resume uploads.
 *
 * Workday stores attachments on the saved candidate profile, so every run that
 * uploaded again left another identical copy behind - three of them by the time
 * this was found. Extra copies are deleted so a submitted application carries
 * exactly one resume.
 */
async function dedupeResumeAttachments(page: AnyPage): Promise<void> {
  const items = page.locator('[data-automation-id="file-upload-item"]');
  for (let guard = 0; guard < 5; guard += 1) {
    const count = await items.count();
    if (count <= 1) return;
    const remove = items.nth(count - 1).locator('button[data-automation-id="delete-file"]');
    if ((await remove.count()) === 0) return;
    await remove.click({ timeout: 5000 }).catch(() => undefined);
    await page.waitForTimeout(1200);
  }
}

async function attachResume(page: AnyPage, resumePath: string): Promise<boolean> {
  const check = validateResumeFile(resumePath);
  if (!check.ok) {
    throw new AppError("resume_unusable", check.reason, { path: resumePath });
  }
  const fileInput = page.locator('input[type="file"]').first();
  if ((await fileInput.count()) === 0) {
    logger.warn("no file input found on the application form", { url: page.url() });
    return false;
  }
  // A failed upload must abort: submitting without the resume is worse than
  // failing loudly and handing the application back to a person.
  try {
    await fileInput.setInputFiles(resumePath);
  } catch (error) {
    throw new AppError("resume_upload_failed", `could not attach resume: ${String(error)}`, { path: resumePath });
  }
  return true;
}

/**
 * Confirms the board is actually holding the file.
 *
 * Workday accepts the upload asynchronously and does not mark Resume/CV
 * required, so a dropped upload reached the review page as "No Response" and
 * the run still reported success - an application submitted with no resume.
 */
async function resumeIsAttached(page: AnyPage, resumePath: string): Promise<boolean> {
  const name = resumePath.split(/[\\/]/).pop() ?? "";
  if (!name) return false;
  return (await page.locator(`text=${name}`).count()) > 0;
}

/**
 * Whether a run can hold the browser at a verification gate.
 *
 * Two independent readers can supply the code: a file a person writes, and a
 * configured mailbox. Either is sufficient on its own. This used to demand the
 * file, so a run with only a mailbox returned instantly and reported that no
 * code had arrived, on a form that was otherwise completely filled.
 */
export function canAwaitVerificationCode(options: {
  codeWaitMs?: number;
  codeFilePath?: string;
  verificationInbox?: VerificationInboxConfig | null;
}): boolean {
  if ((options.codeWaitMs ?? 0) <= 0) return false;
  const inbox = options.verificationInbox ?? readVerificationInboxConfig();
  return Boolean(options.codeFilePath) || Boolean(inbox);
}

/**
 * Holds the session open at a verification gate, polling for the code.
 *
 * The code is bound to the submit that requested it, so it cannot survive into
 * a later run: re-submitting to supply an old code is exactly what invalidates
 * it. Waiting here keeps one browser session alive across the round trip to
 * whoever is reading the inbox, which is the only point at which the code is
 * still good.
 */
async function awaitVerificationCode(
  options: BrowserRunOptions,
  page: AnyPage,
  emailedAt: Date,
): Promise<string | undefined> {
  const waitMs = options.codeWaitMs ?? 0;
  const path = options.codeFilePath;
  const inbox = options.verificationInbox ?? readVerificationInboxConfig();
  if (!canAwaitVerificationCode(options)) return undefined;

  // A code emailed before this moment is already dead, so whoever is reading
  // the inbox needs to know when this attempt's code was sent rather than
  // guessing which of several similar emails is current.
  const signalPath = path ? `${path}.waiting` : undefined;
  if (signalPath) {
    await writeFile(signalPath, emailedAt.toISOString(), "utf8").catch(() => undefined);
  }

  try {
    const deadline = Date.now() + waitMs;
    while (Date.now() < deadline) {
      const code = path
        ? await readFile(path, "utf8")
            .then((text) => text.trim())
            .catch(() => "")
        : "";
      if (code && path) {
        // Consumed, so a stale code from an earlier attempt can never be picked
        // up by the next one.
        await rm(path, { force: true }).catch(() => undefined);
        return code;
      }
      // A configured mailbox is a second reader of the same round trip, not a
      // replacement: a person can still drop the code in the file at any point,
      // and whichever arrives first wins.
      if (inbox) {
        const emailed = await fetchVerificationCode(inbox, emailedAt).catch((error: unknown) => {
          logger.warn("verification inbox unreadable", { detail: String(error) });
          return null;
        });
        if (emailed) return emailed;
      }
      await page.waitForTimeout(2000);
    }
    return undefined;
  } finally {
    if (signalPath) await rm(signalPath, { force: true }).catch(() => undefined);
  }
}

/**
 * Selectors for the box a board shows after emailing a one-time code. Ordered
 * most specific first so a generic text input is only ever a last resort, and
 * that last resort is confined to a box short enough to be a code field.
 */
const VERIFICATION_INPUT_SELECTORS = [
  'input[name*="verification" i]',
  'input[id*="verification" i]',
  'input[name*="confirmation_code" i]',
  'input[autocomplete="one-time-code"]',
  'input[name*="otp" i]',
  'input[id*="otp" i]',
  'input[aria-label*="code" i]',
  'input[placeholder*="code" i]',
  'input[name*="code" i]',
  'input[id*="code" i]',
];

/**
 * Types an emailed one-time code and confirms it. Handles both a single box
 * and the segmented one-character-per-box layout Greenhouse renders, where a
 * fill() into any one box would only ever deliver a single character.
 *
 * Returns false when no code box can be found, so the caller reports the gate
 * rather than claiming an attempt that never happened.
 */
/**
 * Enters the code and sends it, returning a description of the action taken or
 * null when nothing could be entered.
 *
 * The description is not decoration. A gate that is still on screen afterwards
 * means either a refused code or a button that was never pressed, and those have
 * opposite remedies. Every diagnosis costs a fresh code and another round trip
 * to whoever reads the inbox, so the run records what it did rather than leaving
 * the next attempt to guess.
 */
async function enterVerificationCode(page: AnyPage, code: string): Promise<string | null> {
  const trimmed = code.trim();
  if (!trimmed) return null;

  const lastBox = await fillSegmentedCode(page, trimmed);
  if (lastBox) {
    const action = await submitVerificationCode(page, lastBox);
    return action ? `filled ${trimmed.length} segmented boxes, then ${action}` : null;
  }

  for (const selector of VERIFICATION_INPUT_SELECTORS) {
    const locator = page.locator(selector).first();
    if ((await locator.count()) === 0) continue;
    if (!(await locator.isVisible().catch(() => false))) continue;
    await locator.fill(trimmed).catch(() => undefined);
    const value = await locator.inputValue?.().catch(() => "");
    // Only report success once the box actually holds the code. A readonly or
    // shadowed input accepts fill() silently and would otherwise look filled.
    if (value !== undefined && value !== trimmed) continue;
    const action = await submitVerificationCode(page, locator);
    return action ? `filled ${selector}, then ${action}` : null;
  }
  return null;
}

/**
 * The code gate renders its own submit control, while the job post it sits under
 * usually still carries an apply control earlier in the document. Clicking the
 * first submit-looking button on the page therefore lands on the wrong one and
 * the correctly typed code is never sent, which reads exactly like a refused
 * code. The search is scoped to the form owning the code boxes, and falls back
 * to pressing Enter in the code field itself.
 */
const DESCRIBE_GATE = `(() => {
  const boxes = Array.from(document.querySelectorAll('input[maxlength="1"]'));
  if (boxes.length === 0) return 'no code boxes present';
  const first = boxes[0];
  const form = first.closest('form');
  const scope = form || (first.parentElement && first.parentElement.parentElement) || document;
  const controls = Array.from(scope.querySelectorAll('button, input[type=submit]')).slice(0, 6).map((node) => {
    const text = (node.innerText || node.value || node.getAttribute('aria-label') || '').trim().slice(0, 30);
    const type = node.getAttribute('type') || '-';
    return node.tagName.toLowerCase() + '[type=' + type + ']' + (node.disabled ? '[disabled]' : '') + '"' + text + '"';
  });
  const values = boxes.map((el) => el.value || '_').join('');
  return 'form=' + (form ? 'yes' : 'no') + ' boxes="' + values + '" controls=' + (controls.length ? controls.join(', ') : 'none');
})()`;

/**
 * Describes the controls a persistent code gate offers, so a run that failed
 * because nothing was clicked can be told apart from one that failed because
 * the code was genuinely refused. Reading this costs nothing; guessing wrong
 * costs another emailed code and another round trip to the candidate.
 */
async function describeVerificationGate(page: AnyPage): Promise<string> {
  const described = await page.evaluate(DESCRIBE_GATE).catch(() => "");
  return typeof described === "string" ? described : "";
}

/**
 * Clicks the control that belongs to the code gate, identified by proximity to
 * the code boxes rather than by type or wording. Greenhouse puts the boxes
 * inside the whole application form and gives the gate an unlabelled
 * `type=button` arrow, so neither a submit-type search nor a text search can
 * find it, and a form-wide search finds "Remove file" instead.
 *
 * The scope widens one ancestor at a time and stops as soon as a container
 * holds a small, unambiguous set of controls. A container crowded with buttons
 * belongs to the form rather than the gate, so it is refused instead of clicked.
 */
const CLICK_CODE_SUBMIT = `(() => {
  const boxes = Array.from(document.querySelectorAll('input[maxlength="1"]'));
  if (boxes.length === 0) return 'no-boxes';
  const last = boxes[boxes.length - 1];
  let scope = last.parentElement;
  while (scope && boxes.some((box) => !scope.contains(box))) scope = scope.parentElement;
  if (!scope) return 'no-scope';
  for (let depth = 0; depth < 4 && scope; depth += 1) {
    const controls = Array.from(scope.querySelectorAll('button, input[type=submit]')).filter((node) => {
      return !node.disabled && node.getClientRects().length > 0;
    });
    if (controls.length > 2) return 'ambiguous:' + controls.length;
    if (controls.length > 0) {
      const target = controls[controls.length - 1];
      const label = (target.innerText || target.value || target.getAttribute('aria-label') || 'unlabelled').trim().slice(0, 30);
      target.click();
      return 'clicked:' + label;
    }
    scope = scope.parentElement;
  }
  return 'no-control';
})()`;

/**
 * Sends the entered code, returning what it did: the label of the control it
 * clicked, the selector it fell back to, or the key it pressed. Returns "" when
 * nothing could be actioned.
 */
export async function submitVerificationCode(page: AnyPage, codeField: AnyLocator): Promise<string> {
  const nearby = await page.evaluate(CLICK_CODE_SUBMIT).catch(() => "");
  if (typeof nearby === "string" && nearby.startsWith("clicked:")) return `clicked gate control ${nearby.slice(8)}`;
  // Records why the proximity search declined, because "ambiguous:7" and
  // "no-boxes" call for different fixes.
  const declined = typeof nearby === "string" && nearby ? ` (proximity search returned ${nearby})` : "";

  for (const selector of VERIFICATION_SUBMIT_SELECTORS) {
    const locator = page.locator(selector).first();
    if ((await locator.count().catch(() => 0)) === 0) continue;
    if (!(await locator.isVisible().catch(() => false))) continue;
    await locator.click().catch(() => undefined);
    return `clicked ${selector}${declined}`;
  }
  const pressed = await codeField
    .press?.("Enter")
    .then(() => true)
    .catch(() => false);
  if (pressed) return `pressed Enter in the code field${declined}`;
  return (await clickSubmit(page)) ? `clicked the form's submit control${declined}` : "";
}

/**
 * Fills a row of single-character boxes, one character each. Requires exactly
 * as many boxes as the code has characters, so a partial code is never left
 * sitting in a form that would then be submitted incomplete. Returns the last
 * box so the caller can submit from inside the code field.
 */
export async function fillSegmentedCode(page: AnyPage, code: string): Promise<AnyLocator | null> {
  const boxes = page.locator('input[maxlength="1"]');
  const total = await boxes.count().catch(() => 0);
  if (total === 0) return null;

  const visible: AnyLocator[] = [];
  for (let i = 0; i < total; i += 1) {
    const box = boxes.nth(i);
    if (await box.isVisible().catch(() => false)) visible.push(box);
  }
  if (visible.length !== code.length) return null;

  for (let i = 0; i < code.length; i += 1) {
    await visible[i]!.fill(code[i]!).catch(() => undefined);
  }

  // Confirm every box took its character before clicking anything. Some
  // components rewrite or clear input they consider invalid.
  for (let i = 0; i < code.length; i += 1) {
    const value = await visible[i]!.inputValue?.().catch(() => undefined);
    if (value !== undefined && value !== code[i]) return null;
  }
  return visible[code.length - 1] ?? null;
}

async function clickSubmit(page: AnyPage): Promise<boolean> {
  // Workday's review page carries no button[type=submit] at all: the control is
  // the same footer button that says "Save and Continue" on every earlier step
  // and "Submit" on the last one. Without this the generic selectors find
  // nothing and a fully filled application is reported as unsubmittable.
  const footer = page.locator('[data-automation-id="pageFooterNextButton"]').first();
  if ((await footer.count()) > 0 && (await footer.isVisible().catch(() => false))) {
    const label = ((await (footer as { textContent?: () => Promise<string | null> }).textContent?.().catch(() => "")) ?? "").trim();
    if (/submit/i.test(label)) {
      await footer.click();
      return true;
    }
  }
  for (const selector of SUBMIT_SELECTORS) {
    const locator = page.locator(selector).first();
    if ((await locator.count()) > 0 && (await locator.isVisible().catch(() => false))) {
      await locator.click();
      return true;
    }
  }
  return false;
}

/**
 * Ashby greys its submit button by setting `aria-disabled`, which Playwright
 * still considers clickable, so the click lands on a control that ignores it:
 * no navigation, no error, no request. Recording the button's own state turns
 * that silent nothing into a reportable cause.
 */
async function describeSubmitControl(page: AnyPage): Promise<string> {
  for (const selector of SUBMIT_SELECTORS) {
    const locator = page.locator(selector).first();
    if ((await locator.count()) === 0) continue;
    if (!(await locator.isVisible().catch(() => false))) continue;
    const ariaDisabled = await locator.getAttribute("aria-disabled").catch(() => null);
    const enabled = (await locator.isEnabled?.().catch(() => true)) ?? true;
    if (!enabled || ariaDisabled === "true") {
      return `submit control was disabled when clicked (aria-disabled=${ariaDisabled ?? "none"}, enabled=${enabled})`;
    }
    return "";
  }
  return "";
}

async function readBodyText(page: AnyPage): Promise<string> {
  return page.locator("body").first().innerText().catch(() => "");
}

/**
 * When a submit click leaves us on the same page, the board almost always says
 * why somewhere on it. Without this the run reports "no confirmation detected",
 * which is true but useless - it cannot distinguish a rejected field from a
 * silent network failure. Read the page's own complaint instead of guessing.
 */
const READ_VALIDATION_ERRORS = `() => {
  const seen = new Set();
  const out = [];
  const push = (raw) => {
    const text = (raw || "").replace(/\\s+/g, " ").trim();
    if (!text || text.length > 240) return;
    const key = text.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(text);
  };
  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = window.getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none";
  };
  for (const el of Array.from(document.querySelectorAll('[role="alert"], [aria-live="assertive"], [aria-live="polite"]'))) {
    if (visible(el)) push(el.textContent);
  }
  for (const el of Array.from(document.querySelectorAll('[class*="error" i], [class*="invalid" i]'))) {
    if (el.querySelector('[class*="error" i], [class*="invalid" i]')) continue;
    if (visible(el)) push(el.textContent);
  }
  for (const el of Array.from(document.querySelectorAll('[aria-invalid="true"]'))) {
    if (!visible(el)) continue;
    const entry = el.closest('.ashby-application-form-field-entry, fieldset[class*="_fieldEntry_"], .field-entry, label');
    push(entry ? entry.textContent : el.getAttribute("name"));
  }
  return out.slice(0, 8);
}`;

/**
 * Greenhouse increasingly emails a one-time code and refuses the submission
 * until it is typed back in. That is not a failed submission and not an
 * anti-bot challenge in the CAPTCHA sense: the form is complete and correct,
 * and only a human with mailbox access can finish it. Reporting it as "no
 * confirmation detected" hid the one fact that decides what to do next, so it
 * is now named. Returns the employer's own wording where it can be quoted.
 */
export function detectVerificationCodeGate(text: string): string | undefined {
  const flat = text.replace(/\s+/g, " ");
  const patterns = [
    /a verification code was sent to .{1,120}?\.(?=\s|$)/i,
    /enter the \d+[- ]character code to confirm you'?re a human\.?/i,
    /we (?:have )?sent a (?:one[- ]time |verification |security )?code to .{1,120}?\.(?=\s|$)/i,
    /check your email for a (?:verification|security|one[- ]time) code/i,
  ];
  for (const pattern of patterns) {
    const hit = pattern.exec(flat);
    if (hit) return hit[0].trim();
  }
  return undefined;
}

async function readValidationErrors(page: AnyPage): Promise<string[]> {  try {
    const errors = (await page.evaluate(READ_VALIDATION_ERRORS)) as unknown;
    return Array.isArray(errors) ? errors.filter((entry): entry is string => typeof entry === "string") : [];
  } catch {
    return [];
  }
}

async function hasVisibleCaptchaChallenge(page: AnyPage): Promise<boolean> {  for (const selector of ACTIVE_CAPTCHA_SELECTORS) {
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

