import { AppError } from "../util/errors.js";
import { logger } from "../util/logger.js";
import { pickNumericBandIndex } from "../drafting/numericBands.js";
import { getAtsCredentials, type AtsCredentials } from "./credentials.js";

/**
 * Workday's pre-form flow.
 *
 * Unlike Greenhouse, Lever and Ashby, a Workday posting does not show a form.
 * It shows a job advert with an Apply button, then a modal, then a sign-in wall.
 * The application itself only appears once an account exists on that employer's
 * tenant, and every employer is a separate tenant with a separate account.
 *
 * Selectors here are Workday's own `data-automation-id` values, which are
 * stable across tenants because they come from the platform rather than the
 * employer's configuration.
 */

type Page = {
  goto: (url: string, options?: unknown) => Promise<unknown>;
  locator: (selector: string) => Locator;
  url: () => string;
  waitForTimeout: (ms: number) => Promise<void>;
  waitForLoadState: (state: string, options?: unknown) => Promise<void>;
  evaluate: (fn: unknown, arg?: unknown) => Promise<unknown>;
  reload: (options?: unknown) => Promise<unknown>;
  keyboard: {
    press: (key: string) => Promise<void>;
    type: (text: string, options?: unknown) => Promise<void>;
  };
};
type Locator = {
  first: () => Locator;
  nth: (index: number) => Locator;
  count: () => Promise<number>;
  click: (options?: unknown) => Promise<void>;
  fill: (value: string, options?: unknown) => Promise<void>;
  isVisible: () => Promise<boolean>;
  waitFor: (options?: unknown) => Promise<void>;
  locator: (selector: string) => Locator;
  allInnerTexts: () => Promise<string[]>;
  evaluate?: (fn: unknown, arg?: unknown) => Promise<unknown>;
};

export const WORKDAY_HOST_PATTERN = /(^|\.)myworkdayjobs\.com$/i;

export function isWorkdayUrl(rawUrl: string): boolean {
  try {
    return WORKDAY_HOST_PATTERN.test(new URL(rawUrl).hostname);
  } catch {
    return false;
  }
}

const SEL = {
  apply: '[data-automation-id="adventureButton"]',
  applyManually: '[data-automation-id="applyManually"]',
  useMyLastApplication: '[data-automation-id="useMyLastApplication"]',
  signInWithEmail: '[data-automation-id="SignInWithEmailButton"]',
  googleSignIn: '[data-automation-id="GoogleSignInButton"]',
  email: '[data-automation-id="email"]',
  password: '[data-automation-id="password"]',
  verifyPassword: '[data-automation-id="verifyPassword"]',
  createAccountSubmit: '[data-automation-id="createAccountSubmitButton"]',
  signInSubmit: '[data-automation-id="signInSubmitButton"]',
  signInLink: '[data-automation-id="signInLink"]',
  createAccountLink: '[data-automation-id="createAccountLink"]',
  errorBanner: '[data-automation-id="errorMessage"]',
} as const;

/**
 * Controls that only exist once the application wizard is open. The step label
 * is the primary signal - live Salesforce, NVIDIA and Adobe tenants all render
 * it - with the wizard's own navigation and form fields as fallbacks for a
 * tenant that omits the progress bar.
 */
const FORM_EVIDENCE = [
  '[data-automation-id="progressBarActiveStep"]',
  '[data-automation-id="bottom-navigation-next-button"]',
  '[data-automation-id^="formField-"]',
] as const;

/**
 * Evidence that the job advert itself has rendered. Workday is a single-page
 * app: the careers shell (header, logo, "Sign In" link) paints immediately
 * while the posting body arrives later. Waiting for one of these before
 * reaching for the Apply button is what separates a slow tenant from a closed
 * posting - Cisco's tenant rendered nothing but its header inside the old
 * budget and was reported as "probably closed" while the posting was live.
 */
const ADVERT_EVIDENCE = [
  SEL.apply,
  '[data-automation-id="jobPostingHeader"]',
  '[data-automation-id="jobPostingDescription"]',
] as const;

/**
 * Longest body text a bare careers shell produces. Cisco's is roughly 60
 * characters ("English | Sign In | Careers | Search for Jobs"); a real advert
 * carries a title, location, requisition id and description and runs to
 * thousands.
 */
const SHELL_TEXT_MAX = 200;

