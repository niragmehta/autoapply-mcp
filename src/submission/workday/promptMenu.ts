import { WD_PLACEHOLDER, bestRanked, closerTo, expand, matches, sameValueSet } from "./promptMatch.js";
import type { Locator, Page, WorkdayPromptResult } from "./types.js";

/**
 * Workday's dropdowns are not inputs, so a plain fill writes nowhere.
 *
 * The markup is a `multiSelectContainer` (or a `button[aria-haspopup=listbox]`)
 * with a hidden text input beside it. The field collector only ever sees that
 * input: filling it changes nothing the form reads, the run reports the field
 * as filled, and Workday then refuses to save the page because the field is
 * still empty. Every one of these has to be opened and an option clicked.
 *
 * Two traps are specific to this widget and both are load-bearing here:
 *
 * - An already-chosen value renders as a `selectedItem` pill that also carries
 *   `role="option"`. It is a delete control, not a choice, so a page-wide
 *   option query offers up other fields' answers and "choosing" one erases
 *   them. Pills are excluded everywhere.
 * - Long lists are nested one level ("Linkedin Jobs" under "Job Board") and
 *   typing does not search into the categories, so a leaf is only reachable by
 *   opening its parent. The menu has no back control that is safe to click -
 *   the only back-looking button on the page is `backToJobPosting`, which
 *   leaves the application - so each category is tried from a freshly reopened
 *   menu instead.
 */
export const WD_PILL = '[data-automation-id="selectedItem"]';
export const WD_MENU_ITEM = `[role="option"]:visible:not(${WD_PILL})`;
/**
 * A Workday prompt popup. Positioned portals carry this attribute, and each
 * open prompt contributes one, so it is how one widget's options are told
 * apart from another's.
 */
const WD_POPUP = "[data-popper-placement]:visible";
/** Screens of a virtualized menu scrolled through before it is taken as read. */
const WD_MAX_SCROLL_PAGES = 30;
/** Time a virtualized menu is given to render the rows a scroll brought into view. */
const WD_SCROLL_SETTLE_MS = 500;
/** Extra reads of a menu after a click, while an opened category's own list may still be rendering. */
const WD_REVEAL_POLLS = 4;
const WD_REVEAL_POLL_MS = 500;

/**
 * The prompt widget this field belongs to, whether the collected control *is*
 * the widget or sits inside it.
 *
 * Which of the two a descriptor points at differs by tenant: NVIDIA's source
 * question collects the listbox button itself, while SailPoint's collects the
 * inner input and keeps `multiSelectContainer` on an ancestor. Searching only
 * downwards missed the second kind entirely, so the widget was filled as if it
 * were a text box and the answer never landed - leaving "How Did You Hear
 * About Us?" required-and-empty with a correct answer sitting in the packet.
 */
export function promptContainer(field: Locator): Locator {
  return field.locator(
    'xpath=ancestor-or-self::*[@data-automation-id="multiSelectContainer"]'
      + ' | .//*[@data-automation-id="multiSelectContainer"]'
      + ' | ancestor-or-self::button[@aria-haspopup="listbox"]'
      + ' | .//button[@aria-haspopup="listbox"]',
  );
}

/** A picker nests its options one level; a plain dropdown is flat. */
export async function isPicker(field: Locator): Promise<boolean> {
  return (await field.locator(
    'xpath=ancestor-or-self::*[@data-automation-id="multiSelectContainer"]'
      + ' | .//*[@data-automation-id="multiSelectContainer"]',
  ).count()) > 0;
}

