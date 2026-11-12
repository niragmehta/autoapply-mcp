import { pickNumericBandIndex } from "../../drafting/numericBands.js";
import { isDeclineSearch } from "../form/answerVocabulary.js";
import { isDeclinePhrase } from "../form/optionMatching.js";
import {
  announcesNewSelection, bestRanked, expand, isRefusal, matches, sameOptions, sameValueSet, textGained, tookAnswer,
  type RankedOption,
} from "./promptMatch.js";
import {
  PLACEHOLDER_CHOICE, WD_MENU_ITEM, WD_PILL, categoryEntries, chosenValues, clearAddedValues, clearToPlaceholder,
  clickAnyCandidate, clickExact, clickMatch, clickRevealed, closeMenu, describeInputs, insidePopup, isPicker, menuItems,
  openMenu, promptContainer, promptState, revealedByClick, searchBoxHome, selectByKeyboard, widgetText,
} from "./promptMenu.js";
import type { Locator, Page, WorkdayPromptResult } from "./types.js";

const WD_MAX_CATEGORIES = 8;
/**
 * Rows of a flat menu read when looking for the band that holds a figure. CVS
 * Health lists base pay in fourteen $20,000 bands; reading only the first eight
 * left $222,480 in none of them.
 */
const WD_MAX_MENU_ROWS = 60;

/**
 * How long one prompt may spend hunting for a value. Each candidate costs a
 * menu open, a click pass, a keyboard pass and a typed search, so a long
 * candidate list can otherwise run for a quarter of an hour. Workday expires
 * the session while that happens and the whole application is lost, which is
 * a far worse outcome than one unanswered optional field.
 */
const WD_PROMPT_BUDGET_MS = 90_000;

/**
 * Consecutive failures to open the menu that mean the widget is not going to
 * open at all - it is disabled, or the page moved on - so further candidates
 * only burn the budget.
 */
const WD_MAX_OPEN_FAILURES = 3;

/** A list this short is read in full by the first look, with nothing left to search for. */
const WD_SHORT_LIST = 12;

/** True when this field is one of Workday's prompt widgets rather than a text input. */
export async function isWorkdayPrompt(field: Locator): Promise<boolean> {
  return (await promptContainer(field).count()) > 0;
}

/**
 * Types into a prompt's search box so long taxonomies can be reached.
 *
 * Adobe's "Field of Study" offers thousands of majors and renders only the
 * first handful, alphabetically: the visible options stopped at
 * "Agricultural/Biological Engineering", so "Computer Science" appeared to be
 * on offer nowhere and a required field was reported unfillable. Adobe's
 * tenant filters the list server-side as soon as anything is typed; Snap's
 * leaves it untouched until the search is submitted with Enter.
 */
