import { logger } from "../../util/logger.js";
import { numberInputValue } from "../../drafting/valueShape.js";
import { isAffirmativeAnswer } from "../form/answerVocabulary.js";
import { normalizeLabel, type FieldDescriptor } from "../form/fieldModel.js";
import { answerValueForField } from "../form/matching.js";
import { pickOptionIndex } from "../form/optionMatching.js";
import { optionSearchCandidates } from "../form/optionSearch.js";
import { isGroupedOption, type FillPlan } from "../formFields.js";
import { datePickerParts } from "../workdayDates.js";
import { fillWorkdayPrompt, isWorkdayPrompt } from "../workday/prompt.js";
import { isWorkdayUrl } from "../workdayFlow.js";
import { COLLECT_FIELDS } from "./collectFields.js";
import { fillCombobox, fillLeverLocationControl, fillNativeSelect } from "./dropdowns.js";
import type { AnyLocator, AnyPage } from "./playwright.js";

export type ChoiceSelection = { button: AnyLocator; label: string; choice: string };

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
  employer?: string,
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
    let locator = page.locator(`[data-autoapply-idx="${match.field.selectorIndex}"]`).first();
    // A validation re-render can replace the marked nodes. Re-marking rebuilds
    // the same indexes from the same form, so the repair still addresses the
    // field the board named rather than failing on a stale handle.
    if ((await locator.count()) === 0) {
      await page.evaluate(COLLECT_FIELDS).catch(() => undefined);
      locator = page.locator(`[data-autoapply-idx="${match.field.selectorIndex}"]`).first();
      if ((await locator.count()) === 0) {
        logger.warn("could not find the field the board reported empty", { label: match.field.label });
        continue;
      }
    }
    const value = answerValueForField(match.field, match.answer);
    const candidates = optionSearchCandidates(match.field, match.answer, employer);
    try {
      const typeable =
        match.field.role !== "combobox" &&
        // A number input is filled through fillControl, which reduces the
        // answer to the number it states rather than typing words into it.
        ["text", "email", "tel", "url", "textarea"].includes(match.field.type);
      if (typeable) {
        await locator.click();
        await locator.fill("");
        await page.keyboard.type(value, { delay: 25 });
        await page.keyboard.press("Tab");
      } else {
        await fillControl(page, locator, match.field, value, candidates, undefined, { boardReportedEmpty: true });
      }
      repaired.push(match.field.label);
    } catch (error) {
      if (error instanceof StrayValueError) throw error;
      logger.warn("could not repair a field the board reported empty", {
        label: match.field.label,
        error: String(error),
      });
    }
  }
  return repaired;
}

/**
 * A fill that failed and left the field stating something nobody approved.
 * Unlike a field that stayed blank, it stops the run even when the question is
 * optional, because submitting would send the stray value as the answer.
 */
export class StrayValueError extends Error {
  override name = "StrayValueError";
}

