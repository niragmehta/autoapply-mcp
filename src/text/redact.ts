/**
 * Redaction for anything written to logs or audit records.
 *
 * Application history is sensitive: it contains contact details, immigration
 * answers and demographic responses. None of that belongs in a log file.
 */

const PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]"],
  [/(?:\+?\d{1,2}[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}\b/g, "[phone]"],
  [/\b\d{3}-\d{2}-\d{4}\b/g, "[gov-id]"],
  [/\b(?:\d[ -]*?){13,16}\b/g, "[card]"],
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