async function searchMenu(page: Page, field: Locator, candidate: string): Promise<boolean> {
  // Workday's search box carries no type attribute and is rendered into the
  // popup rather than the field, so a field-scoped `input[type=text]` selector
  // finds nothing at all — but a scoped selector that is loose enough to catch
  // it also catches the widget's own hidden inputs, and typing into one of those
  // filters nothing. Every plausible box is therefore tried in turn.
  const SEARCH_BOX = 'input[placeholder="Search" i], input[role="combobox"], input:not([type]), input[type="text"]';
  const boxes: { box: Locator; where: string; ownsPrompt: boolean }[] = [];
  // The popup renders at the end of the document, and the board's own job search
  // sits at the top, so the menu's box is the last visible one. It is tried
  // first: typing into a widget's own hidden input filters nothing but does
  // leave the field dirty.
  const loose = page.locator('input[placeholder="Search" i]:visible');
  const looseCount = Math.min(await loose.count(), 4);
  for (let index = looseCount - 1; index >= 0; index -= 1) {
    const box = loose.nth(index);
    const home = await searchBoxHome(box, field);
    // Another prompt's inline box. Typing there opens that prompt's list, which
    // then reads as this one narrowing: Palo Alto Networks' school search was
    // "narrowed" to Field of Study's majors, and its source search to phone codes.
    if (home === "other") continue;
    boxes.push({ box, where: `page[${index}/${looseCount}]`, ownsPrompt: home === "own" || (await insidePopup(box)) });
  }
  const scoped = field.locator(SEARCH_BOX);
  const scopedCount = Math.min(await scoped.count(), 3);
  for (let index = 0; index < scopedCount; index += 1) {
    boxes.push({ box: scoped.nth(index), where: `field[${index}]`, ownsPrompt: true });
  }
  if (boxes.length === 0) {
    lastSearchDetail = "no search box";
    return false;
  }

  const menuTexts = async (): Promise<string[]> =>
    (await page.locator(WD_MENU_ITEM).allInnerTexts().catch(() => [] as string[]))
      .map((text) => text.replace(/\s+/g, " ").trim())
      .filter(Boolean);
  const before = await menuTexts();
  const chosenBefore = await chosenValues(field);
  const attempts: string[] = [];
  // A taxonomy names things its own way: Adobe's list of majors has no plain
  // "Computer Science" entry, so the full phrase returns "No Items." while its
  // first word reaches "Computer Science, General" and its neighbours. Only that
  // fallback word needs a minimum length (so a stray "of" is never searched);
  // the answer itself is typed whatever its length, since skills such as "C#"
  // or "Go" are named in two characters.
  const firstWord = candidate.split(/[\s,/]+/)[0] ?? "";
  const terms = [candidate.trim(), firstWord.length >= 3 ? firstWord : ""].filter(
    (term, index, all) => term.length > 0 && all.indexOf(term) === index,
  );
  for (const { box, where, ownsPrompt } of boxes) {
    for (const term of terms) {
      let typed = true;
      const shown = await menuTexts();
      // `fill` sets the value in one shot without emitting key events, and
      // Workday's filter is driven by keystrokes: a filled box left the list
      // untouched. Focusing the box and typing for real is what narrows it.
      await box.click({ timeout: 5_000 }).catch(() => {
        typed = false;
      });
      await box.fill("").catch(() => undefined);
      await page.keyboard.type(term, { delay: 60 }).catch(() => {
        typed = false;
      });
      await page.waitForTimeout(2_000);
      let narrowed = await menuTexts();
      let how = "typed";
      // Typing left the list exactly as it was, so this tenant searches only
      // when asked. Enter is pressed only in a box belonging to the prompt: in
      // the board's own job search it would navigate away from the application.
      if (typed && ownsPrompt && sameOptions(shown, narrowed)) {
        await page.keyboard.press("Enter").catch(() => undefined);
        await page.waitForTimeout(2_500);
        narrowed = await menuTexts();
        how = "entered";
      }
      // Some prompts select a lone result on Enter rather than listing it. The
      // caller decides whether that value is the answer; searching further
      // would only type into a popup that has closed. A single-select replaces
      // its value rather than adding one, so a changed value counts too: Enter
      // on a fruitless search committed the highlighted row on Adobe's
      // phone-code prompt, and a count comparison never saw it happen.
      const chosen = await chosenValues(field);
      if (chosen.length > chosenBefore.length || (chosen.length > 0 && !sameValueSet(chosen, chosenBefore))) {
        attempts.push(`${where} "${term}" ${how}: selected ${JSON.stringify(chosen)}`);
        lastSearchDetail = attempts.join("; ");
        return true;
      }
      const empty = narrowed.length === 0 || narrowed.every((text) => /^no items\.?$/i.test(text));
      attempts.push(
        `${where} "${term}" ${how} typed=${typed} ${before.length}->${narrowed.length}${empty ? " (empty)" : ""}`,
      );
      // A virtualised list renders a fixed number of rows, so the narrowed list
      // can be exactly as long as the page it replaced: compare the rows.
      if (!empty && !sameOptions(before, narrowed)) {
        lastSearchDetail = `${attempts.join("; ")}; narrowed to ${JSON.stringify(narrowed.slice(0, 6))}`;
        return true;
      }
    }
  }
  lastSearchDetail = `${attempts.join("; ")}; ${await describeInputs(page)}`;
  return false;
}

/** What the last search attempt did, so a mismatch explains itself. */
let lastSearchDetail = "not attempted";

/**
 * Puts a single-select back to the value it held when the pass began.
 *
 * `clearAddedValues` removes pills a picker gained, but a single-select has
 * none: a probe that lands on the wrong row replaces the value in place and
 * leaves the count unchanged. Adobe's phone-code prompt began the pass on the
 * correct "Canada (+1)", ended it on "Anguilla (+1)", and the pass reported
 * that it had kept the original. The original is chosen again the way any
 * answer is, and the result is read back rather than assumed.
 */
