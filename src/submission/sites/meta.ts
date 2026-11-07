import { analyzeLocation } from "../../ranking/location.js";
import type { BrowserRunResult } from "../browser/types.js";
import { detectSubmissionConfirmation, detectSubmissionRejection } from "../form/pageSignals.js";
import type { SubmissionPacket } from "../packet.js";
import { clickEnabledButton, clickMarked, markElement, result, resumeUpload, settle, waitFor } from "./helpers.js";
import type { CareerSiteRun, SitePage, StepFill } from "./types.js";

const META_CONFIRMATION = /application (?:has been |was )?submitted|thanks? (?:you )?for applying|you(?:'ve| have) applied|your application (?:is|was) (?:sent|received)/i;

export function metaConfirmed(text: string, url: string): boolean {
  if (detectSubmissionRejection(text)) return false;
  if (/\/profile\/create_application\//.test(url) && !META_CONFIRMATION.test(text)) return false;
  return META_CONFIRMATION.test(text) || /\/profile\/(?:applications|job_applications)/.test(url) || detectSubmissionConfirmation(text, url);
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

export async function walkMeta(run: CareerSiteRun): Promise<BrowserRunResult> {
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
