/**
 * Links to job boards, postings and profiles come from third parties, so only
 * http(s) URLs become links; anything else (javascript:, data:, a relative
 * path that would hit this dashboard) is shown as text instead.
 */
export function safeHref(value) {
  try {
    const parsed = new URL(String(value));
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
  } catch {
    return null;
  }
}
