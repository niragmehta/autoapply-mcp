import type { Page } from "./types.js";

export const CLICK_FILTER = '[data-automation-id="click_filter"]';

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
export async function clickIfPresent(page: Page, selector: string, timeoutMs = 8000): Promise<boolean> {
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

export async function visibleText(page: Page, selector: string): Promise<string> {
  const count = await page.locator(selector).first().count();
  if (count === 0) return "";
  return (await page.evaluate(
    `(() => { const e = document.querySelector(${JSON.stringify(selector)}); return e ? (e.innerText || '') : ''; })()`,
  )) as string;
}
