import { logger } from "../../util/logger.js";
import type { BrowserRunResult } from "../browser/types.js";
import { normalizeLabel } from "../form/fieldModel.js";
import { detectSubmissionConfirmation, detectSubmissionRejection } from "../form/pageSignals.js";
import type { SubmissionPacket } from "../packet.js";
import {
  clickEnabledButton, clickMarked, markElement, preferredLocationIndex, result, resumeUpload, settle,
  unansweredRadioQuestions, waitFor,
} from "./helpers.js";
import type { CareerSiteRun, SitePage, StepFill } from "./types.js";

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

/** Whether a page after Google's final Apply shows the application went in. */
export function googleConfirmed(text: string, url: string): boolean {
  // A page that says it refused the submission cannot also be confirming it.
  if (detectSubmissionRejection(text)) return false;
  if (googleStage(url) === "review") return false;
  return GOOGLE_CONFIRMATION.test(text) || /\/about\/careers\/applications\/dashboard/.test(url) || detectSubmissionConfirmation(text, url);
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

export async function walkGoogle(run: CareerSiteRun): Promise<BrowserRunResult> {
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