export async function closeMenu(page: Page): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if ((await page.locator(WD_MENU_ITEM).count().catch(() => 0)) === 0) return;
    await page.keyboard.press("Escape").catch(() => undefined);
    await page.waitForTimeout(300);
    if ((await page.locator(WD_MENU_ITEM).count().catch(() => 0)) === 0) return;
    // Escape only reaches a popup that still holds focus, and a prompt whose
    // selection failed loses it. Workday marks these popups "close on outside
    // click", so a click on inert page furniture is what actually dismisses
    // one - and it matters: a popup left open lies over the fields below it,
    // so the next control clicked is the popup, not the radio or button that
    // was aimed at. SailPoint's whole step stalled on exactly that.
    const inert = page.locator('[data-automation-id="jobApplyHeader"], h2').first();
    if ((await inert.count().catch(() => 0)) > 0) {
      await inert.click({ timeout: 3_000, force: true }).catch(() => undefined);
    }
    await page.waitForTimeout(300);
  }
}

export async function openMenu(page: Page, field: Locator): Promise<boolean> {
  // A click that lands while a previously open menu is still closing is
  // swallowed, which reads as "this widget offers nothing" and hides the real
  // reason a required field stayed blank. One retry settles it.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await promptContainer(field)
      .first()
      .click({ timeout: 10_000 })
      .catch(() => undefined);
    await page.waitForTimeout(1_200);
    if ((await page.locator(WD_MENU_ITEM).count()) > 0) return true;
  }
  return false;
}

/**
 * The values already chosen.
 *
 * A picker shows them as pills; a plain dropdown has none and shows the choice
 * as the button's own text, so both have to be read or a successful selection
 * on a dropdown is misreported as a failure.
 */
export async function chosenValues(field: Locator): Promise<string[]> {
  const clean = (text: string): string => text.replace(/\s+/g, " ").trim();
  const pills = field.locator(WD_PILL);
  if ((await pills.count()) > 0) {
    return (await pills.allInnerTexts()).map(clean).filter(Boolean);
  }
  // A single-select prompt shows its choice as plain text in
  // `promptSelectionLabel` and never creates a pill. Reading only pills made a
  // successful click look like nothing had been selected, so the filler
  // concluded the option was a category, descended into a list that was not
  // there, and finally undid the correct answer - SailPoint's "How Did You
  // Hear About Us?" failed this way with the right value one click in.
  const selection = field.locator('[data-automation-id="promptSelectionLabel"]');
  if ((await selection.count()) > 0) {
    const chosen = (await selection.allInnerTexts())
      .map(clean)
      .filter((text) => text.length > 0 && !WD_PLACEHOLDER.test(text));
    if (chosen.length > 0) return chosen;
  }
  const button = field.locator('button[aria-haspopup="listbox"]');
  if ((await button.count()) > 0) {
    return (await button.allInnerTexts()).map(clean).filter((text) => !WD_PLACEHOLDER.test(text));
  }
  return [];
}

/** Just what `insidePopup` reads from the element; the file has no DOM library. */
type SearchBoxElement = {
  getAttribute: (name: string) => string | null;
  closest: (selector: string) => unknown;
};

/**
 * Whether a page-level search box belongs to a prompt rather than to the page.
 *
 * Workday gives a prompt's own box the `searchBox` automation id - Snap's sits
 * inline in the field - and renders others into the open popup.
 */
export async function insidePopup(box: Locator): Promise<boolean> {
  if (!box.evaluate) return false;
  // A real function rather than source text: Playwright hands the element only
  // to a function, and returns a string's value uncalled.
  const owned = await box
    .evaluate(
      (el: SearchBoxElement) =>
        el.getAttribute("data-automation-id") === "searchBox" || el.closest("[data-popper-placement]") !== null,
    )
    .catch(() => false);
  return owned === true;
}

/** Just what `searchBoxHome` reads from the field's own element. */
type FieldElement = { contains: (node: unknown) => boolean };

/**
 * Where a page-level search box sits relative to the prompt being filled:
 * inside the field itself, inside some other form field, or in neither - a
 * popup rendered at the end of the document, or the page's own search.
 */
