import { placeLabel } from "./country.js";
import { usDate } from "./dates.js";
import { attribute, elementInner, inlineText } from "./markup.js";

/**
 * Parsers for iCIMS hosted-portal pages. Portal themes vary per tenant, so
 * every reader accepts the attribute order and label wording seen across
 * live portals and never relies on one exact class list.
 */

export type IcimsCard = {
  id: string;
  url: string;
  title: string;
  /** Labelled header fields ("Job Location", "Category", "Combined Salary Range"). */
  fields: { label: string; value: string }[];
  summary: string;
  postedAt: string | null;
};

const CARD_START = /<li\b[^>]*\bclass\s*=\s*["'][^"']*\biCIMS_JobCardItem\b[^"']*["'][^>]*>/gi;
const POSTING_PATH = /^\/jobs\/(\d{1,12})(?:\/[^/?#]*)?\/job\/?$/;

/** The posting id and canonical URL of an iCIMS posting link on `host`. */
export function icimsPostingLink(href: string, host: string): { id: string; url: string } | null {
  let url: URL;
  try {
    url = new URL(href, `https://${host}`);
  } catch {
    return null;
  }
  const match = POSTING_PATH.exec(url.pathname);
  if (url.hostname.toLowerCase() !== host || !match) return null;
  return { id: match[1]!, url: `https://${host}${url.pathname}` };
}

/** Header fields written as `<dt>Label</dt><dd>Value</dd>` or as a labelled span pair. */
function headerFields(block: string): { label: string; value: string }[] {
  const definitions = [...block.matchAll(/<dt\b[^>]*>([\s\S]*?)<\/dt>\s*<dd\b[^>]*>([\s\S]*?)<\/dd>/gi)]
    .map((match) => ({ label: inlineText(match[1] ?? ""), value: inlineText(match[2] ?? "") }));
  const spans = [...block.matchAll(/<span\b[^>]*class\s*=\s*["'][^"']*(?<![\w-])field-label(?![\w-])[^"']*["'][^>]*>([\s\S]*?)<\/span>\s*<span\b[^>]*>([\s\S]*?)<\/span>/gi)]
    .map((match) => ({ label: inlineText(match[1] ?? ""), value: inlineText(match[2] ?? "") }));
  return [...definitions, ...spans].filter((field) => field.label.length > 0 && field.value.length > 0);
}

/** The "Posted Date" header keeps the absolute date in a title attribute ("11/6/2026 3:32 PM"). */
function postedDate(block: string): string | null {
  const match = /field-label[^>]*>\s*Posted Date\s*<\/span>\s*(<span\b[^>]*>)/i.exec(block);
  const title = match ? attribute(match[1] ?? "", "title") ?? "" : "";
  return usDate(title.split(/\s+/)[0] ?? "");
}

function cardBlocks(html: string): string[] {
  const starts = [...html.matchAll(CARD_START)].map((match) => match.index ?? 0);
  return starts.map((start, index) => {
    const own = elementInner(html, start);
    return own ?? html.slice(start, starts[index + 1] ?? html.length);
  });
}

/** Posting cards on one search-results page, in page order. */
export function parseIcimsCards(html: string, host: string): IcimsCard[] {
  return cardBlocks(html).flatMap((block) => {
    const anchor = /<a\b[^>]*\bhref\s*=\s*["']([^"']*\/jobs\/\d+[^"']*)["'][^>]*>/i.exec(block);
    if (!anchor) return [];
    const link = icimsPostingLink(attribute(anchor[0], "href") ?? "", host);
    if (!link) return [];
    const heading = /<h3\b[^>]*>([\s\S]*?)<\/h3>/i.exec(block);
    const titleAttribute = (attribute(anchor[0], "title") ?? "").replace(/^\d+\s*-\s*/, "");
    const title = inlineText(heading?.[1] ?? "") || titleAttribute;
    if (!title) return [];
    const summary = /<div\b[^>]*class\s*=\s*["'][^"']*\bdescription\b[^"']*["'][^>]*>/i.exec(block);
    return [{
      ...link,
      title,
      fields: headerFields(block).filter((field) => !/^(?:title|posted date)$/i.test(field.label)),
      summary: summary ? inlineText(elementInner(block, summary.index) ?? "") : "",
      postedAt: postedDate(block),
    }];
  });
}

/** Total result pages from the pager's screen-reader text ("of 20"), or null without a pager. */
export function icimsPageCount(html: string): number | null {
  const counts = [...html.matchAll(/<span\b[^>]*class\s*=\s*["']sr-only["'][^>]*>\s*of\s+(\d{1,5})\s*(?:,[^<]*)?<\/span>/gi)]
    .map((match) => Number(match[1]));
  return counts.length > 0 ? Math.max(...counts) : null;
}

/**
 * iCIMS writes locations as "US-MN-Bloomington" (country-region-city). The
 * shared classifier reads "Bloomington, MN, United States" far more reliably,
 * and a foreign region code must not read as a US state.
 */
export function icimsLocation(value: string): string {
  const match = /^([A-Z]{2})-([A-Z0-9]{1,3})-(.+)$/.exec(value.trim());
  return match ? placeLabel({ city: match[3], region: match[2], country: match[1] }) : value.trim();
}

/** Every location named by the card's location fields, normalized. */
export function icimsCardLocations(card: IcimsCard): string[] {
  return card.fields
    .filter((field) => /^(?:job\s+)?locations?\b/i.test(field.label))
    .flatMap((field) => field.value.split(/\s*[|;]\s*/))
    .map(icimsLocation)
    .filter((value) => value.length > 0 && !/^multiple locations$/i.test(value));
}

/** True when the portal answered with its "job could not be found" page. */
export function isIcimsMissingPage(html: string): boolean {
  return /requested job could not be found|either does not exist or is no longer open/i.test(html);
}
