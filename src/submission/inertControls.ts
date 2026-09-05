type PageEvaluator = { evaluate: (script: string) => Promise<unknown> };

/** Controls made inactive by another answer after the initial form scan. */
export async function inertControlIndexes(page: PageEvaluator, indexes: readonly number[]): Promise<Set<number>> {
  if (indexes.length === 0) return new Set();
  const script = `((wanted) => {
    const out = [];
    for (const index of wanted) {
      const el = document.querySelector('[data-autoapply-idx="' + index + '"]');
      if (!el) continue;
      const entry = el.type === 'checkbox' && (
        el.closest('.ashby-application-form-field-entry') ||
        el.closest('fieldset[class*="_fieldEntry_"]')
      );
      const choices = entry ? Array.from(entry.querySelectorAll('button')).filter((button) => {
        const style = window.getComputedStyle(button);
        return /^(yes|no)$/i.test((button.innerText || '').trim()) &&
          style.display !== 'none' && style.visibility !== 'hidden' &&
          button.getClientRects().length > 0;
      }) : [];
      // Ashby hides the backing checkbox even while the question is active.
      // Only the visible choice buttons can establish that it is disabled.
      if (choices.length > 0) {
        if (choices.every((button) => button.disabled || button.matches(':disabled') ||
          button.getAttribute('aria-disabled') === 'true')) out.push(index);
        continue;
      }
      const style = window.getComputedStyle(el);
      const hidden = style.display === 'none' || style.visibility === 'hidden';
      if (el.disabled || el.readOnly || el.getAttribute('aria-disabled') === 'true' || hidden) out.push(index);
    }
    return out;
  })(${JSON.stringify(indexes)})`;
  try {
    const result = await page.evaluate(script);
    return new Set(Array.isArray(result) ? result.filter((value): value is number => typeof value === "number") : []);
  } catch {
    // Without evidence of inactivity, retain the required-field blocker.
    return new Set();
  }
}