export async function searchBoxHome(box: Locator, field: Locator): Promise<"own" | "other" | "free"> {
  if (!box.evaluate) return "free";
  const first = field.first();
  if (typeof first.elementHandle !== "function") return "free";
  const handle = await first.elementHandle().catch(() => null);
  if (!handle) return "free";
  try {
    const home = await box.evaluate(
      (el: SearchBoxElement, owner: unknown) =>
        (owner as FieldElement).contains(el)
          ? "own"
          : el.closest('[data-automation-id^="formField-"]') === null
            ? "free"
            : "other",
      handle,
    );
    return home === "own" || home === "other" ? home : "free";
  } catch {
    return "free";
  } finally {
    await handle.dispose().catch(() => undefined);
  }
}

/** Describes the page's visible inputs so a failed search explains itself. */
export async function describeInputs(page: Page): Promise<string> {
  const script = `(() => {
    const seen = [];
    for (const el of Array.from(document.querySelectorAll("input"))) {
      const box = el.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      seen.push([el.getAttribute("type") || "-", el.getAttribute("placeholder") || "-", el.getAttribute("data-automation-id") || "-"].join("/"));
    }
    return seen.slice(0, 12).join(" | ");
  })()`;
  return (await page.evaluate(script).catch(() => "")) as string;
}

/**
 * The popup the field just opened.
 *
 * Workday renders a prompt's options in a portal at the end of the document,
 * not inside the field, so a page-wide option query returns the options of
 * every open popup at once. Indexing into that combined list then clicks a row
 * belonging to a different widget: the click resolves, the widget reports
 * nothing selected, and the answer looks unoffered. Adobe made this visible by
 * offering "Canada (+1)" - the phone-code prompt's value - among the answers to
 * "How Did You Hear About Us?". The popup opened last is the topmost one, which
 * is the one the field being filled just opened.
 */
export async function menuScope(page: Page): Promise<Locator> {
  const popups = page.locator(WD_POPUP);
  const count = await popups.count().catch(() => 0);
  return count > 0 ? popups.nth(count - 1) : page.locator("body");
}

