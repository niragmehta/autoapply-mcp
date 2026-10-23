import { readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { analyzeLocation } from "../ranking/location.js";
import { logger } from "../util/logger.js";
import type { BrowserRunResult } from "./browser.js";
import { detectSubmissionConfirmation, detectSubmissionRejection, normalizeLabel } from "./formFields.js";
import type { SubmissionPacket } from "./packet.js";

/**
 * Employers' own career sites: Google, Meta, Amazon and Apple.
 *
 * None of them takes an application from an anonymous visitor, and each
 * blocks sign-in from an automated browser. So the candidate signs in once, by
 * hand, in an ordinary Chrome window using a dedicated profile directory, and
 * runs here reuse that profile's session. Nothing in this module signs in,
 * creates an account or answers a challenge: a session that has lapsed ends
 * the run with a request to sign in again.
 */

export type CareerSite = "google" | "meta" | "amazon" | "apple";

export function careerSiteFor(url: string): CareerSite | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  const host = parsed.hostname.toLowerCase();
  if ((host === "www.google.com" || host === "google.com") && parsed.pathname.startsWith("/about/careers/")) return "google";
  if (host === "www.metacareers.com" || host === "metacareers.com") return "meta";
  if (host === "www.amazon.jobs" || host === "amazon.jobs" || host === "account.amazon.jobs") return "amazon";
  if (host === "jobs.apple.com") return "apple";
  return null;
}

/** The signed-in browser profile: AUTOAPPLY_BROWSER_PROFILE, else `<home>/browser-profiles/careers`. */
export function careerProfileDir(home: string): string {
  const configured = process.env.AUTOAPPLY_BROWSER_PROFILE?.trim();
  return configured ? configured : join(home, "browser-profiles", "careers");
}

/**
 * The installed Chrome by default: a profile signed in by hand in Chrome keeps
 * its cookies readable only to the same browser build. `chromium` selects
 * Playwright's bundled browser instead.
 */
export function careerBrowserChannel(): string | undefined {
  const configured = process.env.AUTOAPPLY_BROWSER_CHANNEL?.trim().toLowerCase();
  if (configured === "chromium") return undefined;
  return configured || "chrome";
}

/**
 * Index of the offered location to pick. The candidate's relocation targets win
 * (matched by location class, so "Sunnyvale, CA" satisfies "San Francisco Bay
 * Area"), then the employer's own order. Blank placeholder rows are skipped.
 */
export function preferredLocationIndex(options: readonly string[], relocationTargets: readonly string[]): number {
  const usable = options.map((option, index) => ({ option: option.trim(), index })).filter((entry) => entry.option.length > 0);
  if (usable.length === 0) return -1;
  const targetClasses = new Set(relocationTargets.map((target) => analyzeLocation([target]).locationClass));
  const preferred = usable.find((entry) => targetClasses.has(analyzeLocation([entry.option]).locationClass));
  return (preferred ?? usable[0]!).index;
}

/** Which step of Google's application a URL is on. */
export function googleStage(url: string): "profile" | "role" | "vsi" | "review" | "other" {
  const match = /\/about\/careers\/applications\/apply\/[^/]+\/([a-z]+)/.exec(url);
  switch (match?.[1]) {
    case "form":
      return "profile";
    case "role":
      return "role";
    case "vsi":
      return "vsi";
    case "review":
      return "review";
    default:
      return "other";
  }
}