/**
 * Workday's own wording when a requisition has been pulled. Distinguishing this
 * from "the wizard never opened" matters: a dead posting is final and the
 * application should be withdrawn, whereas an unopened wizard is worth retrying.
 */
const DEAD_POSTING_TEXT = /page you are looking for (does ?n[o']?t|doesn't) exist|no longer (available|accepting)|job (posting )?(has been )?(closed|removed)|requisition .*(closed|no longer)/i;

/** Workday's notice that a new account must be verified by email before use. */
const VERIFY_ACCOUNT_TEXT = /verify your (account|email)|email has been sent to you|verification (email|link)/i;

export function isDeadPostingText(text: string): boolean {
  return DEAD_POSTING_TEXT.test(text);
}

export type AdvertState = "advert" | "dead" | "blank";

/**
 * Waits for the advert to paint, ending early on the tenant's not-found page.
 *
 * Element presence alone is not enough: a tenant serves the shell with empty
 * `data-automation-id` containers already in the DOM, so a selector match
 * reports a rendered advert over a blank page. The posting's own text is the
 * reliable signal, so a body no longer than the surrounding chrome counts as
 * not rendered.
 *
 * The three outcomes are genuinely different and must not be collapsed: an
 * advert can be applied to, a dead posting never will be, and a blank page
 * says nothing about whether the posting is open.
 */
async function awaitAdvert(page: Page, timeoutMs: number): Promise<AdvertState> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const paragraphs = await page.locator("body").allInnerTexts().catch(() => [] as string[]);
    const text = paragraphs.join(" ").trim();

    // Checked before the length gate: the not-found page is itself short.
    const errorShown = await page.locator(SEL.errorBanner).first().isVisible().catch(() => false);
    if (errorShown && isDeadPostingText(text)) return "dead";

    if (text.length > SHELL_TEXT_MAX) {
      for (const selector of ADVERT_EVIDENCE) {
        const visible = await page.locator(selector).first().isVisible().catch(() => false);
        if (visible) return "advert";
      }
    }
    await page.waitForTimeout(1000);
  }
  return "blank";
}

export type WorkdayEntryResult = {
  reached: "form" | "sign-in" | "blocked";
  detail: string;
  createdAccount: boolean;
};

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
const WD_PILL = '[data-automation-id="selectedItem"]';
const WD_MENU_ITEM = `[role="option"]:visible:not(${WD_PILL})`;
/**
 * A Workday prompt popup. Positioned portals carry this attribute, and each
 * open prompt contributes one, so it is how one widget's options are told
 * apart from another's.
 */
const WD_POPUP = "[data-popper-placement]:visible";
const WD_MAX_CATEGORIES = 8;

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

/**
 * `strayValue` marks a failure that leaves the field stating something nobody
 * approved - a probe's selection that would not undo, or a value an earlier
 * run left that the approved answer could not replace. A blank optional field
 * can be skipped; one of these cannot, because it would be submitted as said.
 */
export type WorkdayPromptResult = { filled: boolean; detail: string; strayValue?: boolean };

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
function promptContainer(field: Locator): Locator {
  return field.locator(
    'xpath=ancestor-or-self::*[@data-automation-id="multiSelectContainer"]'
      + ' | .//*[@data-automation-id="multiSelectContainer"]'
      + ' | ancestor-or-self::button[@aria-haspopup="listbox"]'
      + ' | .//button[@aria-haspopup="listbox"]',
  );
}

/** True when this field is one of Workday's prompt widgets rather than a text input. */
export async function isWorkdayPrompt(field: Locator): Promise<boolean> {
  return (await promptContainer(field).count()) > 0;
}

/** A picker nests its options one level; a plain dropdown is flat. */
async function isPicker(field: Locator): Promise<boolean> {
  return (await field.locator(
    'xpath=ancestor-or-self::*[@data-automation-id="multiSelectContainer"]'
      + ' | .//*[@data-automation-id="multiSelectContainer"]',
  ).count()) > 0;
}