async function restoreSelection(page: Page, field: Locator, baseline: readonly string[]): Promise<boolean> {
  const current = await chosenValues(field);
  if (sameValueSet(current, baseline)) return true;
  // Only a lone value can be put back by choosing it again.
  const original = baseline.length === 1 && current.length <= 1 ? baseline[0] : undefined;
  if (original === undefined) return false;
  await closeMenu(page);
  if (await openMenu(page, field)) {
    if (!(await clickExact(page, original)) && (await searchMenu(page, field, original))) {
      if (!sameValueSet(await chosenValues(field), baseline)) await clickExact(page, original);
    }
  }
  await closeMenu(page);
  return sameValueSet(await chosenValues(field), baseline);
}

/**
 * Looks under the other top-level entries for a closer answer.
 *
 * Adobe nests every source one level down. The weak fallback "Job board"
 * matched the "Job Board" category, which lists only named boards, while the
 * employer's own site - "Adobe.com" - sat under "Adobe Source". Stopping at the
 * first category that matched by name left a required question blank. Each
 * entry is opened from a fresh menu, and one that turns out to be a value
 * rather than a category has just been chosen, so it is undone before going
 * on. The closest answer found anywhere wins: a weak "Other" seen first does
 * not beat the employer's own site found later.
 */
async function sweepSiblingCategories(
  page: Page,
  field: Locator,
  offered: readonly string[],
  opened: { category: string; best?: RankedOption },
  candidates: readonly string[],
  baseline: readonly string[],
): Promise<WorkdayPromptResult | undefined> {
  type Found = RankedOption & { category?: string };
  let best: Found | undefined = opened.best ? { ...opened.best, category: opened.category } : undefined;
  let stray: string | undefined;
  for (const entry of offered.filter((item) => item !== opened.category).slice(0, WD_MAX_CATEGORIES)) {
    if (best?.rank === 0) break;
    await closeMenu(page);
    if (!(await openMenu(page, field))) break;
    const shown = await menuItems(page);
    if (!(await clickExact(page, entry))) continue;
    const revealed = await revealedByClick(page, shown, entry);
    if (revealed) {
      const local = bestRanked(await categoryEntries(page, revealed.entries, revealed.exclude, candidates), candidates);
      if (local && (best === undefined || local.rank < best.rank)) best = { ...local, category: entry };
      continue;
    }
    // Not a category: opening it chose it.
    const leaf = bestRanked([entry], candidates);
    if (leaf && (best === undefined || leaf.rank < best.rank)) best = leaf;
    const undone = (await clearAddedValues(page, field, baseline)) && (await restoreSelection(page, field, baseline));
    if (undone) continue;
    // A stray that shows as a pill stays beside whatever is chosen next. A
    // single-select has no pills and replaces it with the next choice, so the
    // sweep can go on - even inside a picker's container, where Workday also
    // renders single-selects.
    if ((await field.locator(WD_PILL).count().catch(() => 0)) > 0) {
      return {
        filled: false,
        detail: `opening ${JSON.stringify(entry)} selected it and it could not be undone; the field now reads ${JSON.stringify(await chosenValues(field))}`,
        strayValue: true,
      };
    }
    stray = entry;
  }
  await closeMenu(page);
  const found = best;
  if (found !== undefined && (await openMenu(page, field))) {
    const top = await menuItems(page);
    const reached =
      found.category === undefined ||
      ((await clickExact(page, found.category)) && (await revealedByClick(page, top, found.category)) !== undefined);
    if (reached && (await clickRevealed(page, found.option))) {
      const after = await chosenValues(field);
      if (after.some((value) => matches(value, found.option)) || tookAnswer(after, baseline, [found.option])) {
        return {
          filled: true,
          detail: `selected ${after.join(", ")}${found.category ? ` under ${found.category}` : ""}`,
        };
      }
    }
    await closeMenu(page);
  }
  const now = await chosenValues(field);
  if (stray !== undefined && !sameValueSet(now, baseline)) {
    return {
      filled: false,
      detail: `opening ${JSON.stringify(stray)} selected it and it could not be undone; the field now reads ${JSON.stringify(now)}`,
      strayValue: true,
    };
  }
  return undefined;
}

