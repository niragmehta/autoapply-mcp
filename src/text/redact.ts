/**
 * Redaction for anything written to logs or audit records.
 *
 * Application history is sensitive: it contains contact details, immigration
 * answers and demographic responses. None of that belongs in a log file.
 *
 * Patterns are anchored so they cannot fire inside longer alphanumeric tokens.
 * Packet and manifest hashes are hex digits, and a phone-shaped run inside one
 * would corrupt the very audit record the log exists to preserve.
 */

const NOT_ALNUM_BEFORE = "(?<![A-Za-z0-9])";
const NOT_ALNUM_AFTER = "(?![A-Za-z0-9])";

const PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]"],
  [
    new RegExp(`${NOT_ALNUM_BEFORE}(?:\\+?\\d{1,2}[\\s.-]?)?\\(?\\d{3}\\)?[\\s.-]?\\d{3}[\\s.-]?\\d{4}${NOT_ALNUM_AFTER}`, "g"),
    "[phone]",
  ],
  [new RegExp(`${NOT_ALNUM_BEFORE}\\d{3}-\\d{2}-\\d{4}${NOT_ALNUM_AFTER}`, "g"), "[gov-id]"],
  [new RegExp(`${NOT_ALNUM_BEFORE}(?:\\d[ -]?){13,16}${NOT_ALNUM_AFTER}`, "g"), "[card]"],
  [/(?:api[_-]?key|token|secret|password|authorization)["'\s:=]+[A-Za-z0-9._~+/-]{8,}/gi, "[secret]"],
];

export function redact(input: string): string {
  return PATTERNS.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), input);
}

/** Categories whose answers must never be persisted in plain text. */
const SENSITIVE_CATEGORIES = new Set([
  "demographic",
  "veteran",
  "disability",
  "criminal-history",
  "citizenship",
  "clearance",
]);

export function isSensitiveCategory(category: string): boolean {
  return SENSITIVE_CATEGORIES.has(category);
}

export function redactAnswerForStorage(category: string, answer: string): string {
  return isSensitiveCategory(category) ? "[withheld: sensitive category]" : answer;
}
