/** HTML to plain text conversion for ATS job descriptions. */

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "-",
  mdash: "-",
  rsquo: "'",
  lsquo: "'",
  rdquo: '"',
  ldquo: '"',
  hellip: "...",
  bull: "*",
  middot: "*",
};

function decodeEntitiesOnce(input: string): string {
  return input
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => safeCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => safeCodePoint(Number.parseInt(dec, 10)))
    .replace(/&([a-z]+);/gi, (match, name: string) => NAMED_ENTITIES[name.toLowerCase()] ?? match);
}

function safeCodePoint(code: number): string {
  if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return "";
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

/**
 * Greenhouse returns descriptions with HTML entities escaped, sometimes twice,
 * so entity decoding runs before and after tag stripping.
 */
export function htmlToText(input: string): string {
  if (!input) return "";
  const decoded = decodeEntitiesOnce(decodeEntitiesOnce(input));
  const withoutScripts = decoded
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, " ")
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ");
  const withBreaks = withoutScripts
    .replace(/<\s*(br|hr)\s*\/?>/gi, "\n")
    .replace(/<\s*\/\s*(p|div|li|tr|h[1-6]|section|article|ul|ol|table)\s*>/gi, "\n")
    .replace(/<\s*li[^>]*>/gi, "\n- ");
  const stripped = withBreaks.replace(/<[^>]+>/g, " ");
  return normalizeWhitespace(decodeEntitiesOnce(stripped));
}

export function normalizeWhitespace(input: string): string {
  return input
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Lowercased, punctuation-collapsed text used for keyword matching. */
export function normalizeForMatch(input: string): string {
  return input
    .toLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[^a-z0-9+#./'\s-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Returns a short snippet of `text` around the first occurrence of `term`. */
export function snippetAround(text: string, term: string, radius = 90): string {
  const haystack = text.toLowerCase();
  const index = haystack.indexOf(term.toLowerCase());
  if (index < 0) return "";
  const start = Math.max(0, index - radius);
  const end = Math.min(text.length, index + term.length + radius);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < text.length ? "..." : "";
  return `${prefix}${text.slice(start, end).replace(/\s+/g, " ").trim()}${suffix}`;
}
