/** Display formatting shared by every view. */

const numberFormat = new Intl.NumberFormat();
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const dateFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const dateTimeFormat = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });

export function num(value) {
  return value === null || value === undefined || Number.isNaN(Number(value)) ? "-" : numberFormat.format(Number(value));
}

function toDate(iso) {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function clock(iso) {
  const date = toDate(iso);
  return date ? timeFormat.format(date) : "-";
}

export function dateTime(iso) {
  const date = toDate(iso);
  return date ? dateTimeFormat.format(date) : "-";
}

/** "just now", "12 min ago", "3 h ago", "yesterday", then a date. */
export function ago(iso, now = Date.now()) {
  const date = toDate(iso);
  if (!date) return "-";
  const seconds = Math.round((now - date.getTime()) / 1000);
  if (seconds < 45) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)} min ago`;
  if (seconds < 86_400) return `${Math.round(seconds / 3600)} h ago`;
  if (seconds < 172_800) return "yesterday";
  return dateFormat.format(date);
}

export function duration(fromIso, toIso) {
  const from = toDate(fromIso);
  const to = toIso ? toDate(toIso) : new Date();
  if (!from || !to) return "-";
  const seconds = Math.max(0, Math.round((to.getTime() - from.getTime()) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export function plural(count, one, many = `${one}s`) {
  return `${num(count)} ${count === 1 ? one : many}`;
}

export function bytes(value) {
  if (!Number.isFinite(value) || value <= 0) return "0 KB";
  if (value < 1024 * 1024) return `${num(Math.ceil(value / 1024))} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

const LABELS = {
  needs_human: "Needs human",
  awaiting_approval: "Awaiting approval",
  recruiter_screen: "Recruiter screen",
  "approved-answer": "Approved answer",
  "bay-area": "Bay Area",
  "us-other": "US (other)",
  "remote-us": "Remote US",
  "remote-canada": "Remote Canada",
  "remote-global": "Remote global",
  accept: "Accepted",
  reject: "Rejected",
  review: "Review",
  posting_closed: "Posting closed",
  sent_by_user: "Sent by you",
  linkedin_connect: "LinkedIn connection note",
  linkedin_message: "LinkedIn message",
  referral_request: "Referral request",
  follow_up: "Follow-up",
  hiring_manager: "Hiring manager",
  system_design: "System design",
  redflag: "Red flag",
  redflags: "Red flags",
  funded: "Funding news",
  "linkedin-alert": "LinkedIn alert",
  "common-crawl": "Common Crawl",
  "close-stale": "Close stale",
  "no-match": "No match",
  "strong-apply": "Strong apply",
  "apply-with-reason": "Apply with reason",
  "do-not-apply": "Do not apply",
  companyTier: "Company tier",
  scoreBand: "Score band",
  locationClass: "Location",
  submissionMode: "Submission mode",
  weekSubmitted: "Week submitted",
  ats: "Board type",
};

/** A status or enum value as words. */
export function label(value) {
  if (value === null || value === undefined || value === "") return "-";
  const known = LABELS[value];
  if (known) return known;
  const words = String(value)
    .replace(/([a-z])([A-Z])/g, (_, before, after) => `${before} ${after.toLowerCase()}`)
    .replace(/[_-]+/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

const TONES = {
  submitted: "ok",
  succeeded: "ok",
  accept: "ok",
  offer: "ok",
  interview: "ok",
  recruiter_screen: "ok",
  assessment: "ok",
  open: "ok",
  recorded: "ok",
  resolved: "ok",
  matching: "ok",
  done: "ok",
  accepted: "ok",
  sent_by_user: "ok",
  high: "ok",
  "strong-apply": "ok",
  apply: "ok",
  failed: "bad",
  reject: "bad",
  rejected: "bad",
  closed: "bad",
  posting_closed: "bad",
  dead: "bad",
  error: "bad",
  suspicious: "bad",
  "do-not-apply": "bad",
  needs_human: "held",
  blocked: "held",
  running: "info",
  queued: "info",
  approved: "info",
  awaiting_approval: "info",
  proposed: "info",
  new: "info",
  scheduled: "info",
  received: "info",
  draft: "info",
  tracked: "info",
  first: "info",
  second: "info",
  review: "warn",
  interrupted: "warn",
  ghosted: "warn",
  caution: "warn",
  negotiating: "warn",
  close: "warn",
  "apply-with-reason": "warn",
  acknowledged: "muted",
  cancelled: "muted",
  skipped: "muted",
  drafted: "muted",
  withdrawn: "muted",
  dismissed: "muted",
  ignored: "muted",
  discarded: "muted",
  declined: "muted",
  expired: "muted",
  unknown: "muted",
};

export function tone(value) {
  return TONES[value] ?? "muted";
}

/** "in 2 days", "today", "3 days ago" from a fractional day count. */
export function inDays(days) {
  if (days === null || days === undefined || Number.isNaN(Number(days))) return "-";
  const whole = Math.round(Number(days));
  if (whole === 0) return "today";
  if (whole === 1) return "tomorrow";
  if (whole === -1) return "yesterday";
  return whole > 0 ? `in ${whole} days` : `${Math.abs(whole)} days ago`;
}

const dayFormat = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" });

/** "Tue, Nov 10, 10:00" for scheduled times. */
export function when(iso) {
  const date = toDate(iso);
  return date ? `${dayFormat.format(date)}, ${timeFormat.format(date)}` : "-";
}

export function money(value, currency) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return "-";
  try {
    return new Intl.NumberFormat(undefined, { style: "currency", currency: currency || "USD", maximumFractionDigits: 0 }).format(Number(value));
  } catch {
    return `${num(Math.round(Number(value)))} ${currency ?? ""}`.trim();
  }
}

export function shortId(id) {
  if (!id) return "";
  const [prefix, rest = ""] = String(id).split("_");
  return rest ? `${prefix}_${rest.slice(0, 6)}` : String(id).slice(0, 10);
}