/** The option labels the open menu is showing, cleaned for comparison. */
export async function menuItems(page: Page): Promise<string[]> {
  const scope = await menuScope(page);
  return (await scope.locator(WD_MENU_ITEM).allInnerTexts().catch(() => [] as string[]))
    .map((text) => text.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

/**
 * A page script that scrolls the open menu's list a screen down, or back to
 * its top, and reports whether it moved.
 *
 * Workday virtualizes long menus: only the rows in view exist in the page, so
 * reading the menu sees one screenful and nothing below it. Moving the list's
 * own scroll container is what makes it render the next rows.
 */
function scrollMenuScript(toTop: boolean): string {
  return `(() => {
    const toTop = ${toTop};
    const popups = [...document.querySelectorAll("[data-popper-placement]")].filter((node) => node.getClientRects().length > 0);
    const popup = popups[popups.length - 1];
    const option = popup && popup.querySelector('[role="option"]');
    for (let node = option && option.parentElement; node && popup.contains(node); node = node.parentElement) {
      const overflow = getComputedStyle(node).overflowY;
      if ((overflow === "auto" || overflow === "scroll") && node.scrollHeight > node.clientHeight + 1) {
        const before = node.scrollTop;
        node.scrollTop = toTop ? 0 : before + Math.max(node.clientHeight * 0.8, 40);
        return node.scrollTop !== before;
      }
    }
    return false;
  })()`;
}

async function scrollMenu(page: Page, toTop: boolean): Promise<boolean> {
  const moved = (await page.evaluate(scrollMenuScript(toTop)).catch(() => false)) === true;
  if (moved) await page.waitForTimeout(WD_SCROLL_SETTLE_MS);
  return moved;
}

/**
 * Every entry of the open menu, including rows a virtualized list has not
 * rendered. Salesforce's "External Career Site Sources" showed eleven sources,
 * alphabetically, ending at "Indeed", and every approved answer below them was
 * reported as not offered.
 */
async function allMenuItems(page: Page): Promise<string[]> {
  let seen = await menuItems(page);
  for (let screen = 0; screen < WD_MAX_SCROLL_PAGES; screen += 1) {
    if (!(await scrollMenu(page, false))) break;
    const fresh = (await menuItems(page)).filter((item) => !seen.includes(item));
    if (fresh.length === 0) break;
    seen = [...seen, ...fresh];
  }
  await scrollMenu(page, true);
  return seen;
}

/**
 * An open category's entries. The rows in view are enough when one of them is
 * the approved wording itself; otherwise the list is read to its end, because
 * a closer answer than any in view may be waiting below.
 */
export async function categoryEntries(
  page: Page,
  rendered: readonly string[],
  exclude: readonly string[],
  candidates: readonly string[],
): Promise<string[]> {
  if (bestRanked(rendered, candidates)?.rank === 0) return [...rendered];
  const whole = (await allMenuItems(page)).filter((item) => !exclude.includes(item));
  return [...rendered, ...whole.filter((item) => !rendered.includes(item))];
}

/** An opened category's entries, and the level-above entries still listed beside them. */
type Revealed = { entries: string[]; exclude: string[] };

/**
 * What clicking a menu entry revealed, when the entry was a category rather
 * than a value. Undefined when the click chose a value: the menu closed, or it
 * still lists what it listed before.
 *
 * A category normally shows names the level above did not. Palo Alto Networks
 * files its only "Career Site" under a category of the same name, so opening it
 * adds no new name - the list just shrinks to the entry that was clicked.
 * Judged by new names alone, that read as a value that would not take, and a
 * required question was left blank. A multi-select that drops a chosen value
 * from its list shrinks too, but loses the clicked entry instead of keeping it.
 *
 * An opened category's list can take a moment to render, so a list that has
 * not changed yet is read again before it is believed.
 */
export async function revealedByClick(page: Page, before: readonly string[], clicked: string): Promise<Revealed | undefined> {
  for (let poll = 0; ; poll += 1) {
    const now = await menuItems(page);
    const fresh = now.filter((item) => !before.includes(item));
    if (fresh.length > 0) return { entries: fresh, exclude: [...before] };
    if (now.length > 0 && !sameValueSet(now, before)) {
      return now.includes(clicked) ? { entries: now, exclude: [] } : undefined;
    }
    const open = now.length > 0 || (await page.locator(WD_POPUP).count().catch(() => 0)) > 0;
    if (!open || poll >= WD_REVEAL_POLLS) return undefined;
    await page.waitForTimeout(WD_REVEAL_POLL_MS);
  }
}

/** Clicks the entry whose text is exactly this, for re-opening or restoring a known entry. */
export async function clickExact(page: Page, text: string): Promise<boolean> {
  const scope = await menuScope(page);
  const items = scope.locator(WD_MENU_ITEM);
  const texts = (await items.allInnerTexts().catch(() => [] as string[])).map((item) =>
    item.replace(/\s+/g, " ").trim(),
  );
  const index = texts.indexOf(text);
  if (index < 0) return false;
  try {
    await items.nth(index).click({ timeout: 10_000 });
  } catch {
    return false;
  }
  await page.waitForTimeout(1_000);
  return true;
}

/** Clicks an entry a virtualized menu may not be rendering, scrolling down from the top until it is. */
export async function clickRevealed(page: Page, text: string): Promise<boolean> {
  if (await clickExact(page, text)) return true;
  await scrollMenu(page, true);
  for (let screen = 0; screen < WD_MAX_SCROLL_PAGES; screen += 1) {
    if (await clickExact(page, text)) return true;
    if (!(await scrollMenu(page, false))) break;
  }
  return false;
}

/**
 * Clicks the first option matching any approved answer.
 *
 * Only values the caller already supplied are ever clicked, so descending into
 * a submenu can never answer a question with something that was not approved.
 */
export async function clickAnyCandidate(page: Page, candidates: readonly string[]): Promise<boolean> {
  for (const candidate of candidates.flatMap(expand)) {
    if (await clickMatch(page, candidate)) return true;
  }
  return false;
}

export async function clickMatch(page: Page, candidate: string): Promise<boolean> {
  const scope = await menuScope(page);
  const items = scope.locator(WD_MENU_ITEM);
  const texts = await items.allInnerTexts().catch(() => [] as string[]);
  const hits = texts
    .map((text, index) => ({ text, index }))
    .filter((entry) => matches(entry.text, candidate));
  if (hits.length === 0) return false;
  hits.sort((a, b) => closerTo(candidate, a.text, b.text));
  await items.nth(hits[0]!.index).click({ timeout: 10_000 });
  await page.waitForTimeout(1_000);
  return true;
}

/**
 * Removes anything this pass added, so a prompt that could not be answered is
 * left exactly as it was found.
 *
 * The undo used to be one unverified click on the pill, made while the menu was
 * still open and overlaying it. When it missed, Adobe's application kept
 * "Agricultural/Biological Engineering and Bioengineering" in Field of Study —
 * a major the candidate never studied, on a field the step does not require, so
 * nothing stopped it being submitted. A stray value here is a fabricated claim,
 * which is worse than an empty field.
 */
export async function clearAddedValues(
  page: Page,
  field: Locator,
  before: readonly string[],
): Promise<boolean> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const current = await chosenValues(field);
    if (current.length <= before.length) return true;
    // The pill only becomes clickable once the popup stops covering it.
    await closeMenu(page);
    const pills = field.locator(WD_PILL);
    // A single-select shows its value as text, with no pill to remove. One that
    // began blank is put back by choosing its "Select One" row: Disney's
    // "Are you Hispanic or Latino?" otherwise kept a "No" a search committed.
    if ((await pills.count()) === 0) {
      return before.length === 0 && (await clearToPlaceholder(page, field)).filled;
    }
    const pill = pills.nth(Math.max((await pills.count()) - 1, 0));
    const remove = pill.locator('button, [role="button"], [data-automation-id*="delete" i], svg').first();
    const target = (await remove.count()) > 0 ? remove : pill;
    await target.click({ timeout: 5_000 }).catch(() => undefined);
    await page.waitForTimeout(500);
  }
  return (await chosenValues(field)).length <= before.length;
}

