import { isCountryName, placeLabel } from "./country.js";
import { namedMonthDate } from "./dates.js";
import { attribute, inlineText } from "./markup.js";

/**
 * Parsers for Taleo Enterprise Edition career sections. The job-search shell
 * carries the portal number the anonymous search API needs; job pages carry
 * their content in the `initialHistory` form field, a `!|!`-separated,
 * URL-encoded list whose order depends on the tenant's page layout, so fields
 * are recognised by shape rather than position.
 */

/** The career section's portal number, without which the search API refuses requests. */
export function taleoPortal(html: string): string | null {
  const patterns = [/portalNo\s*:\s*['"](\d{3,20})['"]/, /[?&;]portal=(\d{3,20})/, /name=["']portal["'][^>]*value=["'](\d{3,20})/i];
  for (const pattern of patterns) {
    const match = pattern.exec(html);
    if (match?.[1]) return match[1];
  }
  return null;
}

/** Column headings of the search results table, in column order. */
export function taleoHeadings(html: string): string[] {
  const head = /<table\b[^>]*\bid\s*=\s*["']jobs["'][^>]*>[\s\S]*?<thead\b[^>]*>([\s\S]*?)<\/thead>/i.exec(html)?.[1] ?? "";
  return [...head.matchAll(/<th\b[^>]*>([\s\S]*?)<\/th>/gi)]
    .map((match) => inlineText(match[1] ?? ""))
    .filter((label) => label.length > 0 && !/^(?:icons?|actions?)$/i.test(label));
}

/**
 * "United States-Colorado-Denver" as "Denver, Colorado, United States";
 * anything that does not start with a country name comes back unchanged.
 * Only the first two hyphens separate parts, so "Winston-Salem" survives.
 */
export function taleoPlace(value: string): string {
  const match = /^([^-]+)-([^-]+)(?:-(.+))?$/.exec(value.trim());
  if (!match || !isCountryName(match[1]!)) return value.trim();
  const [country, region, city] = match[3] === undefined ? [match[1], "", match[2]] : [match[1], match[2], match[3]];
  return placeLabel({ city, region, country });
}

/**
 * Splits "United States-Arizona-Phoenix, United States-California-Irvine"
 * into its locations. A comma only starts a new location when what follows
 * begins with a country name, so "Washington, D.C." style values stay whole.
 */
function splitPlaces(value: string): string[] {
  const places: string[] = [];
  for (const token of value.split(",").map((part) => part.trim()).filter(Boolean)) {
    const startsNew = places.length === 0 || isCountryName(token.split("-")[0] ?? "") && token.includes("-");
    if (startsNew) places.push(token);
    else places[places.length - 1] = `${places[places.length - 1]}, ${token}`;
  }
  return places;
}

/** A location cell: plain text or the JSON array Taleo groups multi-location postings in. */
export function taleoLocationCell(value: string): string[] {
  let cells = [value];
  if (value.trim().startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (Array.isArray(parsed)) cells = parsed.filter((item): item is string => typeof item === "string");
    } catch {
      cells = [value];
    }
  }
  return cells
    .map((cell) => inlineText(cell))
    .flatMap(splitPlaces)
    .filter((cell) => !/^multiple locations$/i.test(cell))
    .map(taleoPlace);
}

export type TaleoDetail = {
  title: string;
  descriptionHtml: string;
  locations: string[];
  postedAt: string | null;
  employmentType: string | undefined;
};

/** URL-decodes one field, tolerating a literal "%" ("50% travel") that breaks whole-string decoding. */
function decodePart(part: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(part);
  } catch {
    decoded = part.replace(/(?:%[0-9A-Fa-f]{2})+/g, (run) => {
      try {
        return decodeURIComponent(run);
      } catch {
        return run;
      }
    });
  }
  return decoded.replace(/\\(.)/g, "$1");
}

/**
 * Reads a job page's `initialHistory`. Rich-text fields (description,
 * qualifications) are prefixed `!*!`; "Country-Region-City" values are
 * locations; the first spelled-out date is the posting date. Returns null
 * when the page has no job (the field is missing or holds no rich text).
 */
export function parseTaleoDetail(html: string, contestNo: string): TaleoDetail | null {
  const field = /<input\b[^>]*\bname\s*=\s*["']initialHistory["'][^>]*>/i.exec(html)?.[0];
  const value = field ? attribute(field, "value") ?? "" : "";
  if (!value.includes("requisitionDescriptionInterface")) return null;
  const parts = value.split("!|!").map(decodePart);
  const rich = parts.filter((part) => part.startsWith("!*!")).map((part) => part.slice(3));
  if (rich.length === 0) return null;
  const heading = parts.map((part) => /Submission for the position:\s*(.+?)\s*-\s*\(Job Number:\s*([^)]+)\)/.exec(part)).find(Boolean);
  const before = parts[parts.findIndex((part) => part.trim() === contestNo) - 1];
  const places = parts
    .filter((part) => !part.startsWith("!*!") && part.includes("-"))
    .flatMap(splitPlaces)
    .filter((part) => taleoPlace(part) !== part);
  return {
    title: (heading?.[1] ?? before ?? "").trim(),
    descriptionHtml: rich.join("\n<br/>\n"),
    locations: [...new Set(places.map(taleoPlace))],
    postedAt: parts.map((part) => namedMonthDate(part)).find((date) => date !== null) ?? null,
    employmentType: parts.find((part) => /^(?:full|part)[- ]time$/i.test(part.trim()))?.trim(),
  };
}

/** The page Taleo serves for a job that is no longer posted. */
export function isTaleoUnavailable(html: string): boolean {
  return /The job (?:description you are trying to view )?is no longer available/i.test(html);
}