const GOOGLE_CONFIRMATION = /application (?:has been |was )?submitted|thanks? (?:you )?for applying|you(?:'ve| have) applied|we(?:'ve| have) received your application/i;
const META_CONFIRMATION = /application (?:has been |was )?submitted|thanks? (?:you )?for applying|you(?:'ve| have) applied|your application (?:is|was) (?:sent|received)/i;

/** Whether a page after Google's final Apply shows the application went in. */
export function googleConfirmed(text: string, url: string): boolean {
  // A page that says it refused the submission cannot also be confirming it.
  if (detectSubmissionRejection(text)) return false;
  if (googleStage(url) === "review") return false;
  return GOOGLE_CONFIRMATION.test(text) || /\/about\/careers\/applications\/dashboard/.test(url) || detectSubmissionConfirmation(text, url);
}

export function metaConfirmed(text: string, url: string): boolean {
  if (detectSubmissionRejection(text)) return false;
  if (/\/profile\/create_application\//.test(url) && !META_CONFIRMATION.test(text)) return false;
  return META_CONFIRMATION.test(text) || /\/profile\/(?:applications|job_applications)/.test(url) || detectSubmissionConfirmation(text, url);
}

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

/**
 * The resume as an upload under a neutral name. Recruiters see the file name,
 * and "jane-doe-ai-security.pdf" advertises a variant built for them.
 */
export function resumeUploadName(packet: Pick<SubmissionPacket, "answers" | "resumePath">): string {
  const named = (label: string) =>
    packet.answers.find((answer) => normalizeLabel(answer.label) === label)?.answer.trim().replace(/[^\p{L}\p{N}-]+/gu, "") ?? "";
  const first = named("first name");
  const last = named("last name");
  const extension = (/\.[a-z0-9]+$/i.exec(packet.resumePath)?.[0] ?? ".pdf").toLowerCase();
  return first && last ? `${first}_${last}_Resume${extension}` : basename(packet.resumePath);
}

function resumeUpload(packet: SubmissionPacket): { name: string; mimeType: string; buffer: Buffer } {
  const name = resumeUploadName(packet);
  const mimeType = name.toLowerCase().endsWith(".docx")
    ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    : "application/pdf";
  return { name, mimeType, buffer: readFileSync(packet.resumePath) };
}

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

function result(
  status: BrowserRunResult["status"],
  reason: string,
  page: SitePage,
  extra: Partial<BrowserRunResult> = {},
): BrowserRunResult {
  return {
    status,
    reason,
    filledFields: [],
    unmatchedRequired: [],
    unusedAnswers: [],
    screenshotPath: null,
    finalUrl: page.url(),
    confirmationText: "",
    captchaDetected: false,
    ...extra,
  };
}

/** Marks the first element matching a test in the page so a locator can click it. */
async function markElement(page: SitePage, selector: string, pattern: string, flags = "i"): Promise<boolean> {
  return (await page.evaluate(
    `(() => {
      document.querySelectorAll('[data-autoapply-click]').forEach((el) => el.removeAttribute('data-autoapply-click'));
      const re = new RegExp(${JSON.stringify(pattern)}, ${JSON.stringify(flags)});
      const visible = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none'; };
      const hit = Array.from(document.querySelectorAll(${JSON.stringify(selector)}))
        .find((el) => visible(el) && [el.innerText, el.getAttribute('aria-label'), el.value]
          .some((text) => text && re.test(String(text).replace(/\\s+/g, ' ').trim())));
      if (!hit) return false;
      hit.setAttribute('data-autoapply-click', '1');
      return true;
    })()`,
  )) as boolean;
}

async function clickMarked(page: SitePage, selector: string, pattern: string): Promise<boolean> {
  if (!(await markElement(page, selector, pattern))) return false;
  await page.locator('[data-autoapply-click="1"]').first().click({ timeout: 10_000 });
  return true;
}

async function settle(page: SitePage, ms = 2500): Promise<void> {
  await page.waitForLoadState("domcontentloaded", { timeout: 30_000 }).catch(() => undefined);
  await page.waitForTimeout(ms);
}

async function waitFor(page: SitePage, test: () => Promise<boolean> | boolean, timeoutMs: number): Promise<boolean> {
  for (let waited = 0; waited <= timeoutMs; waited += 1000) {
    if (await test()) return true;
    await page.waitForTimeout(1000);
  }
  return false;
}

// ---------------------------------------------------------------- Google

async function dismissGoogleCookies(page: SitePage): Promise<void> {
  if (await markElement(page, "button", "^no thanks$")) {
    await page.locator('[data-autoapply-click="1"]').first().click({ timeout: 5000 }).catch(() => undefined);
  }
}

async function googleSignedIn(page: SitePage): Promise<boolean> {
  return (await page.evaluate(
    `!!document.querySelector('a[aria-label^="Google Account"], a[href^="https://accounts.google.com/SignOutOptions"]')`,
  )) as boolean;
}

/** Opens the preferred-location dropdown, if the role step has one, and picks a location. */
async function chooseGoogleLocation(page: SitePage, relocationTargets: readonly string[]): Promise<string | null> {
  const combobox = page.locator('[role="combobox"]').first();
  if ((await combobox.count()) === 0) return null;
  const current = (await combobox.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
  await combobox.click({ timeout: 10_000 });
  await page.waitForTimeout(800);
  const options = (await page.evaluate(
    `Array.from(document.querySelectorAll('[role="option"]')).map((el) => (el.innerText || '').replace(/\\s+/g, ' ').trim())`,
  )) as string[];
  const index = preferredLocationIndex(options, relocationTargets);
  if (index < 0) return null;
  await page.locator('[role="option"]').nth(index).click({ timeout: 10_000 });
  await page.waitForTimeout(600);
  logger.info("google preferred location chosen", { chosen: options[index], previously: current });
  return options[index] ?? null;
}

/**
 * Declines every voluntary self-identification question. The candidate's
 * standing answer to all of them is decline, and Google offers a decline
 * choice in each group: a radio for gender, veteran and disability status, a
 * list option for race.
 */
async function declineGoogleSelfId(page: SitePage): Promise<string[]> {
  const declined = (await page.evaluate(
    `(() => {
      const DECLINE = /^(i choose not to disclose|i do not want to answer|i don.t wish to answer|i prefer not to)/i;
      const done = [];
      const groups = new Map();
      for (const el of document.querySelectorAll('input[type="radio"]')) {
        const key = el.name || el.id;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(el);
      }
      for (const [name, radios] of groups) {
        if (radios.some((r) => r.checked)) continue;
        for (const radio of radios) {
          const label = (radio.id && document.querySelector('label[for="' + CSS.escape(radio.id) + '"]')) || radio.closest('label');
          const text = ((label && label.innerText) || '').replace(/\\s+/g, ' ').trim();
          if (DECLINE.test(text)) { (label || radio).click(); done.push(name + ':' + text); break; }
        }
      }
      for (const option of document.querySelectorAll('[role="option"][aria-label]')) {
        if (DECLINE.test(option.getAttribute('aria-label') || '') && option.getAttribute('aria-selected') !== 'true') {
          option.setAttribute('data-autoapply-decline', '1');
          done.push('list:' + option.getAttribute('aria-label'));
        }
      }
      return done;
    })()`,
  )) as string[];
  // List options select on the pointer sequence a real click produces; a
  // scripted element.click() leaves them unselected.
  const options = page.locator('[data-autoapply-decline="1"]');
  for (let index = 0; index < (await options.count()); index += 1) {
    await options.nth(index).click({ timeout: 10_000 });
    await page.waitForTimeout(400);
  }
  await page.waitForTimeout(800);
  return declined;
}

async function clickEnabledButton(page: SitePage, pattern: string, selector = "button"): Promise<boolean> {
  if (!(await markElement(page, selector, pattern))) return false;
  const disabled = (await page.evaluate(
    `(() => { const el = document.querySelector('[data-autoapply-click="1"]'); return !!el && (el.disabled === true || el.getAttribute('aria-disabled') === 'true'); })()`,
  )) as boolean;
  if (disabled) return false;
  const button = page.locator('[data-autoapply-click="1"]').first();
  if (button.isEnabled && !(await button.isEnabled().catch(() => false))) return false;
  await button.click({ timeout: 10_000 });
  return true;
}

/**
 * Swaps the resume on the candidate's Google careers profile for the variant
 * chosen for this role. Google attaches the profile's resume to every
 * application, so this is the only way to send a role-specific one.
 *
 * Google's "fill out your application with your resume information" option
 * is unticked first: it would rewrite the profile's contact, education and
 * employment details from whatever its parser reads off the file.
 */
async function replaceGoogleResume(page: SitePage, packet: SubmissionPacket): Promise<string | null> {
  if (!page.waitForEvent) return "this browser cannot upload files";
  const draft = /\/about\/careers\/applications\/apply\/([^/]+)\//.exec(page.url())?.[1];
  if (!draft) return "no Google application draft to attach a resume to";
  await page.goto(`https://www.google.com/about/careers/applications/apply/${draft}/form`, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await settle(page, 3000);
  await dismissGoogleCookies(page);
  if (await markElement(page, "button", "^edit$")) {
    await page.locator('[data-autoapply-click="1"]').first().click({ timeout: 10_000 });
    await page.waitForTimeout(3000);
  }
  if (await markElement(page, "button, [role=button]", "remove resume")) {
    await page.locator('[data-autoapply-click="1"]').first().click({ timeout: 10_000 });
    await page.waitForTimeout(2000);
  }
  await page.evaluate(
    `(() => {
      const box = Array.from(document.querySelectorAll('input[type="checkbox"]')).find((el) =>
        /fill out your application with your r[eé]sum[eé]/i.test(((el.closest('label') || el.parentElement?.parentElement || {}).innerText) || ''));
      if (box && box.checked) box.click();
    })()`,
  );
  if (!(await clickMarked(page, "button, [role=button]", "upload r[eé]sum[eé]"))) return "Google offered no resume upload control";
  await page.waitForTimeout(1200);
  const chooser = page.waitForEvent("filechooser", { timeout: 15_000 });
  if (!(await clickMarked(page, '[role="menuitem"], li', "^my computer$"))) return "Google's upload menu had no 'My computer' choice";
  const upload = resumeUpload(packet);
  await (await chooser).setFiles(upload);
  const attached = await waitFor(
    page,
    async () => ((await page.evaluate(`(document.querySelector('main') || document.body).innerText`)) as string).includes(upload.name),
    40_000,
  );
  if (!attached) return `Google did not show ${upload.name} as uploaded`;
  // Saving the profile requires certifying it is accurate. Only the resume was
  // changed here; the rest is the candidate's own profile as they left it.
  await page.evaluate(
    `(() => {
      const box = Array.from(document.querySelectorAll('input[type="checkbox"]')).find((el) =>
        /certify that, to the best of my knowledge, the provided information is true and accurate/i
          .test(((el.closest('label') || el.parentElement?.parentElement || {}).innerText) || ''));
      if (box && !box.checked) box.click();
    })()`,
  );
  await page.waitForTimeout(500);
  if (!(await clickEnabledButton(page, "submit profile( & continue)?$"))) return "Google's 'Submit profile & continue' button was missing or disabled";
  const advanced = await waitFor(page, () => googleStage(page.url()) !== "profile", 30_000);
  if (!advanced) {
    const complaint = ((await page.evaluate(
      `Array.from(document.querySelectorAll('[role="alert"], .error, [aria-live]')).map((el) => el.innerText).join(' ')`,
    )) as string).replace(/\s+/g, " ").trim();
    return `Google kept the careers profile open after saving${complaint ? `: ${complaint.slice(0, 200)}` : ""}`;
  }
  await settle(page, 2000);
  logger.info("google careers profile resume replaced", { file: upload.name });
  return null;
}

/** Questions on the page answered by a radio group in which nothing is selected yet. */
async function unansweredRadioQuestions(page: SitePage): Promise<string[]> {
  return (await page.evaluate(
    `(() => {
      const shown = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden'; };
      const groups = new Map();
      for (const el of document.querySelectorAll('input[type="radio"]')) {
        const key = el.name || el.id;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(el);
      }
      const open = [];
      for (const radios of groups.values()) {
        if (radios.some((r) => r.checked)) continue;
        // Styled radios hide the input itself, so a group counts as on screen
        // when any of its inputs or their labels is.
        const onScreen = radios.some((r) => shown(r) || shown((r.id && document.querySelector('label[for="' + CSS.escape(r.id) + '"]')) || r.closest('label')));
        if (!onScreen) continue;
        const group = radios[0].closest('[role="radiogroup"]');
        // Amazon names the question only through aria-labelledby, pointing at a
        // label hidden from assistive tech; without it the group's field name,
        // such as REQUIRE_SPONSORSHIP, was all there was to report.
        const ref = group && group.getAttribute('aria-labelledby');
        const labelled = ref
          ? ref.split(/\\s+/).map((id) => document.getElementById(id)).filter(Boolean).map((el) => el.innerText || el.textContent || '').join(' ')
          : '';
        const statement = (group?.previousElementSibling?.innerText || labelled || group?.getAttribute('aria-label') || radios[0].name || '')
          .replace(/\\s*\\*\\s*$/, '');
        open.push(statement.replace(/\\s+/g, ' ').trim().slice(0, 300) || 'an unanswered choice');
      }
      return open;
    })()`,
  )) as string[];
}

/**
 * Answers Google's "Do you have these minimum qualifications?" groups. Each
 * qualification is its own Yes / No / Not sure group, and every group carries
 * the same accessible name, so the generic filler cannot tell them apart. The
 * statement printed above each group is the question: it is answered only from
 * an answer recorded for that exact statement, and anything else is left for a
 * person, because these are claims about the candidate's own experience.
 */
async function answerGoogleQualifications(page: SitePage, packet: SubmissionPacket): Promise<string[]> {
  const groups = (await page.evaluate(
    `(() => Array.from(document.querySelectorAll('[role="radiogroup"]'))
      .filter((group) => /minimum qualifications/i.test(group.getAttribute('aria-label') || ''))
      .map((group, index) => {
        group.setAttribute('data-autoapply-qual', String(index));
        const radios = Array.from(group.querySelectorAll('input[type="radio"]'));
        return {
          index,
          statement: (group.previousElementSibling?.innerText || radios[0]?.name || '').replace(/\\s+/g, ' ').trim(),
          answered: radios.some((r) => r.checked),
        };
      }))()`,
  )) as Array<{ index: number; statement: string; answered: boolean }>;
  const filled: string[] = [];
  for (const group of groups) {
    if (group.answered) continue;
    const recorded = packet.answers.find(
      (answer) => normalizeLabel(answer.label) === normalizeLabel(group.statement) && answer.answer.trim().length > 0,
    );
    if (!recorded) continue;
    const clicked = (await page.evaluate(
      `(() => {
        const group = document.querySelector('[data-autoapply-qual="${group.index}"]');
        const want = ${JSON.stringify(recorded.answer.trim().toLowerCase())};
        for (const radio of group.querySelectorAll('input[type="radio"]')) {
          const label = (radio.id && document.querySelector('label[for="' + CSS.escape(radio.id) + '"]')) || radio.closest('label');
          if (((label && label.innerText) || radio.value || '').trim().toLowerCase() === want) { (label || radio).click(); return true; }
        }
        return false;
      })()`,
    )) as boolean;
    if (clicked) filled.push(group.statement);
    await page.waitForTimeout(300);
  }
  return filled;
}

async function walkGoogle(run: CareerSiteRun): Promise<BrowserRunResult> {
  const { page, packet, hooks } = run;
  await page.goto(packet.applyUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await settle(page);
  await dismissGoogleCookies(page);
  if (!(await googleSignedIn(page))) {
    return result("aborted", "not signed in to Google Careers in the career-site browser profile; sign in again by hand", page, {
      screenshotPath: await hooks.capture("google-signin"),
    });
  }
  // The posting page carries an Apply link into a draft; the sign-in apply URL lands there directly.
  if (googleStage(page.url()) === "other") {
    if (!(await clickMarked(page, "a, button", "^apply( now)?$"))) {
      return result("aborted", "no Apply control on the Google posting; it may have closed", page, {
        screenshotPath: await hooks.capture("google-no-apply"),
      });
    }
    await waitFor(page, () => googleStage(page.url()) !== "other", 30_000);
    await settle(page);
  }

  const filled: StepFill["filled"] = [];
  const resumeProblem = await replaceGoogleResume(page, packet);
  if (resumeProblem) {
    return result("aborted", `could not attach the chosen resume on Google: ${resumeProblem}`, page, {
      screenshotPath: await hooks.capture("google-resume"),
    });
  }
  filled.push({ label: "Resume", source: "profile" });
  for (let step = 0; step < 8 && googleStage(page.url()) !== "review"; step += 1) {
    await dismissGoogleCookies(page);
    const stage = googleStage(page.url());
    const problems: string[] = [];
    if (stage === "role") {
      const location = await chooseGoogleLocation(page, run.relocationTargets);
      if (location) filled.push({ label: "Preferred Location", source: "profile" });
      const fill = await hooks.fillStep();
      if ("status" in fill) return { ...fill, filledFields: [...filled, ...fill.filledFields] };
      filled.push(...fill.filled);
      for (const statement of await answerGoogleQualifications(page, packet)) filled.push({ label: statement, source: "human" });
      problems.push(...(await unansweredRadioQuestions(page)));
      if (problems.length > 0) {
        return result("aborted", `required field(s) could not be filled: ${problems.join("; ")}`, page, {
          filledFields: filled,
          unmatchedRequired: problems,
          screenshotPath: await hooks.capture("google-role-unanswered"),
        });
      }
    } else if (stage === "vsi") {
      for (const choice of await declineGoogleSelfId(page)) filled.push({ label: `Self-identification ${choice}`, source: "profile" });
    } else if (stage === "other") {
      return result("aborted", `unexpected Google application page ${new URL(page.url()).pathname}`, page, {
        filledFields: filled,
        screenshotPath: await hooks.capture("google-unexpected"),
      });
    }
    const before = page.url();
    if (!(await clickEnabledButton(page, "^next$"))) {
      const shot = await hooks.capture(`google-${stage}-stuck`);
      return result(
        "aborted",
        stage === "profile"
          ? "the Google careers profile is incomplete; finish it by hand once"
          : `Google's ${stage} step would not advance${problems.length ? `: ${problems.join("; ")}` : " (a required answer is missing)"}`,
        page,
        { filledFields: filled, unmatchedRequired: problems, screenshotPath: shot },
      );
    }
    if (!(await waitFor(page, () => page.url() !== before, 20_000))) {
      const open = await unansweredRadioQuestions(page);
      return result("aborted", `Google's ${stage} step would not advance${open.length ? `; unanswered: ${open.join("; ")}` : ""}`, page, {
        filledFields: filled,
        unmatchedRequired: open,
        screenshotPath: await hooks.capture(`google-${stage}-stuck`),
      });
    }
    await settle(page, 2000);
  }

  if (googleStage(page.url()) !== "review") {
    return result("aborted", "Google application never reached its review step", page, {
      filledFields: filled,
      screenshotPath: await hooks.capture("google-no-review"),
    });
  }
  const reviewShot = await hooks.capture("google-review");
  if (!run.submit) {
    return result("prepared", "Google application filled to its review step; Apply not pressed", page, {
      filledFields: filled,
      screenshotPath: reviewShot,
    });
  }
  // Apply stays disabled until the applicant-privacy consent is ticked.
  const consentPending = (await page.evaluate(
    `(() => {
      const box = Array.from(document.querySelectorAll('input[type="checkbox"]')).find((el) =>
        /information I submit as part of my job application will be used in accordance with/i
          .test(((el.closest('label') || el.parentElement?.parentElement || {}).innerText) || ''));
      if (!box || box.checked) return false;
      box.setAttribute('data-autoapply-consent', '1');
      return true;
    })()`,
  )) as boolean;
  if (consentPending) {
    await page.locator('[data-autoapply-consent="1"]').first().click({ timeout: 10_000, force: true }).catch(() => undefined);
    await page.waitForTimeout(800);
  }
  if (!(await clickEnabledButton(page, "^apply$"))) {
    return result("aborted", "the Apply button on Google's review step was missing or disabled", page, {
      filledFields: filled,
      screenshotPath: reviewShot,
    });
  }
  let text = "";
  const confirmed = await waitFor(
    page,
    async () => {
      text = await hooks.readText();
      return googleConfirmed(text, page.url());
    },
    60_000,
  );
  const shot = await hooks.capture(confirmed ? "confirmation" : "google-after-apply");
  return confirmed
    ? result("submitted", "Google application submitted; confirmation captured", page, {
        filledFields: filled,
        screenshotPath: shot,
        confirmationText: text.replace(/\s+/g, " ").slice(0, 600),
      })
    : result("aborted", "Apply was pressed but Google showed no confirmation; check the Google Careers dashboard", page, {
        filledFields: filled,
        screenshotPath: shot,
        confirmationText: text.replace(/\s+/g, " ").slice(0, 600),
      });
}

// ---------------------------------------------------------------- Meta

async function metaSignedIn(page: SitePage): Promise<boolean> {
  const text = (await page.evaluate(`(document.body && document.body.innerText) || ''`)) as string;
  return !/\blog ?in\b/i.test(text.slice(0, 400)) || /create_application/.test(page.url());
}

/** Ticks every offered location the candidate would relocate to, or all of them when none matches. */
async function chooseMetaLocations(page: SitePage, relocationTargets: readonly string[]): Promise<string[]> {
  const offered = (await page.evaluate(
    `(() => {
      const box = Array.from(document.querySelectorAll('input[type="checkbox"]'));
      return box.map((el) => {
        const label = (el.id && document.querySelector('label[for="' + CSS.escape(el.id) + '"]')) || el.closest('label') || el.parentElement;
        return { text: ((label && label.innerText) || '').replace(/\\s+/g, ' ').trim(), checked: el.checked };
      });
    })()`,
  )) as Array<{ text: string; checked: boolean }>;
  const usable = offered.map((entry, index) => ({ ...entry, index })).filter((entry) => entry.text.length > 0);
  if (usable.length === 0) return [];
  const targetClasses = new Set(relocationTargets.map((target) => analyzeLocation([target]).locationClass));
  const preferred = usable.filter((entry) => targetClasses.has(analyzeLocation([entry.text]).locationClass));
  const chosen = preferred.length > 0 ? preferred : usable;
  for (const entry of chosen) {
    if (entry.checked) continue;
    await page.evaluate(
      `(() => {
        const el = document.querySelectorAll('input[type="checkbox"]')[${entry.index}];
        const label = (el.id && document.querySelector('label[for="' + CSS.escape(el.id) + '"]')) || el.closest('label');
        (label || el).click();
      })()`,
    );
    await page.waitForTimeout(300);
  }
  return chosen.map((entry) => entry.text);
}

/**
 * Meta's self-identification radios carry no name, so nothing groups them and
 * a generic filler reads each option as its own question. Each question offers
 * "I choose not to disclose", which is the candidate's standing answer, so
 * every one of those is selected directly.
 */
async function declineMetaSelfId(page: SitePage): Promise<number> {
  return (await page.evaluate(
    `(() => {
      let picked = 0;
      for (const radio of document.querySelectorAll('input[type="radio"]')) {
        const label = (radio.id && document.querySelector('label[for="' + CSS.escape(radio.id) + '"]')) || radio.closest('label');
        const text = ((label && label.innerText) || radio.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim();
        if (/^i choose not to disclose$/i.test(text) && !radio.checked) { (label || radio).click(); picked += 1; }
      }
      return picked;
    })()`,
  )) as number;
}

/**
 * Swaps the resume stored on the Meta Careers profile for the variant chosen
 * for this role. Always replaced: every variant uploads under the same neutral
 * name, so a matching file name says nothing about which variant is on file.
 */
async function replaceMetaResume(page: SitePage, packet: SubmissionPacket): Promise<string | null> {
  const upload = resumeUpload(packet);
  const pageText = async () => ((await page.evaluate(`(document.body && document.body.innerText) || ''`)) as string);
  const existing = /Remove (.+?) from profile/i;
  if (await markElement(page, '[role="button"], button', "^remove .+ from profile$")) {
    await page.locator('[data-autoapply-click="1"]').first().click({ timeout: 10_000 });
    const removed = await waitFor(page, async () => !(await markElement(page, '[role="button"], button', existing.source)), 10_000);
    if (!removed) return "Meta kept the resume already on the profile";
    await page.waitForTimeout(1000);
  }
  const input = page.locator('input[type="file"]');
  if ((await input.count()) > 0) {
    await input.first().setInputFiles(upload);
  } else {
    if (!page.waitForEvent) return "this browser cannot upload files";
    const chooser = page.waitForEvent("filechooser", { timeout: 15_000 });
    if (!(await clickMarked(page, '[role="button"], button, label', "upload|choose (a )?file|select (a )?file|browse"))) {
      return "Meta offered no resume upload control";
    }
    await (await chooser).setFiles(upload);
  }
  return (await waitFor(page, async () => (await pageText()).includes(upload.name), 30_000))
    ? null
    : `Meta did not show ${upload.name} as uploaded`;
}

/** Visible inputs the form still needs: empty, enabled, and not one this walker owns. */
async function emptyMetaFields(page: SitePage): Promise<string[]> {
  return (await page.evaluate(
    `(() => {
      const visible = (el) => { const r = el.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
      return Array.from(document.querySelectorAll('input[type="text"], input[type="tel"], input[type="url"], input[type="email"], input:not([type]), textarea, select'))
        .filter((el) => visible(el) && !el.disabled && !el.readOnly && !String(el.value || '').trim())
        .map((el) => {
          const label = (el.id && document.querySelector('label[for="' + CSS.escape(el.id) + '"]')) || el.closest('label');
          return ((label && label.innerText) || el.getAttribute('aria-label') || el.placeholder || 'an unnamed field').replace(/\\s+/g, ' ').trim().slice(0, 120);
        });
    })()`,
  )) as string[];
}

async function walkMeta(run: CareerSiteRun): Promise<BrowserRunResult> {
  const { page, packet, hooks } = run;
  await page.goto(packet.applyUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await settle(page, 5000);
  if (!/create_application/.test(page.url()) || !(await metaSignedIn(page))) {
    return result("aborted", "not signed in to Meta Careers in the career-site browser profile, or the posting has closed", page, {
      screenshotPath: await hooks.capture("meta-entry"),
    });
  }
  const filled: StepFill["filled"] = [];
  const resumeProblem = await replaceMetaResume(page, packet);
  if (resumeProblem) {
    return result("aborted", `could not attach the chosen resume on Meta: ${resumeProblem}`, page, {
      screenshotPath: await hooks.capture("meta-resume"),
    });
  }
  filled.push({ label: "Resume", source: "profile" });
  for (const location of await chooseMetaLocations(page, run.relocationTargets)) filled.push({ label: `Location ${location}`, source: "profile" });
  const declined = await declineMetaSelfId(page);
  if (declined > 0) filled.push({ label: `Self-identification (${declined} declined)`, source: "profile" });
  await page.waitForTimeout(800);
  const problems = await emptyMetaFields(page);
  if (problems.length > 0) {
    return result("aborted", `required field(s) could not be filled: ${problems.join("; ")}`, page, {
      filledFields: filled,
      unmatchedRequired: problems,
      screenshotPath: await hooks.capture("meta-unfilled"),
    });
  }
  const formShot = await hooks.capture("meta-form");
  if (!run.submit) {
    return result("prepared", "Meta application filled; Submit not pressed", page, { filledFields: filled, screenshotPath: formShot });
  }
  if (!(await clickEnabledButton(page, "^submit( application)?$", 'button, [role="button"]'))) {
    return result("aborted", "the Submit button on Meta's application was missing or disabled", page, {
      filledFields: filled,
      screenshotPath: formShot,
    });
  }
  let text = "";
  const confirmed = await waitFor(
    page,
    async () => {
      text = await hooks.readText();
      return metaConfirmed(text, page.url());
    },
    60_000,
  );
  const shot = await hooks.capture(confirmed ? "confirmation" : "meta-after-submit");
  return result(
    confirmed ? "submitted" : "aborted",
    confirmed
      ? "Meta application submitted; confirmation captured"
      : "Submit was pressed but Meta showed no confirmation; check the Meta Careers profile",
    page,
    { filledFields: filled, screenshotPath: shot, confirmationText: text.replace(/\s+/g, " ").slice(0, 600) },
  );
}

/** Walks one employer career-site application in the signed-in profile. */
export async function runCareerSiteApplication(run: CareerSiteRun): Promise<BrowserRunResult> {
  switch (run.site) {
    case "google":
      return walkGoogle(run);
    case "meta":
      return walkMeta(run);
    case "amazon":
      return walkAmazon(run);
    default:
      return result("aborted", `${run.site} career-site applications are not automated yet`, run.page);
  }
}

// ---------------------------------------------------------------- Amazon

const AMAZON_CONTINUE = "^(skip & continue|save (?:&|and) continue|continue|next)$";
const AMAZON_DEMOGRAPHIC_STEP = /self[- ]identification|veteran|disability|equal employment/i;

export const AMAZON_CONFIRMATION = /application (?:has been |was )?submitted|thank you for (?:applying|your application)|you(?:'ve| have) (?:successfully )?applied|we(?:'ve| have) received your application/i;

/** The heading of the wizard step on screen: the first visible heading after the progress list. */
async function amazonStepName(page: SitePage): Promise<string> {
  return ((await page.evaluate(
    `(() => {
      const main = document.querySelector('main') || document.body;
      const skip = /^(apply|my progress|optional)$/i;
      const shown = (el) => { const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden'; };
      const heads = Array.from(main.querySelectorAll('h1, h2, h3, legend'))
        .filter(shown)
        .map((h) => (h.innerText || '').replace(/\\s+/g, ' ').trim())
        .filter((t) => t && !skip.test(t) && !/\\(ID: \\d+\\)/.test(t));
      return heads[0] || '';
    })()`,
  )) as string);
}

/** On a self-identification step, every chosen answer must be a decline. */
async function amazonNonDeclineChoices(page: SitePage): Promise<string[]> {
  return (await page.evaluate(
    `(() => {
      const DECLINE = /(not|n't) (wish|want) to|decline|prefer not|choose not|not to (disclose|answer|self)/i;
      const picked = [];
      for (const radio of document.querySelectorAll('input[type="radio"]:checked, input[type="checkbox"]:checked')) {
        const label = (radio.id && document.querySelector('label[for="' + CSS.escape(radio.id) + '"]')) || radio.closest('label');
        const text = ((label && label.innerText) || radio.value || '').replace(/\\s+/g, ' ').trim();
        if (text && !DECLINE.test(text)) picked.push(text);
      }
      for (const select of document.querySelectorAll('select')) {
        const text = (select.options[select.selectedIndex] || {}).text || '';
        if (select.selectedIndex > 0 && !DECLINE.test(text)) picked.push(text.trim());
      }
      return picked;
    })()`,
  )) as string[];
}

const AMAZON_AI_PREFERENCE = /choose your ai preference|amazon uses ai to enhance/i;

/**
 * Amazon's "Choose your AI preference" consent, a Yes / No pair whose labels
 * run on into a description, so a generic filler cannot match "Yes" to them.
 * Answered only from an answer recorded for that question, on the application
 * or in the answer bank.
 */
async function answerAmazonAiPreference(page: SitePage, packet: SubmissionPacket, hooks: CareerSiteHooks): Promise<boolean> {
  const recorded =
    packet.answers.find((answer) => AMAZON_AI_PREFERENCE.test(answer.label) && answer.answer.trim())?.answer.trim() ??
    hooks.resolveChoice("Choose your AI preference", ["Yes", "No"]);
  if (!recorded) return false;
  return (await page.evaluate(
    `(() => {
      const want = ${JSON.stringify(recorded.toLowerCase().startsWith("y") ? "yes" : "no")};
      const radios = Array.from(document.querySelectorAll('input[type="radio"][name="consent-choice"]'));
      if (radios.length === 0 || radios.some((r) => r.checked)) return false;
      for (const radio of radios) {
        const label = (radio.id && document.querySelector('label[for="' + CSS.escape(radio.id) + '"]')) || radio.closest('label');
        const text = ((label && label.innerText) || '').trim().toLowerCase();
        const rect = (label || radio).getBoundingClientRect();
        if (rect.width > 0 && text.startsWith(want)) { (label || radio).click(); return true; }
      }
      return false;
    })()`,
  )) as boolean;
}

/**
 * Amazon renders its choice questions with Select2: the real `<select>` is
 * hidden behind a styled span, so the generic filler never sees them. Each
 * visible one is answered through `resolveChoice` and set on the underlying
 * select, with the change event Select2 and the form listen for.
 */
async function fillAmazonSelects(page: SitePage, hooks: CareerSiteHooks): Promise<{ filled: string[]; open: string[] }> {
  const fields = (await page.evaluate(
    `(() => {
      const shown = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.opacity !== '0'; };
      return Array.from(document.querySelectorAll('select')).map((select, index) => {
        select.setAttribute('data-autoapply-sel', String(index));
        const widget = select.nextElementSibling && /select2/.test(select.nextElementSibling.className) ? select.nextElementSibling : null;
        const labelledBy = widget && widget.querySelector('[aria-labelledby]') && widget.querySelector('[aria-labelledby]').getAttribute('aria-labelledby');
        const label = (labelledBy && document.getElementById(labelledBy) && document.getElementById(labelledBy).innerText)
          || (select.id && document.querySelector('label[for="' + CSS.escape(select.id) + '"]') && document.querySelector('label[for="' + CSS.escape(select.id) + '"]').innerText)
          || select.getAttribute('aria-label') || '';
        return {
          index,
          visible: widget ? shown(widget) : shown(select),
          label: label.replace(/\\s*\\*\\s*$/, '').replace(/\\s+/g, ' ').trim(),
          options: Array.from(select.options).map((o) => o.text.replace(/\\s+/g, ' ').trim()),
          chosen: select.selectedIndex > 0 || (select.selectedIndex === 0 && select.options[0] && select.options[0].value !== ''),
          required: select.required || !!(widget && widget.querySelector('[aria-required="true"]')),
        };
      }).filter((field) => field.visible);
    })()`,
  )) as Array<{ index: number; label: string; options: string[]; chosen: boolean; required: boolean }>;
  const filled: string[] = [];
  const open: string[] = [];
  for (const field of fields) {
    if (field.chosen) continue;
    const offered = field.options.filter((option) => option.length > 0 && !/^select an option$/i.test(option));
    const choice = hooks.resolveChoice(field.label, offered);
    if (!choice) {
      if (field.required) open.push(field.label || "an unlabelled choice");
      continue;
    }
    const set = (await page.evaluate(
      `(() => {
        const select = document.querySelector('[data-autoapply-sel="${field.index}"]');
        const index = Array.from(select.options).findIndex((o) => o.text.replace(/\\s+/g, ' ').trim() === ${JSON.stringify(choice)});
        if (index < 0) return false;
        select.selectedIndex = index;
        select.dispatchEvent(new Event('input', { bubbles: true }));
        select.dispatchEvent(new Event('change', { bubbles: true }));
        if (window.jQuery) window.jQuery(select).trigger('change');
        return select.selectedIndex === index;
      })()`,
    )) as boolean;
    if (set) filled.push(field.label);
    else open.push(field.label);
    await page.waitForTimeout(300);
  }
  return { filled, open };
}

/**
 * Amazon's radio questions carry their wording only in a label the group points
 * at through aria-labelledby, and that label is hidden from assistive tech, so
 * the generic filler sees bare Yes / No pairs. Each visible group with nothing
 * chosen is answered through `resolveChoice` and set by clicking the option's
 * label, which is what the page's own state listens to.
 */
async function answerAmazonRadios(page: SitePage, hooks: CareerSiteHooks): Promise<{ filled: string[]; open: string[] }> {
  const groups = (await page.evaluate(
    `(() => {
      const shown = (el) => { if (!el) return false; const r = el.getBoundingClientRect(); const s = getComputedStyle(el); return r.width > 0 && r.height > 0 && s.visibility !== 'hidden'; };
      const labelFor = (r) => (r.id && document.querySelector('label[for="' + CSS.escape(r.id) + '"]')) || r.closest('label');
      return Array.from(document.querySelectorAll('[role="radiogroup"]')).map((group, index) => {
        group.setAttribute('data-autoapply-rg', String(index));
        const radios = Array.from(group.querySelectorAll('input[type="radio"]'));
        const ref = group.getAttribute('aria-labelledby');
        const question = ((ref && ref.split(/\\s+/).map((id) => document.getElementById(id)).filter(Boolean).map((el) => el.innerText || el.textContent || '').join(' '))
          || group.getAttribute('aria-label') || '').replace(/\\s*\\*\\s*$/, '').replace(/\\s+/g, ' ').trim();
        return {
          index,
          question,
          options: radios.map((r) => ((labelFor(r) && labelFor(r).innerText) || r.value || '').replace(/\\s+/g, ' ').trim()),
          visible: radios.some((r) => shown(r) || shown(labelFor(r))),
          answered: radios.some((r) => r.checked),
          required: radios.some((r) => r.required || r.getAttribute('aria-required') === 'true') || /\\brequired\\b/.test(group.className),
        };
      }).filter((group) => group.visible && !group.answered && group.question);
    })()`,
  )) as Array<{ index: number; question: string; options: string[]; required: boolean }>;
  const filled: string[] = [];
  const open: string[] = [];
  for (const group of groups) {
    if (AMAZON_AI_PREFERENCE.test(group.question)) continue;
    const choice = hooks.resolveChoice(group.question, group.options);
    if (!choice) {
      if (group.required) open.push(group.question);
      continue;
    }
    const marked = (await page.evaluate(
      `(() => {
        document.querySelectorAll('[data-autoapply-pick]').forEach((el) => el.removeAttribute('data-autoapply-pick'));
        const group = document.querySelector('[data-autoapply-rg="${group.index}"]');
        for (const radio of group.querySelectorAll('input[type="radio"]')) {
          const label = (radio.id && document.querySelector('label[for="' + CSS.escape(radio.id) + '"]')) || radio.closest('label');
          const text = ((label && label.innerText) || radio.value || '').replace(/\\s+/g, ' ').trim();
          if (text === ${JSON.stringify(choice)}) { (label || radio).setAttribute('data-autoapply-pick', '1'); return true; }
        }
        return false;
      })()`,
    )) as boolean;
    if (marked) await page.locator("[data-autoapply-pick]").first().click();
    await page.waitForTimeout(300);
    const checked = (await page.evaluate(
      `(() => Array.from(document.querySelectorAll('[data-autoapply-rg="${group.index}"] input[type="radio"]')).some((r) => r.checked))()`,
    )) as boolean;
    if (checked) filled.push(group.question.slice(0, 120));
    else open.push(group.question);
  }
  return { filled, open };
}

/**
 * Amazon keeps one résumé on the candidate profile and pre-completes the
 * Resume step with it, so the wizard never stops there: a new application's
 * review page offered "Resume.pdf, uploaded Aug 29, 2025". It is replaced from
 * the review page's own file input and the new name checked on screen.
 */
async function replaceAmazonResume(page: SitePage, packet: SubmissionPacket): Promise<string | null> {
  const upload = resumeUpload(packet);
  const card = async () =>
    (await page.evaluate(
      `(() => {
        const head = Array.from(document.querySelectorAll('h1, h2, h3, h4')).find((h) => /upload your r[eé]sum[eé]/i.test(h.innerText || ''));
        let box = head;
        for (let i = 0; i < 3 && box && box.parentElement; i += 1) box = box.parentElement;
        return ((box && box.innerText) || '').replace(/\\s+/g, ' ');
      })()`,
    )) as string;
  const before = await card();
  const input = page.locator('#document-replace-input, input[type="file"]').first();
  if ((await input.count()) === 0) return "Amazon's review page offered no way to replace the résumé on file";
  await input.setInputFiles(upload);
  let after = "";
  // Amazon parses the file before showing it: "Resume upload in progress...
  // Please wait" sat on screen for over 45 seconds on one run. The card then
  // reads "Uploaded: Just now" - as it did before a re-upload minutes later -
  // so passing through that progress state is what proves this upload ran.
  let sawProgress = false;
  const replaced = await waitFor(
    page,
    async () => {
      after = await card();
      if (/upload in progress|please wait/i.test(after)) {
        sawProgress = true;
        return false;
      }
      return after.includes(upload.name) && (sawProgress || after !== before);
    },
    150_000,
  );
  if (!replaced) {
    return /upload in progress|please wait/i.test(after)
      ? "Amazon's résumé upload did not finish processing within 150 seconds"
      : `the résumé on Amazon's review page did not change to ${upload.name}`;
  }
  logger.info("amazon resume replaced", { file: upload.name });
  return null;
}

/** Every question and answer Amazon's review page states, read after expanding each section. */
async function amazonReviewAnswers(page: SitePage): Promise<Array<{ section: string; question: string; answer: string }>> {
  const toggles = (await page.evaluate(
    `(() => {
      const found = Array.from(document.querySelectorAll('a, button, [role="button"], span, div'))
        .filter((el) => /^show all answers/i.test((el.innerText || '').trim()) && !Array.from(el.children).some((c) => /^show all answers/i.test((c.innerText || '').trim())));
      found.forEach((el, index) => el.setAttribute('data-autoapply-toggle', String(index)));
      return found.length;
    })()`,
  )) as number;
  for (let index = 0; index < toggles; index += 1) {
    await page.locator(`[data-autoapply-toggle="${index}"]`).first().click({ timeout: 5000 }).catch(() => undefined);
    await page.waitForTimeout(400);
  }
  return (await page.evaluate(
    `(() => {
      const pairs = [];
      // Each section is a tabpanel named after its step; each question carries
      // a data-questionid, its wording in the "-label" label and its answer in
      // .input-display-mode behind an "A." prefix and screen-reader text.
      for (const panel of document.querySelectorAll('[role="tabpanel"][aria-label]')) {
        const section = (panel.getAttribute('aria-label') || '').replace(/\\s+/g, ' ').trim();
        for (const item of panel.querySelectorAll('.question[data-questionid]')) {
          // The review page is itself a tabpanel around every section.
          if (item.closest('[role="tabpanel"]') !== panel) continue;
          const label = item.querySelector('label[id$="-label"]');
          const display = item.querySelector('.input-display-mode');
          if (!label || !display) continue;
          const answer = display.cloneNode(true);
          answer.querySelectorAll('.answer-prefix, .sr-only').forEach((node) => node.remove());
          pairs.push({
            section,
            question: (label.innerText || label.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 1500),
            answer: (answer.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 200),
          });
        }
      }
      return pairs;
    })()`,
  )) as Array<{ section: string; question: string; answer: string }>;
}

const SELF_ID_DECLINE = /(?:not|n't) (?:wish|want) to|decline|prefer not|choose not|not to (?:disclose|answer|self)/i;
/** A veteran-status answer stating the candidate is not one: a fact on file, not an identity the run chose. */
const VETERAN_NEGATIVE = /^no\b|\bnot an? (?:protected )?veteran\b|\bdo not believe\b/i;
/** Questions with legal weight, where an answer on file must agree with the record before anything is sent. */
const ELIGIBILITY_QUESTION = /sponsor|immigration|\bvisa\b|authori[sz]ed to work|work authori[sz]ation/i;

/**
 * Yes / No eligibility answers the review page states but the record answers
 * the other way. Amazon pre-completes answers from the candidate profile and
 * fills the rest in the wizard, so the review page is the one place both can
 * be checked together: a sponsorship question defining sponsorship to include
 * TN went out as "No" once, when the record answers it "Yes".
 */
export function contradictedEligibilityAnswers(
  stated: ReadonlyArray<{ question: string; answer: string }>,
  hooks: Pick<CareerSiteHooks, "resolveChoice">,
): string[] {
  const problems: string[] = [];
  for (const pair of stated) {
    if (!ELIGIBILITY_QUESTION.test(pair.question) || !/^(?:yes|no)$/i.test(pair.answer.trim())) continue;
    const expected = hooks.resolveChoice(pair.question, ["Yes", "No"]);
    if (expected && expected.toLowerCase() !== pair.answer.trim().toLowerCase()) {
      problems.push(`${pair.question.slice(0, 80)}... states "${pair.answer}" but the record answers "${expected}"`);
    }
  }
  return problems;
}

async function walkAmazon(run: CareerSiteRun): Promise<BrowserRunResult> {
  const { page, packet, hooks } = run;
  await page.goto(packet.applyUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
  await settle(page, 5000);
  const host = new URL(page.url()).hostname;
  if (host !== "www.amazon.jobs" && host !== "account.amazon.jobs") {
    return result("aborted", "not signed in to Amazon.jobs in the career-site browser profile; sign in again by hand", page, {
      screenshotPath: await hooks.capture("amazon-signin"),
    });
  }
  const filled: StepFill["filled"] = [];
  let resumeDone = false;
  let previous = "";
  let repeats = 0;
  for (let step = 0; step < 16; step += 1) {
    if (await answerAmazonAiPreference(page, packet, hooks)) {
      filled.push({ label: "Choose your AI preference", source: "human" });
      await page.waitForTimeout(1000);
    }
    const name = await amazonStepName(page);
    const text = await hooks.readText();
    if (AMAZON_CONFIRMATION.test(text)) break;
    if (/review (?:&|and) submit|review your application/i.test(name) || (await markElement(page, 'button, [role="button"], a', "^submit application$"))) break;
    repeats = name === previous ? repeats + 1 : 0;
    previous = name;
    if (repeats >= 2) {
      return result("aborted", `Amazon's "${name}" step would not advance`, page, {
        filledFields: filled,
        screenshotPath: await hooks.capture("amazon-stuck"),
      });
    }
    if (!resumeDone) {
      const input = page.locator('input[type="file"]');
      if ((await input.count()) > 0 && /r[eé]sum[eé]/i.test(name)) {
        await input.first().setInputFiles(resumeUpload(packet));
        await page.waitForTimeout(4000);
        resumeDone = true;
        filled.push({ label: "Resume", source: "profile" });
      }
    }
    if (!/sms/i.test(name)) {
      const fill = await hooks.fillStep();
      if ("status" in fill) return { ...fill, filledFields: [...filled, ...fill.filledFields] };
      filled.push(...fill.filled);
      const selects = await fillAmazonSelects(page, hooks);
      for (const label of selects.filled) filled.push({ label, source: "profile" });
      const radios = await answerAmazonRadios(page, hooks);
      for (const label of radios.filled) filled.push({ label, source: "profile" });
      // The AI-preference pair sits in the DOM of every step but is answered by
      // answerAmazonAiPreference where it is shown; the generic filler cannot
      // read its run-on labels, so its complaint about it is not a blocker.
      const problems = [
        ...fill.problems.filter((problem) => !AMAZON_AI_PREFERENCE.test(problem)),
        ...selects.open,
        ...radios.open,
        ...(await unansweredRadioQuestions(page)).filter(
          (problem) =>
            !AMAZON_AI_PREFERENCE.test(problem) && !radios.open.some((question) => question.slice(0, 120) === problem.slice(0, 120)),
        ),
      ];
      if (AMAZON_DEMOGRAPHIC_STEP.test(name)) {
        const chosen = await amazonNonDeclineChoices(page);
        if (chosen.length > 0) problems.push(`self-identification answered with ${chosen.join(", ")} instead of a decline`);
      }
      if (problems.length > 0) {
        return result("aborted", `required field(s) could not be filled on "${name}": ${problems.join("; ")}`, page, {
          filledFields: filled,
          unmatchedRequired: problems,
          screenshotPath: await hooks.capture("amazon-unfilled"),
        });
      }
    }
    if (!(await clickEnabledButton(page, AMAZON_CONTINUE, 'button, [role="button"], a'))) {
      return result("aborted", `no way forward from Amazon's "${name}" step`, page, {
        filledFields: filled,
        screenshotPath: await hooks.capture("amazon-no-continue"),
      });
    }
    await settle(page, 3500);
  }

  const resumeProblem = await replaceAmazonResume(page, packet);
  if (resumeProblem) {
    return result("aborted", resumeProblem, page, { filledFields: filled, screenshotPath: await hooks.capture("amazon-resume") });
  }
  filled.push({ label: "Resume", source: "profile" });
  // The self-identification and eligibility answers on file were pre-completed
  // from the candidate profile, so the wizard never showed them: read them back.
  const stated = await amazonReviewAnswers(page);
  logger.info("amazon review answers", { answers: stated.map((pair) => `${pair.section} | ${pair.question.slice(0, 90)} => ${pair.answer}`) });
  const undeclined = stated.filter(
    (pair) =>
      AMAZON_DEMOGRAPHIC_STEP.test(pair.section) &&
      pair.answer &&
      !SELF_ID_DECLINE.test(pair.answer) &&
      !(/veteran/i.test(pair.section) && VETERAN_NEGATIVE.test(pair.answer)),
  );
  const reviewShot = await hooks.capture("amazon-review");
  if (undeclined.length > 0) {
    return result(
      "aborted",
      `self-identification on file is not a decline: ${undeclined.map((pair) => `${pair.question.slice(0, 60)} => ${pair.answer}`).join("; ")}`,
      page,
      { filledFields: filled, screenshotPath: reviewShot },
    );
  }
  const contradicted = contradictedEligibilityAnswers(stated, hooks);
  if (contradicted.length > 0) {
    return result(
      "aborted",
      `the review states an eligibility answer the record contradicts: ${contradicted.join("; ")}`,
      page,
      { filledFields: filled, screenshotPath: reviewShot },
    );
  }
  if (!run.submit) {
    return result("prepared", "Amazon application filled to its review step; Submit not pressed", page, {
      filledFields: filled,
      screenshotPath: reviewShot,
    });
  }
  if (await answerAmazonAiPreference(page, packet, hooks)) {
    filled.push({ label: "Choose your AI preference", source: "human" });
    await page.waitForTimeout(1000);
  }
  if (!(await clickEnabledButton(page, "^submit application$", 'button, [role="button"], a'))) {
    return result("aborted", "the Submit application button on Amazon's review step was missing or disabled", page, {
      filledFields: filled,
      screenshotPath: reviewShot,
    });
  }
  // Amazon asks for the AI preference in a dialog that opens only once Submit
  // is pressed ("Before you continue, do we have permission to improve your
  // job search and interview experience?"); the application waits behind it.
  await page.waitForTimeout(2500);
  if (await answerAmazonAiPreference(page, packet, hooks)) {
    filled.push({ label: "Choose your AI preference", source: "human" });
    await page.waitForTimeout(800);
    const continued =
      (await clickEnabledButton(page, "^continue$", '[role="dialog"] button, .modal button')) ||
      (await clickEnabledButton(page, "^continue$", 'button, [role="button"]'));
    if (!continued) {
      return result("aborted", "Amazon's AI-preference dialog offered no Continue button", page, {
        filledFields: filled,
        screenshotPath: await hooks.capture("amazon-ai-preference"),
      });
    }
  }
  let text = "";
  const confirmed = await waitFor(
    page,
    async () => {
      text = await hooks.readText();
      return AMAZON_CONFIRMATION.test(text) || detectSubmissionConfirmation(text, page.url());
    },
    60_000,
  );
  const shot = await hooks.capture(confirmed ? "confirmation" : "amazon-after-submit");
  return result(
    confirmed ? "submitted" : "aborted",
    confirmed
      ? "Amazon application submitted; confirmation captured"
      : "Submit was pressed but Amazon showed no confirmation; check the Amazon.jobs dashboard",
    page,
    { filledFields: filled, screenshotPath: shot, confirmationText: text.replace(/\s+/g, " ").slice(0, 600) },
  );
}
