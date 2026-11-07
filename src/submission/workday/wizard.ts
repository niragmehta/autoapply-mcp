import { logger } from "../../util/logger.js";
import { bandHoldsFigure } from "../../drafting/numericBands.js";
import { numberInputValue } from "../../drafting/valueShape.js";
import { clickIfPresent, visibleText } from "./clicks.js";
import { WD_SYNONYMS, containsWord, negated, plainQuotes } from "./promptMatch.js";
import { menuScope } from "./promptMenu.js";
import type { Locator, Page } from "./types.js";

/**
 * Ceiling on wizard pages walked, so a tenant that keeps offering a next button
 * cannot loop forever. Workday's own flow is six pages; this leaves headroom
 * for tenants that add their own without letting a broken page spin.
 */
export const WORKDAY_MAX_STEPS = 12;
/** How many times a step may be reloaded after Workday's transient fault. */
export const WORKDAY_MAX_RETRIES = 3;

/**
 * Workday intermittently replaces a wizard step with "Something went wrong.
 * Please refresh the page and then try again." The page keeps its stepper and
 * its chrome but loses every control, so a run that hits this collected no
 * fields and reported the posting as dead - a confident, wrong diagnosis of a
 * fault the page itself says is transient. Doing what it asks recovers it.
 */
const WD_TRANSIENT_ERROR = /something went wrong/i;

export async function recoverWorkdayError(page: Page, attempts = 2): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (!WD_TRANSIENT_ERROR.test(await visibleText(page, "body"))) return true;
    await page.reload({ waitUntil: "domcontentloaded" }).catch(() => undefined);
    await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
    await page.waitForTimeout(2_500);
  }
  return !WD_TRANSIENT_ERROR.test(await visibleText(page, "body"));
}

/**
 * Describes an unfillable control's actual shape.
 *
 * When a required field offers no options the report is left holding nothing
 * but a label, and the only way forward is to guess at the employer's wording.
 * Unity's "Global Data Privacy Notice" read as optionless for four rebuild
 * cycles while "Yes", "I Acknowledge" and "Yes, I Agree" were tried against it
 * in turn. Naming the widget - checkbox, radio group, listbox or text box -
 * turns that guessing into a fact, for this tenant and every later one.
 */
