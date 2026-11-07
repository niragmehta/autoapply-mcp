import { AppError } from "../../util/errors.js";
import { isDeclineSearch } from "../form/answerVocabulary.js";
import { pickOptionIndex } from "../form/optionMatching.js";
import { fillLeverLocation } from "../leverLocation.js";
import { hasVisibleCaptchaChallenge } from "../captcha.js";
import type { AnyLocator, AnyPage } from "./playwright.js";

export async function fillLeverLocationControl(page: AnyPage, locator: AnyLocator, candidates: readonly string[]): Promise<void> {
  const lookupUrl = `${new URL(page.url()).origin}/searchLocations`;
  let lookupStatus: number | null = null;
  const observe = (response: { url(): string; status(): number }) => {
    if (response.url().split("?")[0] !== lookupUrl) return;
    lookupStatus = response.status();
  };
  page.on?.("response", observe);
  try {
    await fillLeverLocation({
      search: async (query) => {
        lookupStatus = null;
        await searchLeverLocation(page, locator, query);
      },
      options: async () => {
        const options = await waitForVisibleOptions(page, OPTION_WAIT_MS, ".dropdown-location:visible");
        if (lookupStatus !== null && lookupStatus >= 400) {
          throw new AppError("location_lookup_failed", `Native location lookup was refused (HTTP ${lookupStatus}); no location selected`);
        }
        return options;
      },
      pick: async (index) => { await page.locator(".dropdown-location:visible").nth(index).click(); },
      selection: () => page.evaluate(`(() => ({
        display: document.getElementById("location-input")?.value || "",
        encoded: document.getElementById("selected-location")?.value || ""
      }))()`),
      hasChallenge: () => hasVisibleCaptchaChallenge(page),
    }, candidates);
  } finally {
    page.off?.("response", observe);
  }
}

async function searchLeverLocation(page: AnyPage, locator: AnyLocator, query: string): Promise<void> {
  await locator.fill("");
  if (await hasVisibleCaptchaChallenge(page)) {
    throw new AppError("captcha_required", "Interactive CAPTCHA detected during location lookup");
  }
  // Lever starts its debounced lookup on character keydown events.
  await locator.pressSequentially(query);
  await page.waitForTimeout(LEVER_LOCATION_DEBOUNCE_MS);
}

const OPTION_WAIT_MS = 6000;
const LEVER_LOCATION_DEBOUNCE_MS = 600;

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
    // A decline is asked of a short demographic list, which the unfiltered
    // look shows in full. If no way to decline is on it, typing each wording
    // can only narrow it further: Doximity's three such dropdowns took two
    // minutes apiece to report what this one read says.
    if (isDeclineSearch(candidates)) {
      await openFlyout(locator);
      await locator.fill("");
      const selector = await optionSelectorFor(page, locator);
      const optionTexts = await waitForVisibleOptions(page, OPTION_WAIT_MS, selector);
      const index = pickOptionIndex(optionTexts, candidates);
      if (index >= 0) {
        await page.locator(selector).nth(index).click();
        return;
      }
      if (optionTexts.length > 0) throw new Error(`no visible option matched ${JSON.stringify(candidates)}`);
    }
    for (const candidate of [...candidates, ""]) {
      await closeFlyout(page);
      await openFlyout(locator);
      await locator.fill(candidate);
      const selector = await optionSelectorFor(page, locator);
      const optionTexts = await waitForVisibleOptions(page, OPTION_WAIT_MS, selector);
      const index = pickOptionIndex(optionTexts, candidates);
      if (index >= 0) {
        await page.locator(selector).nth(index).click();
        return;
      }
    }
    throw new Error(`no visible option matched ${JSON.stringify(candidates)}`);
  } finally {
    await closeFlyout(page);
  }
}

const VISIBLE_OPTION = '[role="option"]:visible';
const LISTBOX_ID = /^[A-Za-z][\w:.-]*$/;

/**
 * Another listbox can be visible at the same time - Greenhouse keeps the phone
 * field's country picker rendered - so a page-wide query read "Afghanistan+93"
 * as the options of every dropdown on Chime's and Navan's forms. React-select
 * names its own menu through aria-controls while it is open, so options are
 * read from that listbox whenever the input says which one it is.
 */
async function optionSelectorFor(page: AnyPage, locator: AnyLocator): Promise<string> {
  for (let waited = 0; waited <= 1000; waited += 250) {
    const controls = (await attributeOf(locator, "aria-controls")) ?? (await attributeOf(locator, "aria-owns"));
    if (controls && LISTBOX_ID.test(controls)) return `[id="${controls}"] ${VISIBLE_OPTION}`;
    if (waited < 1000) await page.waitForTimeout(250);
  }
  return VISIBLE_OPTION;
}

async function attributeOf(locator: AnyLocator, name: string): Promise<string | null> {
  if (typeof locator.getAttribute !== "function") return null;
  try {
    return await locator.getAttribute(name);
  } catch {
    return null;
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

async function waitForVisibleOptions(page: AnyPage, timeoutMs: number, selector = '[role="option"]:visible'): Promise<string[]> {
  const options = page.locator(selector);
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if ((await options.count()) > 0) return await options.allInnerTexts();
    if (Date.now() >= deadline) return [];
    await page.waitForTimeout(250);
  }
}

export async function fillNativeSelect(locator: AnyLocator, candidates: readonly string[]): Promise<void> {
  const optionTexts = await locator.locator("option").allInnerTexts();
  const index = pickOptionIndex(optionTexts, candidates);
  if (index < 0) {
    throw new Error(`no option matched ${JSON.stringify(candidates)}`);
  }
  await locator.selectOption({ label: optionTexts[index]!.trim() });
}
