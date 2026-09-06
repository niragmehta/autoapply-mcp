/** In-page validation reader, shared by submission waiting and field repair. */
export const READ_VALIDATION_ERRORS = `(() => {
  const seen = new Set();
  const out = [];
  const push = (raw) => {
    const text = (raw || "").replace(/\\s+/g, " ").trim();
    if (!text || text.length > 240) return;
    const key = text.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push(text);
  };
  const visible = (el) => {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) return false;
    const style = window.getComputedStyle(el);
    return style.visibility !== "hidden" && style.display !== "none";
  };
  // Live regions also announce uploads, loading and option counts. Those are
  // not validation failures and must not end the post-submit wait early.
  const failure = /\\b(error|invalid|incorrect|failed|missing|required|must)\\b|could not|couldn't|cannot|can't|unable to|something went wrong|too (large|long|short)|not (allowed|supported|valid)/i;
  const request = /^please\\s+(complete|enter|select|provide)\\b/i;
  const conditionalHint = /^please\\s+(select|choose|answer)\\b.{0,160}\\bif\\b/i;
  const informational = /successfully (uploaded|submitted)|(uploaded|submitted) successfully|\\bupload (complete|successful)|\\bapplication (saved|received|submitted|complete)|thank you for applying|^loading\\.*$|^\\d+ (options|results) available/i;
  for (const el of Array.from(document.querySelectorAll('[role="alert"], [aria-live="assertive"], [aria-live="polite"]'))) {
    const text = (el.textContent || "").replace(/\\s+/g, " ").trim();
    const urgent = el.getAttribute("role") === "alert" || el.getAttribute("aria-live") === "assertive";
    if (visible(el) && (failure.test(text) ||
      (!conditionalHint.test(text) && (request.test(text) || (urgent && !informational.test(text)))))) push(text);
  }
  for (const el of Array.from(document.querySelectorAll('[class*="error" i], [class*="invalid" i]'))) {
    if (el.querySelector('[class*="error" i], [class*="invalid" i]')) continue;
    if (visible(el)) push(el.textContent);
  }
  for (const el of Array.from(document.querySelectorAll('[aria-invalid="true"]'))) {
    if (!visible(el)) continue;
    const entry = el.closest('.ashby-application-form-field-entry, fieldset[class*="_fieldEntry_"], .field-entry, label');
    push(entry ? entry.textContent : el.getAttribute("name"));
  }
  // Plain question help is not an error. Unmarked refusals need explicit
  // correction/resubmission wording; error-marked elements are handled above.
  const wording = /needs corrections|missing entry for required field|this field is required|something went wrong|please (complete|enter|select|provide).{0,180}\\bresubmit\\b/i;
  for (const el of Array.from(document.querySelectorAll("li, p, span, div"))) {
    const text = (el.textContent || "").replace(/\\s+/g, " ").trim();
    if (!text || text.length > 240 || !wording.test(text)) continue;
    if (Array.from(el.children).some((child) => wording.test(child.textContent || ""))) continue;
    if (visible(el)) push(text);
  }
  return out.slice(0, 8);
})()`;