/**
 * An answer naming the placeholder itself, which asks for the field to be blank.
 * No matcher may choose "Select One" as a value, so without this a stray value
 * Workday kept in a saved draft could never be taken back: Disney's draft held
 * a Suffix of "II" from an earlier mis-fill, a suffix nobody has.
 */
export const PLACEHOLDER_CHOICE = /^\s*select one\s*$/i;

/**
 * Empties a prompt and confirms it reads back blank. A single-select is reset by
 * choosing its "Select One" row; a picker by removing its pills. A value that
 * survives is reported as stray, because the field would then state something
 * nobody answered.
 */
export async function clearToPlaceholder(page: Page, field: Locator): Promise<WorkdayPromptResult> {
  const held = await chosenValues(field);
  if (held.length === 0) return { filled: true, detail: "already blank" };
  if ((await field.locator(WD_PILL).count()) > 0) {
    await clearAddedValues(page, field, []);
  } else {
    await closeMenu(page);
    if (await openMenu(page, field)) {
      const placeholder = (await menuItems(page)).find((row) => PLACEHOLDER_CHOICE.test(row));
      if (placeholder) await clickExact(page, placeholder);
    }
    await closeMenu(page);
  }
  const left = await chosenValues(field);
  if (left.length === 0) return { filled: true, detail: `cleared ${JSON.stringify(held)} back to Select One` };
  return {
    filled: false,
    detail: `left ${JSON.stringify(left)} selected and could not clear it; the field now states something that was never answered`,
    strayValue: true,
  };
}