/**
 * Chooses a value in a Workday prompt, reporting honestly when it cannot.
 *
 * The caller must be able to tell a real selection from a no-op, so success is
 * confirmed by reading the widget back - the values it shows, its own text, or
 * a selection count that grew - rather than by the click resolving.
 */
export async function fillWorkdayPrompt(
  page: Page,
  field: Locator,
  candidates: readonly string[],
): Promise<WorkdayPromptResult> {
  if (candidates.length > 0 && candidates.every((candidate) => PLACEHOLDER_CHOICE.test(candidate))) {
    return clearToPlaceholder(page, field);
  }
  const before = await chosenValues(field);
  const already = before.find((value) => candidates.some((candidate) => matches(value, candidate)));
  if (already) return { filled: true, detail: `already set to ${already}` };
  // A value is present that none of the candidates named. Workday resumes a
  // saved draft, so this is whatever an earlier run left behind - Adobe's
  // source prompt came back holding "Findem", a sourcing vendor the candidate
  // never used. It is only replaced once a candidate is confirmed to match
  // something the widget actually offers: the phone-code prompt is searched
  // with the phone number, which matches no country, and clearing on that
  // basis destroyed a correct "Canada (+1)" that this run could not restore.
  const stale = before;
  let baseline = before;
  const clearStale = async (): Promise<boolean> => {
    if (stale.length === 0) return true;
    // A single-select prompt shows its choice as plain text and has no pill to
    // remove, so there is nothing to clear and clearing always "fails" -
    // choosing a new value replaces the old one. Only a multi-select, which
    // accumulates pills, has to be emptied first.
    if ((await field.locator(WD_PILL).count()) === 0) return true;
    if (!(await clearAddedValues(page, field, []))) return false;
    baseline = await chosenValues(field);
    return true;
  };

  const trace: string[] = [];
  const deadline = Date.now() + WD_PROMPT_BUDGET_MS;
  let openFailures = 0;
  // Whether any approved answer was seen on offer. Keeping a value an earlier
  // run left is only honest when none was.
  let onOffer = false;

  // Read the menu once and test every candidate against everything on offer
  // before probing candidates one at a time. The per-candidate path costs a
  // keyboard walk, a typed search and a category sweep each, so an early weak
  // candidate can exhaust the whole budget before a later one that matches
  // outright is ever tried: Adobe's veteran prompt offers "I DO NOT WISH TO
  // SELF-IDENTIFY" and the run gave up two candidates short of it.
  if (await openMenu(page, field)) {
    const offered = await menuItems(page);
    // The closest answer on offer, not the first entry that answers anything:
    // "Job board" is a weaker restatement than the employer's own site. Each
    // answer's synonyms are tried here too, after its own wording: NVIDIA's
    // phone types are "Home" and "Home Cellular", and leaving "cellular" to the
    // slow per-candidate pass meant "Mobile" and "cell" spent the whole budget
    // on keyboard and search probes before it was ever compared.
    const hit = bestRanked(offered, candidates.flatMap(expand))?.option;
    if (hit) {
      onOffer = true;
      if (!(await clearStale())) {
        return {
          filled: false,
          detail: `left over from an earlier run: ${JSON.stringify(stale)}; ${JSON.stringify(hit)} is on offer but the old value would not clear`,
          strayValue: true,
        };
      }
      const stateBefore = await promptState(page, field);
      if (await clickExact(page, hit)) {
        // Adobe files every job board under a "Job Board" category. Clicking
        // the category can leave the tenant's previously stored leaf in place -
        // the Review page kept reporting the sourcing vendor "Findem" while the
        // widget itself read as empty - so a category must be drilled into and
        // a leaf chosen explicitly. Check for expansion before accepting the
        // click, because the category also reads back as the selected value.
        const revealed = await revealedByClick(page, offered, hit);
        if (revealed) {
          const children = await categoryEntries(page, revealed.entries, revealed.exclude, candidates);
          const local = bestRanked(children, candidates);
          if (local?.rank === 0 && (await clickRevealed(page, local.option))) {
            const after = await chosenValues(field);
            if (after.some((value) => matches(value, local.option)) || tookAnswer(after, baseline, [local.option])) {
              return { filled: true, detail: `selected ${after.join(", ")} under ${hit}` };
            }
          }
          // Nothing here is the approved wording itself, so a closer answer may
          // sit under another entry.
          const wider = await sweepSiblingCategories(page, field, offered, { category: hit, best: local }, candidates, baseline);
          if (wider) return wider;
          trace.push(`${hit} expanded to ${JSON.stringify(children.slice(0, 25))}; no candidate names one of them`);
          return {
            filled: false,
            detail: `${JSON.stringify(hit)} is a category, not an answer; it offers ${JSON.stringify(children.slice(0, 25))} and none of ${JSON.stringify(candidates)} names one, here or under ${JSON.stringify(offered.filter((item) => item !== hit).slice(0, WD_MAX_CATEGORIES))}`,
          };
        }
        const after = await chosenValues(field);
        // A single-select replaces rather than adds, so the count does not
        // grow: check the selection now names the option that was clicked.
        if (after.some((value) => matches(value, hit))) {
          return { filled: true, detail: `selected ${after.join(", ")} from the offered list` };
        }
        if (after.length > baseline.length) {
          return { filled: true, detail: `selected ${after.join(", ")} from the offered list` };
        }
        const state = await promptState(page, field);
        if (announcesNewSelection(stateBefore, state)) {
          return { filled: true, detail: `selected ${hit} (announced ${state})` };
        }
      }
      trace.push(`offered match ${JSON.stringify(hit)} did not take`);
    }
    // A decline is asked of a short demographic list, which this first read
    // shows in full. When nothing on it declines, typing each of two dozen
    // decline wordings can only narrow it further: Altera's optional "Please
    // indicate if you are Hispanic or Latino." offers Yes and No, and the
    // search spent the whole budget before the run could move on. A value an
    // earlier run left still goes through the full pass, which clears it.
    if (
      !hit &&
      stale.length === 0 &&
      isDeclineSearch(candidates) &&
      offered.length > 0 &&
      offered.length <= WD_SHORT_LIST &&
      !offered.some((option) => isDeclinePhrase(option))
    ) {
      await closeMenu(page);
      return { filled: false, detail: `offers no way to decline: ${JSON.stringify(offered)}` };
    }
  }

  for (const candidate of candidates.flatMap(expand)) {
    if (Date.now() > deadline) {
      trace.push(`gave up after ${WD_PROMPT_BUDGET_MS}ms`);
      break;
    }
    await closeMenu(page);
    const beforeText = await widgetText(field);
    const beforeState = await promptState(page, field);
    if (!(await openMenu(page, field))) {
      openFailures += 1;
      trace.push(`${candidate}: menu would not open`);
      if (openFailures >= WD_MAX_OPEN_FAILURES) {
        trace.push("menu never opened; widget is disabled or gone");
        break;
      }
      continue;
    }
    openFailures = 0;

    const topLevel = await menuItems(page);
    const clicked = await clickMatch(page, candidate);
    trace.push(
      `${candidate}: clicked=${clicked} of ${topLevel.length}` +
        (clicked ? "" : ` ${JSON.stringify(topLevel.slice(0, 8))}`),
    );
    if (clicked) {
      onOffer = true;
      const after = await chosenValues(field);
      if (tookAnswer(after, baseline, [candidate])) return { filled: true, detail: `selected ${after.join(", ")}` };

      // Nothing was chosen and the list was replaced: the entry was a category,
      // not a value. Workday renders "How Did You Hear About Us?" this way on a
      // plain single-select - "Website" opens a second level holding the actual
      // sources - and a flat-only matcher reports the answer as "not offered"
      // while it is sitting one click away.
      const nested = await menuItems(page);
      if (nested.length > 0 && !sameOptions(topLevel, nested)) {
        if (await clickAnyCandidate(page, candidates)) {
          const chosen = await chosenValues(field);
          if (tookAnswer(chosen, baseline, candidates)) {
            return { filled: true, detail: `selected ${chosen.join(", ")} under ${candidate}` };
          }
        }
      }

      // The click may have landed on a widget whose chosen value none of the
      // known selectors can read. Its own text is the last word on that.
      await closeMenu(page);
      const afterText = await widgetText(field);
      const state = await promptState(page, field);
      trace.push(`state ${state}`);
      if (announcesNewSelection(beforeState, state)) {
        return { filled: true, detail: `selected ${candidate} (announced ${state})` };
      }
      if (textGained(beforeText, afterText, candidate)) {
        return { filled: true, detail: `selected ${candidate} (confirmed by widget text)` };
      }
    }

    // A click that resolves without selecting anything has hit a part of the
    // row that takes no events. The keyboard drives the same widget through
    // its own key handling.
    if (await selectByKeyboard(page, field, candidate)) {
      onOffer = true;
      // Enter commits the row the cursor is actually on, which the read-back
      // can misname, so only the answer itself showing up confirms it. A count
      // that grew says something was chosen, not what.
      const chosen = await chosenValues(field);
      if (chosen.some((value) => matches(value, candidate))) {
        return { filled: true, detail: `selected ${chosen.join(", ")} with the keyboard` };
      }
      await closeMenu(page);
      const keyboardText = await widgetText(field);
      trace.push(`${candidate}: keyboard -> ${await promptState(page, field)}`);
      if (chosen.length === 0 && textGained(beforeText, keyboardText, candidate)) {
        return { filled: true, detail: `selected ${candidate} with the keyboard (confirmed by widget text)` };
      }
    } else {
      trace.push(`${candidate}: keyboard found no matching row`);
    }

    // Not among the options rendered so far, which for a long taxonomy is only
    // the first page of an alphabetical list. Typing narrows it to the answer.
    if (await searchMenu(page, field, candidate)) {
      // A search submitted with Enter can select its only result outright.
      // Kept when that result is any approved name for the answer - Snap's
      // "Computer Science" search lands on "Computer and Information Science" -
      // and otherwise undone before the next candidate, because it is a claim
      // that was never approved. On a single-select the stray replaced the
      // value the pass began with, so undoing it means choosing that again.
      const picked = await chosenValues(field);
      if (!sameValueSet(picked, baseline)) {
        if (picked.some((value) => candidates.some((approved) => matches(value, approved)))) {
          return { filled: true, detail: `searched and selected ${picked.join(", ")}` };
        }
        trace.push(`${candidate}: search selected ${JSON.stringify(picked)} on its own`);
        if (!(await clearAddedValues(page, field, baseline))) {
          return {
            filled: false,
            detail: `left ${JSON.stringify(await chosenValues(field))} selected and could not clear it; the field now states something that was never answered`,
            strayValue: true,
          };
        }
        if (!(await restoreSelection(page, field, baseline))) {
          return {
            filled: false,
            detail: `searching for ${JSON.stringify(candidate)} replaced ${JSON.stringify(baseline)} with ${JSON.stringify(await chosenValues(field))} and it could not be put back; the field now states something that was never answered`,
            strayValue: true,
          };
        }
      } else if (await clickMatch(page, candidate)) {
        onOffer = true;
        const after = await chosenValues(field);
        if (tookAnswer(after, baseline, [candidate])) {
          return { filled: true, detail: `searched and selected ${after.join(", ")}` };
        }
      }
    }

    // Only a picker nests its options. A plain dropdown is flat, and "opening"
    // one of its entries would select it, so probing there would quietly answer
    // the question with whatever was tried first.
    if (!(await isPicker(field))) continue;

    // Not offered at the top level: try each category from a fresh menu.
    await closeMenu(page);
    if (!(await openMenu(page, field))) continue;
    const categories = (await page.locator(WD_MENU_ITEM).allInnerTexts().catch(() => [] as string[]))
      .map((text) => text.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .slice(0, WD_MAX_CATEGORIES);

    for (const category of categories) {
      await closeMenu(page);
      if (!(await openMenu(page, field))) break;
      if (!(await clickMatch(page, category))) continue;

      // An entry that turned out to be a value rather than a category has just
      // answered the question. Undo it: the pill is its own delete control.
      const opened = await chosenValues(field);
      if (opened.length > baseline.length) {
        if (opened.some((value) => matches(value, candidate))) {
          return { filled: true, detail: `selected ${opened.join(", ")}` };
        }
        const cleared = await clearAddedValues(page, field, baseline);
        if (!cleared) {
          return {
            filled: false,
            detail: `left ${JSON.stringify(await chosenValues(field))} selected and could not clear it; the field now states something that was never answered`,
            strayValue: true,
          };
        }
        // Every entry in a flat taxonomy is a value, so there are no categories
        // to open and each further probe only risks another stray selection.
        // Adobe's Field of Study lists thousands of majors this way.
        break;
      }

      if (!(await clickMatch(page, candidate))) continue;
      onOffer = true;
      const after = await chosenValues(field);
      if (tookAnswer(after, baseline, [candidate])) {
        return { filled: true, detail: `selected ${after.join(", ")} under ${category}` };
      }
    }
  }

  // Nothing matched by wording. A question whose options are numeric ranges is
  // still answerable from a stated figure: "5" is not a substring of "4+ years"
  // but it is the band that contains it. Read the menu once, both to try that
  // and to report what was on offer.
  let offered: string[] = [];
  if (await openMenu(page, field)) {
    offered = (await page.locator(WD_MENU_ITEM).allInnerTexts().catch(() => [] as string[]))
      .map((text) => text.replace(/\s+/g, " ").trim())
      .filter(Boolean)
      .slice(0, WD_MAX_MENU_ROWS);
    const band = pickNumericBandIndex(offered, candidates);
    if (band >= 0) {
      onOffer = true;
      // Read against the whole list, the band is the answer; one an earlier
      // pass already chose is that answer, and re-clicking it changes nothing
      // a read-back could confirm.
      const current = await chosenValues(field);
      if (current.length === 1 && current[0] === offered[band]) {
        await closeMenu(page);
        return { filled: true, detail: `already set to band ${offered[band]}` };
      }
      await page.locator(WD_MENU_ITEM).nth(band).click({ timeout: 10_000 }).catch(() => undefined);
      await page.waitForTimeout(1_000);
      const after = await chosenValues(field);
      if (tookAnswer(after, baseline, [offered[band]!])) {
        return { filled: true, detail: `selected band ${after.join(", ")}` };
      }
    }
  }
  // Say what was actually on offer. Without it every mismatch needs a bespoke
  // browser probe to diagnose, because the wanted values are all the log shows.
  await closeMenu(page);
  // Last line of defence: whatever happened above, this prompt must end the
  // pass holding exactly what it held at the start.
  if (!(await clearAddedValues(page, field, baseline))) {
    return {
      filled: false,
      detail: `left ${JSON.stringify(await chosenValues(field))} selected and could not clear it; the field now states something that was never answered`,
      strayValue: true,
    };
  }
  if (!(await restoreSelection(page, field, baseline))) {
    return {
      filled: false,
      detail: `the pass replaced ${JSON.stringify(baseline)} with ${JSON.stringify(await chosenValues(field))} and it could not be put back; the field now states something that was never answered`,
      strayValue: true,
    };
  }
  if (stale.length > 0 && baseline === stale) {
    if (onOffer) {
      // An approved answer was offered and would not select, so the value an
      // earlier run left is not "kept" - it is what the form still says
      // instead of the answer.
      return {
        filled: false,
        detail: `still reads ${JSON.stringify(stale)}, left over from an earlier run; a candidate of ${JSON.stringify(candidates)} is on offer but would not select; trace: ${trace.join(" | ")}`,
        strayValue: true,
      };
    }
    // Nothing on offer matched, so there is no basis for calling the existing
    // value wrong. The phone-code prompt is searched with the phone number,
    // which matches no country; the draft's "Canada (+1)" is correct and
    // stands. It is only replaced when a candidate is confirmed on offer.
    //
    // A decline is the exception: it asks for the question to go unanswered,
    // so whatever an earlier run left is an answer the candidate chose not to
    // give. Disney's draft came back holding "No" for "Are you Hispanic or
    // Latino?", which offers no way to decline, and "kept" would have sent it.
    if (candidates.some((candidate) => isRefusal(candidate.toLowerCase()))) {
      const cleared = await clearToPlaceholder(page, field);
      return cleared.filled
        ? { filled: true, detail: `declined: cleared ${stale.join(", ")} left over from an earlier run` }
        : cleared;
    }
    return {
      filled: true,
      detail: `kept ${stale.join(", ")}; no candidate of ${JSON.stringify(candidates)} is on offer`,
    };
  }
  return {
    filled: false,
    detail: `no Workday option matched ${JSON.stringify(candidates)}; offered ${JSON.stringify(offered)}; trace: ${trace.join(" | ")}; search: ${lastSearchDetail}`,
  };
}