export async function fillControl(
  page: AnyPage,
  locator: AnyLocator,
  field: FieldDescriptor,
  value: string,
  candidates: readonly string[] = [value],
  choiceLog?: ChoiceSelection[],
  options: { boardReportedEmpty?: boolean } = {},
): Promise<void> {
  // Checked before the generic branches: Workday renders dropdowns as a widget
  // beside a hidden text input, and the collector only sees that input, so
  // every one of them would otherwise be filled invisibly and reported filled.
  if (field.type !== "checkbox" && field.type !== "radio" && field.type !== "file" && isWorkdayUrl(page.url())) {
    // Workday has full dates, month/year employment dates and education years.
    // Fill only the stated precision, in separately focused native sections. A
    // start-date picker takes the stored availability, worked out to a day.
    if (field.type === "date") {
      const parts = datePickerParts(value, field.domId, field.label);
      if (!parts) throw new Error("Date answer is invalid or has the wrong precision for this control");
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
      await page.keyboard.press("Tab");
      await page.waitForTimeout(400);
      return;
    }
    const wrapper = locator.locator('xpath=ancestor::div[starts-with(@data-automation-id,"formField-")][1]');
    if ((await wrapper.count()) > 0 && (await isWorkdayPrompt(wrapper as never))) {
      const result = await fillWorkdayPrompt(page as never, wrapper as never, candidates);
      if (result.strayValue) throw new StrayValueError(result.detail);
      if (!result.filled) throw new Error(result.detail);
      return;
    }
  }
  if (field.domId === "location-input" && field.name === "location"
    && /^jobs(?:\.eu)?\.lever\.co$/i.test(new URL(page.url()).hostname)) {
    await fillLeverLocationControl(page, locator, candidates);
    return;
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
      if (options.boardReportedEmpty && (await isActive(button))) await resyncPaintedChoice(page, button);
      await clickUntilActive(page, button, field.label, ashbyChoice!);
      choiceLog?.push({ button, label: field.label, choice: ashbyChoice! });
      return;
    }
    if (field.optionLabel) {
      // Ticking an option box asserts that this particular option applies. A
      // lone box may only be ticked when the answer names it: Adobe asks which
      // capacities the candidate previously worked at Adobe in and renders each
      // as its own ungrouped checkbox, and an answer of "None of the above"
      // names none of them, so an unconditional tick reported employment that
      // never happened. A grouped option is already the plan's pick, made with
      // its siblings in view; re-checking it alone rejected bands such as
      // "6-10 years" for 7. A lone box already ticked by an earlier pass is
      // cleared - a resumed draft keeps whatever the last run left.
      if (isGroupedOption(field) || pickOptionIndex([field.optionLabel], candidates) >= 0) {
        await checkOption(locator);
      } else if (await locator.isChecked?.().catch(() => false)) {
        await locator.uncheck?.({ timeout: 4000 }).catch(() => undefined);
        await locator.uncheck?.({ timeout: 4000, force: true }).catch(() => undefined);
      }
      return;
    }
    // A lone consent box is styled like the option boxes, so a bare check()
    // waited out its 30 seconds on Citi's and Cboe's Workday consent boxes.
    if (affirmative) await checkOption(locator);
    return;
  }
  if (field.type === "file") return;
  // A number input rejects any text at all, so "5+ years" threw and the field
  // was reported unfillable. The years the answer states are what the box wants;
  // a postal code is not a quantity and must not be cut down to its first digit.
  if (field.type === "number") {
    const numeric = numberInputValue(value);
    if (numeric === null) throw new Error(`cannot type "${value}" into a number field`);
    await locator.fill(numeric);
    return;
  }
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
 * The board named this question as unanswered while its wanted option is
 * painted selected, so the paint and the board's own state disagree: after
 * Ashby's resume autofill re-rendered Replit's form, Yes stayed selected on
 * screen with no answer held, and a toggle that is never clicked while it looks
 * selected could not repair it. One real click settles the disagreement either
 * way - it selects the answer the board was not holding, or clears the one it
 * was, which clickUntilActive then selects again.
 */
async function resyncPaintedChoice(page: AnyPage, button: AnyLocator): Promise<void> {
  await button.click({ timeout: 4000 });
  for (let waited = 0; waited < 2000; waited += 200) {
    await page.waitForTimeout(200);
    if (!(await isActive(button))) return;
  }
}

/**
 * Ashby re-renders the form while it parses the uploaded resume, which can drop
 * a choice that was verified as active moments earlier. Re-assert every choice
 * once the rest of the form has settled, and report the ones that will not hold.
 */
export async function reassertChoices(
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

/**
 * The group was already reduced to the one option that states the approved
 * answer, so this option is simply selected. Boards style radios by hiding the
 * real input behind its own label, which defeats a plain check(), so fall back
 * to forcing it and then to clicking the surrounding option row.
 */
export async function checkOption(locator: AnyLocator): Promise<void> {
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
  // Clicking the row toggles it, so a box something else already ticked stays as it is.
  if (await locator.isChecked?.().catch(() => false)) return;
  await locator.locator("xpath=ancestor::*[self::label or self::div][1]").first().click({ timeout: 4000 });
}

/**
 * Removes a phone number that an earlier run wrote into the extension field.
 *
 * Workday saves the candidate profile per tenant, so a value written once is
 * offered back on every later application to that employer. The matcher no
 * longer writes it, which does nothing for the ones already stored, and the
 * result is an undialable "+1 (604) 5550142 x604-555-0142" on the review page.
 * A real extension is a handful of digits, so anything phone-length is wrong.
 */
export async function clearPhoneExtension(page: AnyPage): Promise<void> {
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