async function closeMenu(page: Page): Promise<void> {
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

async function openMenu(page: Page, field: Locator): Promise<boolean> {
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
const WD_PLACEHOLDER = /^(select one|select\.{0,3}|search|)$/i;

async function chosenValues(field: Locator): Promise<string[]> {
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

/**
 * Yes and no are too short to match on substrings: "no" appears inside "NOT",
 * and "Yes, no restriction" contains both. A bare polarity answer therefore
 * only takes an option that leads with the same word - the rule the option
 * matcher already applies everywhere else.
 */
const WD_POLARITY = /^(yes|no)$/;

/** Substring matching alone lets "no" hide inside "not" and answer the opposite. */
function containsWord(haystack: string, needle: string): boolean {
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(haystack);
}

/**
 * A word can be whole inside its own refusal: "acknowledged" is a word of "Not
 * acknowledged". An option that negates and a candidate that does not (or the
 * reverse) state opposite answers, whatever words they share.
 */
const WD_NEGATION = /\b(not|never|no|none|neither|decline|disagree)\b/;

function negated(text: string): boolean {
  return WD_NEGATION.test(text.replace(/n['\u2019]t\b/g, " not"));
}

function matches(optionText: string, candidate: string): boolean {
  const option = optionText.replace(/\s+/g, " ").trim().toLowerCase();
  const wanted = candidate.replace(/\s+/g, " ").trim().toLowerCase();
  if (!option || !wanted) return false;
  if (WD_PLACEHOLDER.test(option)) return false;
  if (isRefusal(option) && isRefusal(wanted)) return true;
  if (WD_POLARITY.test(wanted)) return new RegExp(`^${wanted}\\b`, "i").test(option);
  // A bare "Yes" or "No" is a whole answer, so it stands only for a candidate
  // that opens with it: "No, I will not require sponsorship". Taken as a word
  // anywhere, SCAN's "No" answered "Not Applicable/No Driving Requirements"
  // and Unity's answered a declined disclosure through "no response".
  if (WD_POLARITY.test(option)) return new RegExp(`^${option}\\s*[,.;:!()\\u2013\\u2014-]`).test(wanted);
  if (negated(option) !== negated(wanted)) return false;
  return option === wanted || containsWord(option, wanted) || containsWord(wanted, option);
}

/**
 * Employers name the same choice differently, and a Workday prompt offers no
 * free text to fall back on, so a stored answer has to be tried under the
 * tenant's own vocabulary. NVIDIA lists a mobile number as "Home Cellular".
 */
const WD_SYNONYMS: readonly (readonly string[])[] = [["mobile", "cell", "cellular"]];

/**
 * A refusal to answer, however it is spelled.
 *
 * NVIDIA alone offers three spellings on one step - "Decline to State" for
 * ethnicity and gender, "I DO NOT WISH TO SELF-IDENTIFY" for veteran status -
 * and the stored answer says "decline to self-identify". Chasing that with a
 * list of literals is a losing game, so both sides are recognised as refusals
 * instead. Both must be refusals for this to apply, so a real answer can never
 * be turned into a decline.
 */
const WD_REFUSAL =
  /(declined? to|prefer not to|do not wish to|don't wish to|do not want to|choose not to|rather not|wish not to|not to disclose|not to self.?identify|no response|not declared|undeclared|not specified|unspecified|did not provide)/;

function isRefusal(text: string): boolean {
  return WD_REFUSAL.test(text);
}

function expand(candidate: string): string[] {
  const lower = candidate.toLowerCase();
  const group = WD_SYNONYMS.find((words) => words.some((word) => lower.includes(word)));
  if (!group) return [candidate];
  return [candidate, ...group.filter((word) => !lower.includes(word))];
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
    boxes.push({ box, where: `page[${index}/${looseCount}]`, ownsPrompt: await insidePopup(box) });
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
  // first word reaches "Computer Science, General" and its neighbours.
  const terms = [candidate, candidate.split(/[\s,/]+/)[0] ?? candidate].filter(
    (term, index, all) => term.length >= 3 && all.indexOf(term) === index,
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
async function insidePopup(box: Locator): Promise<boolean> {
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

/** Describes the page's visible inputs so a failed search explains itself. */
async function describeInputs(page: Page): Promise<string> {
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

/** What the last search attempt did, so a mismatch explains itself. */
let lastSearchDetail = "not attempted";

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
async function menuScope(page: Page): Promise<Locator> {
  const popups = page.locator(WD_POPUP);
  const count = await popups.count().catch(() => 0);
  return count > 0 ? popups.nth(count - 1) : page.locator("body");
}

/** The option labels the open menu is showing, cleaned for comparison. */
async function menuItems(page: Page): Promise<string[]> {
  const scope = await menuScope(page);
  return (await scope.locator(WD_MENU_ITEM).allInnerTexts().catch(() => [] as string[]))
    .map((text) => text.replace(/\s+/g, " ").trim())
    .filter(Boolean);
}

function sameOptions(before: readonly string[], after: readonly string[]): boolean {
  return before.length === after.length && before.every((text, index) => text === after[index]);
}

/** The same values in any order: a picker lists its pills in the order they were added. */
function sameValueSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value) => b.includes(value));
}

/**
 * Whether the widget now holds a wanted answer it did not hold before.
 *
 * A picker adds a pill, so its count grows. A single-select replaces its value
 * in place: counting misses a legitimate replacement of a value an earlier run
 * left behind, and equally misses a probe that swapped a correct value for a
 * wrong one. A replaced value only counts when it is one of the wanted answers.
 */
function tookAnswer(after: readonly string[], baseline: readonly string[], wanted: readonly string[]): boolean {
  if (after.length > baseline.length) return true;
  return after.some((value) => !baseline.includes(value) && wanted.some((candidate) => matches(value, candidate)));
}

type RankedOption = { option: string; rank: number };

function normalizedText(text: string): string {
  return text.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Orders two options that both answer a candidate. One that says exactly what
 * was approved wins; otherwise the least qualified does, so given "Cellular"
 * and "Work Cellular" the bare one is meant. Shortest-first alone preferred
 * "LinkedIn" to an approved "LinkedIn Job Posting" offered beside it.
 */
function closerTo(candidate: string, a: string, b: string): number {
  const wanted = normalizedText(candidate);
  const exact = Number(normalizedText(b) === wanted) - Number(normalizedText(a) === wanted);
  return exact !== 0 ? exact : a.length - b.length;
}

/**
 * The option closest to the approved answer. Candidates arrive in order of
 * preference, so the earliest candidate an option answers is its rank. Among
 * equals `closerTo` decides, as it does in `clickMatch`.
 */
function bestRanked(options: readonly string[], candidates: readonly string[]): RankedOption | undefined {
  let best: RankedOption | undefined;
  for (const option of options) {
    const rank = candidates.findIndex((candidate) => matches(option, candidate));
    if (rank < 0) continue;
    if (best === undefined || rank < best.rank || (rank === best.rank && closerTo(candidates[rank]!, option, best.option) < 0)) {
      best = { option, rank };
    }
  }
  return best;
}

/** Clicks the entry whose text is exactly this, for re-opening or restoring a known entry. */
async function clickExact(page: Page, text: string): Promise<boolean> {
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

/**
 * Clicks the first option matching any approved answer.
 *
 * Only values the caller already supplied are ever clicked, so descending into
 * a submenu can never answer a question with something that was not approved.
 */
async function clickAnyCandidate(page: Page, candidates: readonly string[]): Promise<boolean> {
  for (const candidate of candidates.flatMap(expand)) {
    if (await clickMatch(page, candidate)) return true;
  }
  return false;
}

async function clickMatch(page: Page, candidate: string): Promise<boolean> {
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
async function clearAddedValues(
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
    const pill = pills.nth(Math.max((await pills.count()) - 1, 0));
    const remove = pill.locator('button, [role="button"], [data-automation-id*="delete" i], svg').first();
    const target = (await remove.count()) > 0 ? remove : pill;
    await target.click({ timeout: 5_000 }).catch(() => undefined);
    await page.waitForTimeout(500);
  }
  return (await chosenValues(field)).length <= before.length;
}

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
    const children = (await menuItems(page)).filter((item) => !shown.includes(item));
    if (children.length > 0) {
      const local = bestRanked(children, candidates);
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
    const reached = found.category === undefined || (await clickExact(page, found.category));
    if (reached && (await clickExact(page, found.option))) {
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
async function widgetText(field: Locator): Promise<string> {
  const texts = await field.allInnerTexts().catch(() => [] as string[]);
  return texts.join(" ").replace(/\s+/g, " ").trim().toLowerCase();
}

function textGained(before: string, after: string, candidate: string): boolean {
  const wanted = candidate.replace(/\s+/g, " ").trim().toLowerCase();
  if (!wanted) return false;
  return containsWord(after, wanted) && !containsWord(before, wanted);
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
async function promptState(page: Page, field: Locator): Promise<string> {
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

/** How many values the widget says it holds: its screen-reader count or its checked rows. */
function announcedCount(state: string): number {
  const items = /(\d+)\s+items?\s+selected/i.exec(state);
  const checked = /checked=(\d+)$/.exec(state);
  return Math.max(items ? Number(items[1]) : 0, checked ? Number(checked[1]) : 0);
}

/**
 * Whether the widget announces more than it did before the click. A
 * single-select still holding an old value says "1 item selected" whether or
 * not the click landed, so only a count that grew is evidence of the click.
 */
function announcesNewSelection(before: string, after: string): boolean {
  return announcedCount(after) > announcedCount(before);
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
async function selectByKeyboard(page: Page, field: Locator, candidate: string): Promise<boolean> {
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
    // "Job board" is a weaker restatement than the employer's own site.
    const hit = bestRanked(offered, candidates)?.option;
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
        const children = (await menuItems(page)).filter((item) => !offered.includes(item));
        if (children.length > 0) {
          const local = bestRanked(children, candidates);
          if (local?.rank === 0 && (await clickExact(page, local.option))) {
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
      .slice(0, WD_MAX_CATEGORIES);
    const band = pickNumericBandIndex(offered, candidates);
    if (band >= 0) {
      onOffer = true;
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

const CLICK_FILTER = '[data-automation-id="click_filter"]';

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
 * Builds the in-page script that clicks a Workday control.
 *
 * Workday renders every button twice: a real `<button>` carrying the
 * data-automation-id, marked `aria-hidden` with `tabindex="-2"`, and a
 * transparent `div[data-automation-id="click_filter"]` laid over it that holds
 * `role="button"` and receives the pointer events. Clicking the button
 * therefore never lands - the overlay intercepts it and Playwright retries
 * until it times out. The overlay is what a person actually clicks.
 *
 * Where several overlays share an ancestor the aria-label picks the right one;
 * an ambiguous group is left alone and the walk continues outwards, because
 * clicking a neighbouring button is worse than not clicking at all.
 */
export function buildOverlayClickScript(selector: string): string {
  return `(() => {
    const target = document.querySelector(${JSON.stringify(selector)});
    if (!target) return "missing";
    const norm = (value) => (value || "").replace(/\\s+/g, " ").trim().toLowerCase();
    const label = norm(target.textContent) || norm(target.getAttribute("aria-label"));
    let node = target.parentElement;
    for (let depth = 0; depth < 4 && node; depth += 1) {
      const overlays = Array.from(node.querySelectorAll(${JSON.stringify(CLICK_FILTER)}));
      if (overlays.length > 0) {
        const match = overlays.length === 1
          ? overlays[0]
          : overlays.find((overlay) => norm(overlay.getAttribute("aria-label")) === label);
        if (match) {
          match.click();
          return "overlay";
        }
      }
      node = node.parentElement;
    }
    target.click();
    return "direct";
  })()`;
}

/**
 * Clicks a control if it is present, reporting whether the click landed.
 *
 * Never throws. A control that cannot be clicked must leave the caller free to
 * try the next route - a failed sign-in has to be able to fall through to
 * registration rather than aborting the whole application.
 */
async function clickIfPresent(page: Page, selector: string, timeoutMs = 8000): Promise<boolean> {
  const locator = page.locator(selector).first();
  try {
    await locator.waitFor({ state: "visible", timeout: timeoutMs });
  } catch {
    return false;
  }

  try {
    await locator.click({ timeout: Math.min(timeoutMs, 5000) });
    await page.waitForTimeout(2500);
    return true;
  } catch {
    // Intercepted or detached; try the overlay Workday actually listens on.
  }

  let outcome = "failed";
  try {
    outcome = (await page.evaluate(buildOverlayClickScript(selector))) as string;
  } catch {
    return false;
  }
  if (outcome === "missing" || outcome === "failed") return false;
  await page.waitForTimeout(2500);
  return true;
}

async function visibleText(page: Page, selector: string): Promise<string> {
  const count = await page.locator(selector).first().count();
  if (count === 0) return "";
  return (await page.evaluate(
    `(() => { const e = document.querySelector(${JSON.stringify(selector)}); return e ? (e.innerText || '') : ''; })()`,
  )) as string;
}

/**
 * Reports whether the page is still showing a sign-in gate.
 *
 * Used to tell "signed in already" apart from "the credential form has not
 * opened yet". Both states lack a password field, so absence alone cannot
 * distinguish them and the provider chooser has to be looked for directly.
 */
async function atSignInWall(page: Page): Promise<boolean> {
  for (const selector of [SEL.signInWithEmail, SEL.googleSignIn, SEL.email]) {
    const visible = await page.locator(selector).first().isVisible().catch(() => false);
    if (visible) return true;
  }
  return false;
}

/**
 * Reports whether a sign-in or registration submit left the browser at the
 * account gate: either the credential form or the provider chooser.
 *
 * The password field alone is not enough. Some tenants answer both a refused
 * sign-in and a completed registration with the chooser, which has no password
 * field, and reading that absence as success sent the run off to fill the
 * sign-in page as though it were the application.
 */
async function atCredentialGate(page: Page): Promise<boolean> {
  for (const selector of [SEL.password, SEL.signInWithEmail, SEL.googleSignIn]) {
    const visible = await page.locator(selector).first().isVisible().catch(() => false);
    if (visible) return true;
  }
  return false;
}

/**
 * Reports whether the application wizard is actually on screen.
 *
 * Needed for the same reason as the sign-in wall check, taken one step further:
 * a missing password field and a missing provider chooser still do not prove the
 * form was reached. A closed posting renders a "page does not exist" shell that
 * has neither, so inferring success from those two absences reports a form that
 * was never opened - and postings in this campaign close constantly.
 */
/**
 * Wording of the wizard's first step, which is the account gate rather than the
 * application. Every tenant probed renders the same eight-step progress bar and
 * labels this step "Create Account/Sign In".
 */
const SIGN_IN_STEP_TEXT = /create account|sign ?in|log ?in/i;

export function isSignInStepLabel(text: string): boolean {
  return SIGN_IN_STEP_TEXT.test(text);
}

/**
 * Reports whether a URL is the tenant's standalone login route, which some
 * tenants redirect a registration to instead of opening the wizard. Matched on
 * a whole path segment so a job slug such as "Login-Platform-Engineer" is not.
 */
export function isAccountGateUrl(url: string): boolean {
  try {
    return new URL(url).pathname.split("/").some((segment) => segment.toLowerCase() === "login");
  } catch {
    return false;
  }
}

async function atApplicationForm(page: Page): Promise<boolean> {
  if (isAccountGateUrl(page.url())) return false;
  // The account gate is step 1 of the wizard, so it renders the progress bar and
  // a pair of `formField-` divs for email and password. Both are in
  // FORM_EVIDENCE, which meant the sign-in box itself was read as the
  // application form: the run then "collected" one field, filled nothing, and
  // blamed the posting for being removed. The step label is what separates them.
  const step = await page
    .locator('[data-automation-id="progressBarActiveStep"]')
    .first()
    .allInnerTexts()
    .catch(() => [] as string[]);
  if (isSignInStepLabel(step.join(" "))) return false;

  for (const selector of FORM_EVIDENCE) {
    const visible = await page.locator(selector).first().isVisible().catch(() => false);
    if (visible) return true;
  }
  return false;
}

/**
 * Walks from a Workday job advert to its application form, signing in or
 * registering as needed.
 *
 * Sign-in is always attempted before registration: an existing account must not
 * be duplicated, and a "there is already an account" error is a far better
 * outcome than a second account the candidate does not know about.
 */
export async function enterWorkdayApplication(
  page: Page,
  profileEmail: string,
  options: { allowAccountCreation: boolean },
): Promise<WorkdayEntryResult> {
  const credentials: AtsCredentials = getAtsCredentials(profileEmail);

  // The advert has to be on screen before the Apply button can be reached for.
  // Without this the run raced the single-page app and blamed the posting.
  const advert = await awaitAdvert(page, 45_000);

  // A pulled requisition renders the tenant's not-found page, which has neither
  // an Apply button nor a sign-in form. Naming it here stops the caller from
  // retrying a posting that will never come back.
  if (advert === "dead") {
    return {
      reached: "blocked",
      detail: "the posting no longer exists; Workday served its not-found page",
      createdAccount: false,
    };
  }

  await clickIfPresent(page, SEL.apply, 15_000);
  // The modal offers "Autofill with Resume" and "Apply Manually". Manual is the
  // honest path: resume autofill silently invents field values from parsed text.
  await clickIfPresent(page, SEL.applyManually, 8000);
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);

  // Newer tenants gate the credential form behind a provider chooser offering
  // "Sign in with Google" or "Sign in with email". That page carries no email or
  // password field at all, so the form has to be opened before it can be found.
  // Measured at ~8s to paint on Workday's own tenant, so 6s lost the race.
  await clickIfPresent(page, SEL.signInWithEmail, 20_000);

  const onAccountPage = await page.locator(SEL.password).first().isVisible().catch(() => false);
  if (!onAccountPage) {
    // An absent password field is not evidence of being signed in - it is also
    // what a provider chooser looks like. Claiming "form reached" there sends the
    // caller off to fill a form that does not exist, so the wall is named instead.
    if (await atSignInWall(page)) {
      return {
        reached: "sign-in",
        detail: "stopped at the sign-in wall; the credential form did not open",
        createdAccount: false,
      };
    }
    if (!(await atApplicationForm(page))) {
      return {
        reached: "blocked",
        detail: advert === "advert"
          ? "no application form on screen and no sign-in gate; the posting is probably closed or the wizard never opened"
          : "the job advert never rendered within 45s; the tenant is slow or is refusing this session, so whether the posting is open is unknown",
        createdAccount: false,
      };
    }
    return { reached: "form", detail: "already signed in; application form reached", createdAccount: false };
  }

  const signedIn = await signIn(page, credentials);
  if (signedIn.ok) return { reached: "form", detail: signedIn.detail, createdAccount: false };

  // An account that exists but was never verified refuses sign-in until its
  // email link is opened, and registering again cannot get past that.
  if (VERIFY_ACCOUNT_TEXT.test(signedIn.detail)) {
    return {
      reached: "sign-in",
      detail: `an account for ${credentials.email} exists on this tenant but is not verified yet: open the verification email sent to ${credentials.email}, then rerun`,
      createdAccount: false,
    };
  }

  if (!options.allowAccountCreation) {
    return { reached: "sign-in", detail: `${signedIn.detail}; account creation not permitted`, createdAccount: false };
  }

  const created = await createAccount(page, credentials);
  return {
    reached: created.ok ? "form" : created.created ? "sign-in" : "blocked",
    detail: created.detail,
    createdAccount: created.created,
  };
}

async function signIn(page: Page, credentials: AtsCredentials): Promise<{ ok: boolean; detail: string }> {
  // After registration some tenants return to the provider chooser, which has
  // to be opened again before the credential form exists.
  const passwordShown = await page.locator(SEL.password).first().isVisible().catch(() => false);
  if (!passwordShown) {
    const chooser = await page.locator(SEL.signInWithEmail).first().isVisible().catch(() => false);
    if (chooser) await clickIfPresent(page, SEL.signInWithEmail, 10_000);
  }

  // The account page opens in either mode depending on tenant; switch to sign-in
  // when the confirm-password field shows we landed on registration.
  const onCreate = await page.locator(SEL.verifyPassword).first().isVisible().catch(() => false);
  if (onCreate) {
    const switched = await clickIfPresent(page, SEL.signInLink, 5000);
    if (!switched) return { ok: false, detail: "could not switch to the sign-in form" };
  }

  const emailField = page.locator(SEL.email).first();
  await emailField.waitFor({ state: "visible", timeout: 10_000 }).catch(() => undefined);
  if (!(await emailField.isVisible().catch(() => false))) {
    return { ok: false, detail: "the sign-in form did not open" };
  }
  await emailField.fill(credentials.email);
  await page.locator(SEL.password).first().fill(credentials.password);
  await clickIfPresent(page, SEL.signInSubmit, 8000);
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => undefined);

  if (!(await atCredentialGate(page))) return { ok: true, detail: "signed in to an existing account" };

  const error = (await visibleText(page, SEL.errorBanner)).trim();
  return { ok: false, detail: error ? `sign-in refused: ${error.slice(0, 200)}` : "sign-in did not complete" };
}

async function createAccount(
  page: Page,
  credentials: AtsCredentials,
): Promise<{ ok: boolean; created: boolean; detail: string }> {
  const onSignIn = await page.locator(SEL.verifyPassword).first().isVisible().catch(() => false);
  if (!onSignIn) {
    const switched = await clickIfPresent(page, SEL.createAccountLink, 5000);
    if (!switched) return { ok: false, created: false, detail: "could not reach the create-account form" };
  }

  await page.locator(SEL.email).first().fill(credentials.email);
  await page.locator(SEL.password).first().fill(credentials.password);
  await page.locator(SEL.verifyPassword).first().fill(credentials.password);

  // Workday requires its own terms checkbox on some tenants. It is a plain
  // acknowledgement of the privacy notice, which the campaign already auto-ticks.
  await page
    .locator('[data-automation-id="createAccountCheckbox"]')
    .first()
    .click()
    .catch(() => undefined);

  await clickIfPresent(page, SEL.createAccountSubmit, 8000);
  await page.waitForLoadState("networkidle", { timeout: 20_000 }).catch(() => undefined);

  const outcome = await awaitRegistrationOutcome(page);
  if (outcome === "form") {
    logger.info("workday account created", { host: new URL(page.url()).hostname });
    return { ok: true, created: true, detail: "created a new account on this employer's tenant" };
  }

  if (outcome === "gate") {
    // Some tenants register the account and then return to Sign In - the
    // credential form or the provider chooser - rather than opening the form.
    const verifyNotice = async () =>
      VERIFY_ACCOUNT_TEXT.test((await page.locator("body").allInnerTexts().catch(() => [] as string[])).join(" "));
    const verificationDetail = `created an account, but the tenant requires email verification first: open the verification email sent to ${credentials.email}, then rerun`;
    if (await verifyNotice()) return { ok: false, created: true, detail: verificationDetail };

    const signedIn = await signIn(page, credentials);
    if (signedIn.ok) {
      logger.info("workday account created", { host: new URL(page.url()).hostname, signedIn: true });
      return { ok: true, created: true, detail: "created a new account on this employer's tenant and signed in with it" };
    }
    if (VERIFY_ACCOUNT_TEXT.test(signedIn.detail) || (await verifyNotice())) {
      return { ok: false, created: true, detail: verificationDetail };
    }
    return {
      ok: false,
      created: true,
      detail: `created an account, but signing in with it did not complete (${signedIn.detail}); rerun to sign in with the new account`,
    };
  }

  if (outcome === "unknown") {
    return {
      ok: false,
      created: true,
      detail: `submitted the registration for ${credentials.email}, but neither the application form nor the sign-in form appeared afterwards; rerun to sign in with the new account`,
    };
  }

  const error = (await visibleText(page, SEL.errorBanner)).trim();
  return {
    ok: false,
    created: false,
    detail: error ? `account creation refused: ${error.slice(0, 200)}` : "account creation did not complete",
  };
}

/** Polls allowed for a registration submit to settle, 1.5s apart. */
const REGISTRATION_SETTLE_POLLS = 12;

/**
 * Waits for a registration submit to land somewhere recognisable.
 *
 * Palo Alto Networks paints nothing but the wizard's sign-in step for several
 * seconds after registering, then shows the provider chooser. Judging the page
 * at once read that blank interval as the open application form.
 */
async function awaitRegistrationOutcome(page: Page): Promise<"form" | "gate" | "create" | "unknown"> {
  for (let poll = 0; poll < REGISTRATION_SETTLE_POLLS; poll += 1) {
    const onCreate = await page.locator(SEL.verifyPassword).first().isVisible().catch(() => false);
    if (onCreate) {
      const refused = await page.locator(SEL.errorBanner).first().isVisible().catch(() => false);
      if (refused) return "create";
    } else {
      if (await atCredentialGate(page)) return "gate";
      if (await atApplicationForm(page)) return "form";
    }
    await page.waitForTimeout(1500);
  }
  const stillOnCreate = await page.locator(SEL.verifyPassword).first().isVisible().catch(() => false);
  return stillOnCreate ? "create" : "unknown";
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
  answered: ReadonlyArray<{ label: string; value: string }>,
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
    // answer when every significant word of it is present.
    const words = significantWords(value).filter((word) => !employerWords.has(word));
    if (words.length > 0 && words.every((word) => haystack.includes(word))) continue;
    missing.push({ label: entry.label, value });
  }
  return missing;
}

function significantWords(text: string): string[] {
  return text.toLowerCase().split(/[^a-z0-9]+/).filter((word) => word.length > 3);
}

export function assertWorkdaySupported(rawUrl: string): void {
  if (!isWorkdayUrl(rawUrl)) {
    throw new AppError("not_workday", `${rawUrl} is not a Workday board`);
  }
}
