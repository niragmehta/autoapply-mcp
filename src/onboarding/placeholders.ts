import { formatPointer } from "./jsonPointer.js";

/**
 * Placeholder detection.
 *
 * The shipped example profile and the test fixtures use recognisable stand-in
 * values. A profile that still contains one would put "Alex Candidate" or
 * "you@example.com" on a real application, so each is reported by location -
 * never by value - for the candidate to replace.
 */

type Marker = { marker: string; test: (value: string) => boolean };

const MARKERS: readonly Marker[] = [
  { marker: "REVIEW", test: (value) => value.includes("REVIEW") },
  { marker: "TODO", test: (value) => /\bTODO\b/.test(value) },
  { marker: "example.com", test: (value) => /example\.com/i.test(value) },
  { marker: "555-01", test: (value) => value.includes("555-01") },
  { marker: "YYYY-MM-DD", test: (value) => /YYYY-MM(-DD)?/.test(value) },
  { marker: "Alex Candidate", test: (value) => /alex candidate/i.test(value) },
  // The shipped example profile's own stand-ins ("Your Full Name"). Short and
  // unpunctuated, so a narrative sentence that happens to start "Your" is not one.
  { marker: "Your ...", test: (value) => value.trim().length <= 40 && /^Your\s+[A-Za-z ]+$/.test(value.trim()) },
  { marker: "path/to", test: (value) => /[\\/]path[\\/]to[\\/]/i.test(value) },
  { marker: "Replace with ...", test: (value) => /^Replace with\b/i.test(value.trim()) },
  { marker: "Describe your ...", test: (value) => /^Describe your\b/i.test(value.trim()) },
];

export function placeholderMarker(value: string): string | null {
  for (const { marker, test } of MARKERS) {
    if (test(value)) return marker;
  }
  return null;
}

export type PlaceholderHit = { path: string; marker: string };

/** Walks every string under `root`, reporting JSON pointers of placeholder values. */
export function findPlaceholders(root: unknown, prefix: readonly string[] = [], skipKeys: ReadonlySet<string> = new Set()): PlaceholderHit[] {
  const hits: PlaceholderHit[] = [];
  const visit = (value: unknown, tokens: readonly string[]): void => {
    if (typeof value === "string") {
      const marker = placeholderMarker(value);
      if (marker) hits.push({ path: formatPointer(tokens), marker });
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => visit(item, [...tokens, String(index)]));
      return;
    }
    if (value && typeof value === "object") {
      for (const [key, child] of Object.entries(value)) {
        if (skipKeys.has(key)) continue;
        visit(child, [...tokens, key]);
      }
    }
  };
  visit(root, prefix);
  return hits;
}