export async function describeControl(
  page: Page,
  selectorIndex: number,
  label?: string,
): Promise<string> {
  const needle = (label ?? "")
    .replace(/\s+/g, " ")
    .replace(/["\\]/g, "")
    .trim()
    .slice(0, 40);
  const script = `(() => {
    const byIndex = document.querySelector('[data-autoapply-idx="${selectorIndex}"]');
    const needle = ${JSON.stringify(needle.toLowerCase())};
    let host = byIndex ? byIndex.closest('[data-automation-id^="formField-"]') || byIndex : null;
    if (!host && needle) {
      for (const el of Array.from(document.querySelectorAll('[data-automation-id^="formField-"]'))) {
        if ((el.textContent || "").replace(/\\s+/g, " ").toLowerCase().includes(needle)) { host = el; break; }
      }
    }
    if (!host) return "control not found";
    const kinds = new Set();
    const ids = new Set();
    const wrap = host.getAttribute("data-automation-id");
    if (wrap) ids.add(wrap);
    for (const el of Array.from(host.querySelectorAll("input, select, textarea, button, [role]"))) {
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      const role = el.getAttribute("role");
      const tag = el.tagName.toLowerCase();
      kinds.add(tag === "input" ? "input[" + (el.getAttribute("type") || "text") + "]" : role ? tag + "[" + role + "]" : tag);
      const id = el.getAttribute("data-automation-id");
      if (id) ids.add(id);
    }
    return "controls: " + Array.from(kinds).join(",") + "; ids: " + Array.from(ids).slice(0, 10).join(",");
  })()`;
  return ((await page.evaluate(script).catch(() => "")) as string) || "control not described";
}

/** The slice of a DOM element the toggle reader touches; the build has no DOM lib. */
type ToggleElement = {
  tagName: string;
  textContent: string | null;
  getAttribute: (name: string) => string | null;
  matches: (selector: string) => boolean;
  closest: (selector: string) => ToggleElement | null;
  querySelector: (selector: string) => ToggleElement | null;
  querySelectorAll: (selector: string) => ArrayLike<ToggleElement>;
  control?: ToggleElement | null;
  labels?: ArrayLike<ToggleElement> | null;
  ownerDocument: { getElementById: (id: string) => ToggleElement | null };
};

const TOGGLE_CONTROL = [
  'input[type="checkbox" i]',
  'input[type="radio" i]',
  '[role="checkbox"]',
  '[role="radio"]',
  '[role="switch"]',
  '[role="menuitemcheckbox"]',
  '[role="menuitemradio"]',
].join(", ");

/**
 * The choices of a checkbox or radio group, read from the page without a click.
 *
 * Clicking a toggle is not looking at it - it answers the question. Adobe's
 * wizard proved it: opening "Have you ever worked at Adobe in the following
 * capacity:" to list its options ticked its first box, so the Review page
 * claimed employment as an "Employee" that never happened, and the same probe
 * ticked a Terms box nobody had approved. A group's labels are already in the
 * DOM. A lone toggle yields nothing, because its label is the question rather
 * than a choice. Null means the control is not a toggle; an element that
 * cannot be inspected yields nothing too, since not clicking is the safe side
 * of that doubt.
 */
async function readToggleLabels(field: Locator): Promise<string[] | null> {
  if (!field.evaluate) return [];
  const labels = await field
    .evaluate((el: ToggleElement, selector: string) => {
      const bound = el.tagName === "LABEL" ? el.control ?? null : null;
      if (!el.matches(selector) && !(bound && bound.matches(selector)) && !el.querySelector(selector)) return null;
      const clean = (value: string | null | undefined) => (value ?? "").replace(/\s+/g, " ").trim();
      const labelOf = (toggle: ToggleElement): string => {
        const aria = clean(toggle.getAttribute("aria-label"));
        if (aria) return aria;
        const ids = clean(toggle.getAttribute("aria-labelledby")).split(" ").filter(Boolean);
        const named = ids.map((id) => clean(toggle.ownerDocument.getElementById(id)?.textContent)).join(" ").trim();
        if (named) return named;
        const own = Array.from(toggle.labels ?? []).map((label) => clean(label.textContent)).join(" ").trim();
        if (own) return own;
        return clean(toggle.closest('[role="row"], [role="cell"], [role="gridcell"], tr, li')?.textContent);
      };
      const group =
        el.closest('[data-automation-id^="formField-"], fieldset, [role="radiogroup"], [role="group"], [role="grid"]') ?? el;
      const toggles = Array.from(group.querySelectorAll(selector));
      if (toggles.length < 2) return [];
      return [...new Set(toggles.map(labelOf).filter((text) => text.length > 0 && text.length < 160))].slice(0, 25);
    }, TOGGLE_CONTROL)
    .catch(() => [] as string[]);
  return labels === null ? null : Array.isArray(labels) ? (labels as string[]) : [];
}

/**
 * Reads the choices a Workday dropdown offers, by opening it.
 *
 * Workday renders a "select one" question as a button that builds its option
 * list only once clicked, so a required dropdown no stored answer matches
 * reports nothing but its label. Unity's Global Data Privacy Notice accepts
 * neither "Yes" nor "I Acknowledge", and without the real wording the only way
 * forward is guessing at a legal consent - which is exactly what must not
 * happen. The dropdown is closed again so the form is left as it was found.
 */
export async function readListboxOptions(
  page: Page,
  selectorIndex: number,
  label?: string,
): Promise<string[]> {
  let field = page.locator(`[data-autoapply-idx="${selectorIndex}"]`).first();
  // The index attribute is stamped on during collection, so a step that
  // re-rendered after a validation error no longer carries it. The label is
  // the only stable handle left.
  if ((await field.count().catch(() => 0)) === 0) {
    const needle = (label ?? "")
      .replace(/\s+/g, " ")
      .replace(/["\\]/g, "")
      .trim()
      .slice(0, 40);
    if (!needle) return [];
    const wrapper = page
      .locator(`[data-automation-id^="formField-"]:has-text("${needle}")`)
      .first();
    if ((await wrapper.count().catch(() => 0)) === 0) return [];
    field = wrapper.locator('select, button, [role="combobox"], [aria-haspopup="listbox"]').first();
    if ((await field.count().catch(() => 0)) === 0) return [];
  }
  const native = field.locator("xpath=self::select");
  if ((await native.count().catch(() => 0)) > 0) {
    const texts = await native.locator("option").allInnerTexts().catch(() => [] as string[]);
    return texts.map((t) => t.replace(/\s+/g, " ").trim()).filter(Boolean).slice(0, 25);
  }
  const toggles = await readToggleLabels(field);
  if (toggles !== null) return toggles;
  await field.click({ timeout: 8000 }).catch(() => undefined);
  await page.waitForTimeout(1500);
  // Scoped to the popup this click opened and de-duplicated: the selector
  // matches a Workday row three times over, and an unscoped read mixes in the
  // options of every other open prompt, which is how "Canada (+1)" came to be
  // reported as an answer to "How Did You Hear About Us?".
  const scope = await menuScope(page);
  const options = await scope
    .locator('[role="option"], [data-automation-id="promptOption"], [data-automation-id="promptLeafNode"], ul[role="listbox"] li')
    .allInnerTexts()
    .catch(() => [] as string[]);
  await page.keyboard.press("Escape").catch(() => undefined);
  return [
    ...new Set(
      options
        .map((text) => text.replace(/\s+/g, " ").trim())
        .filter((text) => text.length > 0 && text.length < 160),
    ),
  ].slice(0, 25);
}

/**
 * Advances the multi-step application wizard by one page.
 *
 * Workday splits an application across My Information, My Experience,
 * Application Questions, Voluntary Disclosures and Review. Each page must be
 * saved before the next one exists, so fields cannot all be collected up front.
 *
 * The advance control is named differently across Workday versions - a live
 * NVIDIA tenant labels it "Save and Continue" under `pageFooterNextButton` and
 * has no `bottom-navigation-next-button` at all - so each known id is tried in
 * turn rather than assuming one.
 */
export async function advanceWorkdayStep(page: Page): Promise<boolean> {
  for (const selector of NEXT_BUTTONS) {
    const button = page.locator(selector).first();
    const shown = await button.waitFor({ state: "visible", timeout: 8000 }).then(
      () => true,
      () => false,
    );
    if (!shown) continue;
    // On Review this same footer button is Submit, and pressing it here sends
    // the application outside the guarded submit path and past the review
    // read-back. Nasdaq's Review page once reported no step name, the walk took
    // it for one more step, and the application went out unchecked.
    const label = ((button.innerText ? await button.innerText().catch(() => "") : "") || "").replace(/\s+/g, " ").trim();
    if (/\bsubmit\b/i.test(label)) {
      logger.warn("workday walk stopped at a submit button", { label });
      return false;
    }
    const advanced = await clickIfPresent(page, selector, 8000);
    if (!advanced) continue;
    await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => undefined);
    return true;
  }
  return false;
}

const NEXT_BUTTONS = [
  '[data-automation-id="pageFooterNextButton"]',
  '[data-automation-id="bottom-navigation-next-button"]',
] as const;

/** Reads the wizard's current step label, used to report progress honestly. */
export async function workdayStepName(page: Page): Promise<string> {
  const text = await visibleText(page, '[data-automation-id="progressBarActiveStep"]');
  return text.trim();
}

/**
 * What the Review page fails to say back.
 *
 * Workday resumes a saved draft, so a page can carry a value from an earlier
 * run that this run never supplied and cannot see: Adobe's Review page stated
 * the candidate had worked there as an "Employee" and had heard about the role
 * through "Findem", a sourcing vendor, while the fill log reported both fields
 * answered and zero failures. Both were caught by reading the screenshot by
 * eye. Reading the page back and checking it repeats what was actually
 * answered turns that into an automatic stop, because a wizard that reports
 * success is not evidence that the form states the truth.
 *
 * Only distinctive values are checked. A bare "Yes"/"No" appears all over the
 * page and proves nothing, and tenant vocabulary legitimately renames choices,
 * so a value also passes when every significant word of it is on the page. A
 * miss stops the run for a person to check. The employer's own name is on
 * every page, so its words never count towards that match: "Adobe.com" has to
 * be stated as such.
 */
export async function reviewOmissions(
  page: Page,
  answered: ReadonlyArray<{ label: string; value: string; alternatives?: readonly string[] }>,
  employer?: string,
): Promise<Array<{ label: string; value: string }>> {
  const body = await visibleText(page, "body").catch(() => "");
  const haystack = (typeof body === "string" ? body : "").replace(/\s+/g, " ").toLowerCase();
  const employerWords = new Set(significantWords(employer ?? ""));
  const missing: Array<{ label: string; value: string }> = [];
  for (const entry of answered) {
    const value = entry.value.replace(/\s+/g, " ").trim();
    if (value.length < 4) continue;
    if (/^(?:yes|no|true|false|n\/a|none)$/i.test(value)) continue;
    if (haystack.includes(value.toLowerCase())) continue;
    // A tenant may render its own wording for the same choice, so accept the
    // answer when every significant word of it - or the tenant's synonym for
    // it - is present. NVIDIA prints an approved "Mobile" as "Home Cellular".
    const words = significantWords(value).filter((word) => !employerWords.has(word));
    if (words.length > 0 && words.every((word) => namesWordOrSynonym(haystack, word))) continue;
    if (statesFigure(haystack, value)) continue;
    if (bandStatedAfter(haystack, entry.label, value)) continue;
    if (DECLINE_VALUE.test(value) && declineStatedAfter(haystack, entry.label)) continue;
    if (alternativeStatedAfter(haystack, entry.label, entry.alternatives ?? [])) continue;
    missing.push({ label: entry.label, value });
  }
  return missing;
}

/**
 * Whether the page states, directly after the question, one of the wordings
 * the fill was approved to choose for this answer. Sony's at-will notice was
 * answered "I acknowledge" and its Review page prints the option chosen, "Yes,
 * I understand", which shares no significant word with it. A bare yes or no
 * proves nothing, a refusal never stands for an approved wording, and only the
 * text right after this question's label counts, so another question's answer
 * cannot vouch for it.
 */
function alternativeStatedAfter(haystack: string, label: string, alternatives: readonly string[]): boolean {
  const needle = label.replace(/\s+/g, " ").trim().toLowerCase();
  if (needle.length < 8 || alternatives.length === 0) return false;
  const at = haystack.indexOf(needle);
  if (at === -1) return false;
  // The answer ends where the next question's sentence does.
  const answer = plainQuotes(haystack.slice(at + needle.length, at + needle.length + 160).split(/[.?!]/)[0] ?? "");
  return alternatives.some((alternative) => {
    const wording = plainQuotes(alternative).replace(/\s+/g, " ").trim().toLowerCase();
    if (wording.length < 4 || /^(?:yes|no|true|false|n\/a|none)$/.test(wording)) return false;
    return containsWord(answer, wording) && negated(answer) === negated(wording);
  });
}

/** An approved refusal to answer, in any of the wordings the profile uses. */
const DECLINE_VALUE =
  /^(?:i\s+)?(?:decline to (?:self[\s-]?identify|answer|state)|(?:do not|don't|don’t) wish to (?:answer|self[\s-]?identify)|wish not to (?:answer|self[\s-]?identify|disclose)|prefer not to (?:answer|say|disclose))\b/i;

/**
 * A refusal as a tenant prints it back. "No Response" is deliberately absent:
 * Workday shows it for a question left unanswered, which is not a decline.
 */
const DECLINE_STATED =
  /\b(?:wish not to|not wish to|(?:do not|don't|don’t) wish to|declines? to|declined to|prefer not to|rather not|not to disclose|not to self[\s-]?identify|not wish self[\s-]?identify|not declared|undeclared|not specified|unspecified|did not provide)\b/;

/**
 * Whether the page states, directly after the question, a band holding the
 * figure that was answered: CVS Health's Review prints "$220,000 - $240,000" for
 * an answer of "Around USD 222,480 base", so the figure never appears. Only the
 * text right after this question's label counts.
 */
function bandStatedAfter(haystack: string, label: string, value: string): boolean {
  const needle = label.replace(/\s+/g, " ").trim().toLowerCase();
  if (needle.length < 8) return false;
  const at = haystack.indexOf(needle);
  if (at === -1) return false;
  return bandHoldsFigure(haystack.slice(at + needle.length, at + needle.length + 60), value);
}

/**
 * Whether the page states a refusal directly after the question. Palo Alto
 * Networks prints an approved "Decline to self-identify" back as "Wish Not To
 * Answer (United States of America)": the right choice in the tenant's own
 * words, which shares no significant word with the approved value, so the
 * read-back stopped a correct application. Only the text right after this
 * question's label counts, so another question's refusal cannot vouch for it.
 */
function declineStatedAfter(haystack: string, label: string): boolean {
  const needle = label.replace(/\s+/g, " ").trim().toLowerCase();
  if (needle.length < 8) return false;
  const at = haystack.indexOf(needle);
  if (at === -1) return false;
  // The answer ends where the next question's sentence does.
  const answer = haystack.slice(at + needle.length, at + needle.length + 120).split(/[.?!:]/)[0] ?? "";
  return DECLINE_STATED.test(answer);
}

/**
 * A number field keeps only the figure of a sentence answer: Cboe's "Salary
 * Expectations" took "Around USD 192,500 base (...)" as 192500, which is what
 * its Review page says back. The figure must stand alone, plain or grouped, and
 * have at least four digits, since a short number appears all over a page.
 */
function statesFigure(haystack: string, value: string): boolean {
  const figure = numberInputValue(value);
  if (!figure || figure.replace(/\D/g, "").length < 4) return false;
  const forms = new Set([figure, Number(figure).toLocaleString("en-US")]);
  return [...forms].some((form) => {
    const escaped = form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return new RegExp(`(?<![\\d.,])${escaped}(?!\\d|[.,]\\d)`).test(haystack);
  });
}

function significantWords(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 3);
}

/** Whether the page names a word, or the tenant vocabulary {@link WD_SYNONYMS} gives for it. */
function namesWordOrSynonym(haystack: string, word: string): boolean {
  if (haystack.includes(word)) return true;
  const group = WD_SYNONYMS.find((words) => words.includes(word));
  return group !== undefined && group.some((synonym) => synonym !== word && haystack.includes(synonym));
}

/**
 * The fields Workday's "Errors Found" banner names as required and empty.
 *
 * A question revealed by an earlier answer is not on the page when the step is
 * collected: Intel shows "11d) Please indicate your current immigration status"
 * only once 11c is answered, and Nasdaq's residence question appeared the same
 * way. The step then refused to advance and the run reported nothing but "would
 * not advance", which gives a person nothing to answer. The banner names each
 * field in a fixed sentence, so those names become the questions to answer.
 */
export function parseWorkdayRequiredErrors(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.replace(/\s+/g, " ").matchAll(/The field (.{3,400}?) is required and must have a value/g)) {
    const label = (match[1] ?? "").replace(/\*/g, "").replace(/\s*:\s*$/, "").replace(/\s+/g, " ").trim();
    if (label) found.add(label);
  }
  return [...found];
}

/** Reads {@link parseWorkdayRequiredErrors} off the live page. */
export async function workdayRequiredErrors(page: Page): Promise<string[]> {
  const body = await visibleText(page, "body").catch(() => "");
  return parseWorkdayRequiredErrors(typeof body === "string" ? body : "");
}

/**
 * The fields Workday's "Errors Found" banner rejects for their value rather
 * than for being empty. KLA's optional "Please provide your Facebook profile:"
 * ended up holding the LinkedIn URL; the banner said "Invalid Facebook URL" and
 * My Experience would not advance on any attempt.
 */
export function parseWorkdayInvalidFieldErrors(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.replace(/\s+/g, " ").matchAll(/\bError\s*[-–]\s*(.{3,200}?):?\s+Invalid\b/g)) {
    const label = (match[1] ?? "").replace(/\*/g, "").replace(/\s*:\s*$/, "").replace(/\s+/g, " ").trim();
    if (label && !/\bis required and must have a value\b/.test(label)) found.add(label);
  }
  return [...found];
}

/**
 * Empties the optional fields {@link parseWorkdayInvalidFieldErrors} names and
 * returns their labels. However a rejected value got there, an empty optional
 * field passes, so clearing it is always safe; a required one is left for the
 * required-field report.
 */
export async function clearInvalidOptionalFields(page: Page): Promise<string[]> {
  const body = await visibleText(page, "body").catch(() => "");
  const labels = parseWorkdayInvalidFieldErrors(typeof body === "string" ? body : "");
  if (labels.length === 0) return [];
  const script = `((wanted) => {
    const norm = (s) => String(s || "").replace(/\\*/g, "").replace(/\\s+/g, " ").replace(/\\s*:\\s*$/, "").trim().toLowerCase();
    const targets = new Set(wanted.map(norm));
    const hits = [];
    for (const label of Array.from(document.querySelectorAll("label"))) {
      if (!targets.has(norm(label.textContent))) continue;
      const id = label.getAttribute("for");
      const wrapper = label.closest('[data-automation-id^="formField"]');
      const input = (id && document.getElementById(id)) || (wrapper && wrapper.querySelector("input, textarea"));
      if (!input || !("value" in input) || !input.value) continue;
      if (input.getAttribute("aria-required") === "true" || input.required) continue;
      input.setAttribute("data-autoapply-invalid", "1");
      hits.push((label.textContent || "").trim());
    }
    return hits;
  })(${JSON.stringify(labels)})`;
  const marked = ((await page.evaluate(script).catch(() => [])) as string[] | null) ?? [];
  const fields = page.locator('[data-autoapply-invalid="1"]');
  const count = await fields.count().catch(() => 0);
  for (let index = 0; index < count; index += 1) await fields.nth(index).fill("").catch(() => undefined);
  return marked;
}

/**
 * Whether a wizard step that collected nothing should be reloaded and tried
 * again. Workday's transient fault can blank a step, and reloading recovers
 * it. The Review page is different: some tenants put no inputs on it at all -
 * Tempus's collects nothing - and the walk stops there anyway, so reloading it
 * three times only ran the stall guard out and failed a finished application
 * as "Review would not advance".
 */
export function retriesEmptyWorkdayStep(stepName: string, collected: number, retries: number, maxRetries: number): boolean {
  return collected === 0 && retries < maxRetries && !/\breview\b/i.test(stepName);
}