/**
 * Whether the widget itself now shows the value, read from its own text.
 *
 * Every tenant marks a chosen value differently - a `selectedItem` pill, a
 * `promptSelectionLabel`, the button's own caption - and a selector written
 * for one reads as "nothing selected" on the next. SailPoint's source question
 * was clicked correctly on every pass and then undone, because the pill it
 * produces is not the pill this file knew about. Comparing the widget's text
 * before and after the click needs no per-tenant knowledge at all.
 *
 * The menu must be closed first: an open popup rendered inside the widget
 * contains every option, the wanted one included, and would confirm a
 * selection that never happened.
 */
export async function widgetText(field: Locator): Promise<string> {
  const texts = await field.allInnerTexts().catch(() => [] as string[]);
  return texts.join(" ").replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * What the widget says about itself, for the trace and for confirming a
 * selection.
 *
 * A Workday prompt announces its state to screen readers - "1 item selected" -
 * and marks a chosen row `data-automation-checked="Checked"`. Both are the
 * widget's own account of what happened, which is worth more than inferring
 * success from a pill selector that differs between tenants. The visible text
 * is useless here: a required prompt carries its validation error inside the
 * same wrapper, so the wrapper reads "...is required and must have a value"
 * whether or not the click landed.
 */
export async function promptState(page: Page, field: Locator): Promise<string> {
  const instruction = await field
    .locator('[data-automation-id="promptAriaInstruction"]')
    .first()
    .allInnerTexts()
    .catch(() => [] as string[]);
  const checked = await page
    .locator('[data-automation-id="promptLeafNode"][data-automation-checked="Checked"]')
    .count()
    .catch(() => 0);
  return `${instruction.join(" ").replace(/\s+/g, " ").trim() || "-"}; checked=${checked}`;
}

/**
 * The text of the option the widget currently has under the cursor.
 *
 * A combobox tracks its own cursor in `aria-activedescendant` rather than by
 * moving focus, so the active row cannot be read from `document.activeElement`
 * directly.
 */
async function activeOptionText(page: Page): Promise<string> {
  // Passed as source text because this file is compiled without the DOM
  // library - it runs in Node and only this fragment executes in the browser.
  const text = await page
    .evaluate(
      `(() => {
        const focused = document.activeElement;
        const id = focused && focused.getAttribute("aria-activedescendant");
        const node =
          (id && document.getElementById(id)) ||
          document.querySelector('[role="option"][aria-selected="true"], [data-automation-id="promptLeafNode"][aria-selected="true"]');
        return node ? node.innerText || node.textContent || "" : "";
      })()`,
    )
    .catch(() => "");
  return String(text ?? "").replace(/\s+/g, " ").trim();
}

/**
 * Chooses an option with the keyboard.
 *
 * Clicking a Workday prompt row can land on padding that takes no events, and
 * the failure is silent: the click resolves, nothing is selected, and the
 * answer looks unoffered. Arrowing to the row and pressing Enter goes through
 * the combobox's own key handling. Enter is only pressed once the cursor's row
 * reads back as the answer, but the read-back falls back to any row marked
 * selected when the widget does not say where its cursor is, so the caller
 * still confirms what was committed.
 */
export async function selectByKeyboard(page: Page, field: Locator, candidate: string): Promise<boolean> {
  const input = field
    .locator('input[data-uxi-widget-type="selectinput"], input[type="text"], input[role="combobox"]')
    .first();
  if ((await input.count().catch(() => 0)) === 0) return false;
  await input.click({ timeout: 5_000 }).catch(() => undefined);
  await page.waitForTimeout(300);
  const seen = new Set<string>();
  for (let step = 0; step < 20; step += 1) {
    await page.keyboard.press("ArrowDown").catch(() => undefined);
    await page.waitForTimeout(120);
    const active = await activeOptionText(page);
    if (!active || seen.has(active)) break;
    seen.add(active);
    if (matches(active, candidate)) {
      await page.keyboard.press("Enter").catch(() => undefined);
      await page.waitForTimeout(500);
      return true;
    }
  }
  return false;
}
