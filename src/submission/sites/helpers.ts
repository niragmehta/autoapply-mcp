import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { analyzeLocation } from "../../ranking/location.js";
import type { BrowserRunResult } from "../browser/types.js";
import { normalizeLabel } from "../form/fieldModel.js";
import type { SubmissionPacket } from "../packet.js";
import type { SitePage } from "./types.js";

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

export function resumeUpload(packet: SubmissionPacket): { name: string; mimeType: string; buffer: Buffer } {
  const name = resumeUploadName(packet);
  const mimeType = name.toLowerCase().endsWith(".docx")
    ? "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
    : "application/pdf";
  return { name, mimeType, buffer: readFileSync(packet.resumePath) };
}

export function result(
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
export async function markElement(page: SitePage, selector: string, pattern: string, flags = "i"): Promise<boolean> {
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

export async function clickMarked(page: SitePage, selector: string, pattern: string): Promise<boolean> {
  if (!(await markElement(page, selector, pattern))) return false;
  await page.locator('[data-autoapply-click="1"]').first().click({ timeout: 10_000 });
  return true;
}

export async function settle(page: SitePage, ms = 2500): Promise<void> {
  await page.waitForLoadState("domcontentloaded", { timeout: 30_000 }).catch(() => undefined);
  await page.waitForTimeout(ms);
}

export async function waitFor(page: SitePage, test: () => Promise<boolean> | boolean, timeoutMs: number): Promise<boolean> {
  for (let waited = 0; waited <= timeoutMs; waited += 1000) {
    if (await test()) return true;
    await page.waitForTimeout(1000);
  }
  return false;
}

export async function clickEnabledButton(page: SitePage, pattern: string, selector = "button"): Promise<boolean> {
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

/** Questions on the page answered by a radio group in which nothing is selected yet. */
export async function unansweredRadioQuestions(page: SitePage): Promise<string[]> {
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
