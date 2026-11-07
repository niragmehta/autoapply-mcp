import { z } from "zod";
import { countryCode, placeLabel } from "./country.js";
import { anyDate, namedMonthDate, usDate } from "./dates.js";
import { readJobPosting } from "./jobPosting.js";
import type { JobPostingFields } from "./jobPosting.js";
import { attribute, attributeText, elementInner, findJobPosting, inlineText } from "./markup.js";

/**
 * Parsers for SAP SuccessFactors Recruiting Marketing (RMK) career sites and
 * their newer Career Site Builder (CSB) search API. RMK renders three copies
 * of each tile (desktop, tablet, mobile); the first copy of each field wins.
 */

export type SuccessFactorsTile = {
  id: string;
  path: string;
  title: string;
  location: string;
  postedAt: string | null;
};

const TILE = /<li\b[^>]*\bclass\s*=\s*["'][^"']*\bjob-tile\b[^"']*\bjob-id-(\d+)\b[^"']*["'][^>]*>/gi;
const ERROR_PAGE = /\/errorpage\/?\?errortype=/i;

/** Section values a tenant chose to show on a tile, keyed by section name ("city", "date"). */
function tileSections(block: string): Map<string, string> {
  const sections = new Map<string, string>();
  for (const match of block.matchAll(/id\s*=\s*["'][^"']*-section-([a-z0-9_]+)-value["'][^>]*>([\s\S]*?)<\/div>/gi)) {
    const name = match[1]!.toLowerCase();
    const value = inlineText(match[2] ?? "");
    if (value && !sections.has(name)) sections.set(name, value);
  }
  return sections;
}

/**
 * The place an RMK slug encodes, "/job/{City-Words}-{Title-Words}-{ST}-{ZIP}/{id}/",
 * for tenants whose tiles show no location. The city is everything before the
 * first two title words; a trailing two-letter region and five-digit ZIP are
 * kept as written. Returns "" when the slug does not line up with the title.
 */
export function slugLocation(path: string, title: string): string {
  let segment: string;
  try {
    segment = decodeURIComponent(/\/job\/([^/]+)\//.exec(path)?.[1] ?? "");
  } catch {
    return "";
  }
  const words = segment.split("-").filter((word) => word.length > 0);
  const titleWords = title.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  const anchor = titleWords.slice(0, 2);
  const normalize = (word: string) => word.toLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
  const start = words.findIndex((_word, index) =>
    anchor.length > 0 && anchor.every((titleWord, offset) => normalize(words[index + offset] ?? "") === titleWord));
  if (start <= 0) return "";
  const city = words.slice(0, start).join(" ");
  const tail = /^([A-Z]{2})-(\d{5})$/.exec(words.slice(-2).join("-"));
  return tail ? `${city}, ${tail[1]} ${tail[2]}` : city;
}

/** Posting tiles from one `/tile-search-results/` fragment. */
export function parseSuccessFactorsTiles(html: string): SuccessFactorsTile[] {
  return [...html.matchAll(TILE)].flatMap((match) => {
    const block = elementInner(html, match.index ?? 0) ?? "";
    const path = attributeText(attribute(match[0], "data-url") ?? "");
    const title = inlineText(/class\s*=\s*["'][^"']*\bjobTitle-link\b[^"']*["'][^>]*>([\s\S]*?)<\/a>/i.exec(block)?.[1] ?? "");
    if (!path.startsWith("/") || !title) return [];
    const sections = tileSections(block);
    const place = sections.get("location")
      ?? [sections.get("city"), sections.get("state"), sections.get("country")].filter(Boolean).join(", ");
    const date = sections.get("date") ?? "";
    return [{
      id: match[1]!,
      path,
      title,
      location: place || slugLocation(path, title),
      postedAt: namedMonthDate(date) ?? usDate(date),
    }];
  });
}

function meta(html: string, property: string): string {
  const tag = new RegExp(`<meta\\b[^>]*\\bitemprop\\s*=\\s*["']${property}["'][^>]*>`, "i").exec(html)?.[0] ?? "";
  return attribute(tag, "content") ?? "";
}

/**
 * The posting on an RMK job page: its schema.org JSON-LD when present,
 * otherwise the JobPosting microdata RMK renders around the description.
 * Null when the page carries neither.
 */
export function parseSuccessFactorsPosting(html: string): JobPostingFields | null {
  const ld = findJobPosting(html);
  if (ld) return readJobPosting(ld);
  const description = /<[a-z]+\b[^>]*\bitemprop\s*=\s*["']description["'][^>]*>/i.exec(html);
  if (!description) return null;
  const title = /<[a-z]+\b[^>]*\bitemprop\s*=\s*["']title["'][^>]*>([\s\S]*?)<\/[a-z]+>/i.exec(html);
  const country = meta(html, "addressCountry");
  const place = placeLabel({ city: meta(html, "addressLocality"), region: meta(html, "addressRegion"), country });
  return {
    title: inlineText(title?.[1] ?? ""),
    descriptionHtml: elementInner(html, description.index) ?? "",
    postedAt: anyDate(meta(html, "datePosted")),
    validThrough: null,
    locations: place ? [place] : [],
    country: countryCode(country),
    employmentType: undefined,
    isRemote: false,
    compensation: null,
  };
}

/** True for the career site's error page, which is where RMK sends a removed posting. */
export function isSuccessFactorsErrorPage(html: string): boolean {
  return ERROR_PAGE.test(html) && !/\bitemprop\s*=\s*["']description["']/i.test(html);
}

const csbRowSchema = z.object({
  response: z.object({
    id: z.union([z.string(), z.number()]).transform(String).pipe(z.string().regex(/^\d{1,20}$/)),
    unifiedStandardTitle: z.string().nullish(),
    jobTitle: z.string().nullish(),
    unifiedUrlTitle: z.string().nullish(),
    urlTitle: z.string().nullish(),
    unifiedStandardStart: z.string().nullish(),
    jobLocationShort: z.union([z.array(z.string()), z.string()]).nullish(),
  }),
});
export type CsbRow = z.infer<typeof csbRowSchema>["response"];

export const csbPageSchema = z.object({
  jobSearchResult: z.array(z.unknown()),
  totalJobs: z.number().nullish(),
});

export function csbRow(value: unknown): CsbRow | null {
  const result = csbRowSchema.safeParse(value);
  return result.success ? result.data.response : null;
}

/** CSB writes each location as "Bend, OR, USA, <br/>"; the trailing comma and markup go. */
export function csbLocations(row: CsbRow): string[] {
  const raw = Array.isArray(row.jobLocationShort) ? row.jobLocationShort : row.jobLocationShort ? [row.jobLocationShort] : [];
  return [...new Set(raw.map((value) => inlineText(value).replace(/[,\s]+$/, "")).filter((value) => value.length > 0))];
}

/** The slug CSB builds its job URLs from, with characters that would break the path removed. */
export function csbSlug(row: CsbRow): string {
  const slug = attributeText(row.unifiedUrlTitle ?? row.urlTitle ?? "job").replace(/[\s?#&/\\]+/g, "-").replace(/-{2,}/g, "-");
  return slug || "job";
}
