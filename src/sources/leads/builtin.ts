import { decodeEntitiesOnce, htmlToText } from "../../text/html.js";
import { fetchText } from "../http.js";
import { leadSalary, parseSourceSearchInput } from "../leadTypes.js";
import type { JobLead, LeadSalary, SourceAttribution, SourceSearchInput, SourceSearchResult } from "../leadTypes.js";
import { jsonLdNodes } from "../smb/jsonLd.js";
import { isWildcardQuery } from "../smb/query.js";
import {
  buildLead, cachedFetch, containsText, httpsUrl, openEndedPagination, parseRows, skippedNotice, unsupportedFilter,
} from "./common.js";

/**
 * Built In US tech job boards (builtin.com and its city market sites).
 *
 * Reads one server-rendered listing page per request. Only URL shapes the
 * site's robots.txt permits are built: category pages and their path-based
 * keyword pages (`/jobs/<category>/search/<keyword>`), never `?search=`
 * queries, and pages 1-3 only. Each page carries a schema.org ItemList
 * (title, link, summary) joined with the rendered job cards (company,
 * workplace, location, posted badge, salary band) by Built In's job id.
 * Card fields that cannot be read stay empty rather than guessed.
 *
 * Endpoint behaviour adapted from career-ops (MIT).
 */

const MARKETS: ReadonlyMap<string, string> = new Map([
  ["builtin.com", "builtin.com"], ["www.builtin.com", "builtin.com"],
  ...["builtinsf.com", "builtinnyc.com", "builtinla.com", "builtinboston.com", "builtinaustin.com",
    "builtinchicago.org", "builtincolorado.com", "builtinseattle.com"].flatMap((domain): Array<[string, string]> =>
    [[domain, `www.${domain}`], [`www.${domain}`, `www.${domain}`]]),
]);
const CATEGORIES = [
  "artificial-intelligence", "content", "customer-success", "cybersecurity-it", "data-analytics", "design-ux",
  "dev-engineering", "finance", "hr", "legal", "marketing", "operations", "product", "project-management", "sales",
] as const;
const SCOPES = ["remote", "hybrid"] as const;
const MAX_PAGE = 3;
const PAGE_SIZE = 25;
const CACHE_TTL_MS = 15 * 60_000;
const MIN_INTERVAL_MS = 2_000;
const CARD_SPAN = 12_000;

type Card = { company: string; workplace: string; places: string[]; posted: string; salary: string };
type Listing = { id: string; title: string; url: string; summary: string };

const ATTRIBUTION: SourceAttribution = {
  label: "Built In",
  url: "https://builtin.com",
  changes: "Listing-page items normalized into unverified job leads; card fields read only where present.",
  requirements: [
    "Credit Built In and link each lead to its Built In job page.",
    "Do not copy or republish Built In listings.",
  ],
};
const LIMITATIONS = [
  "Built In's Community Terms of Use prohibit accessing or copying the site with bots, scrapers or other automated means. This reads one robots.txt-permitted listing page per explicit request, never crawls, and returns links for a person to open; do not use it for bulk collection.",
  `Requires category, one of: ${CATEGORIES.join(", ")}. Query becomes Built In's path-based keyword page within that category ("*" lists the category).`,
  "Site selects the market (builtin.com, www.builtinsf.com, www.builtinnyc.com, ...); location accepts only \"remote\" or \"hybrid\".",
  "Pages 1-3 only (the market sites' robots.txt). Up to 25 jobs a page; no total is reported, so pagination.total is a lower bound.",
  "Summaries are Built In's ~400-character excerpts. Salary bands carry no currency; posting ages are approximate and reposts have no date.",
  "Verify each lead on the employer's own careers site before preparing an application.",
] as const;

function market(site: string | undefined): string {
  if (!site) return "builtin.com";
  let host = site.trim().toLowerCase();
  if (host.includes("/")) {
    try {
      host = new URL(host.includes("://") ? host : `https://${host}`).hostname;
    } catch {
      host = "";
    }
  }
  const canonical = MARKETS.get(host);
  if (!canonical) throw unsupportedFilter("Built In", "site", `Use one of: ${[...new Set(MARKETS.values())].join(", ")}.`);
  return canonical;
}

function keywordSlug(query: string): string {
  return query.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 80);
}

export function builtInUrl(search: { query: string; category?: string; location?: string; site?: string; page?: number }): string {
  const host = market(search.site);
  const category = (search.category ?? "").trim().toLowerCase();
  if (!(CATEGORIES as readonly string[]).includes(category)) {
    throw unsupportedFilter("Built In", "category", `Category is required and must be one of: ${CATEGORIES.join(", ")}.`);
  }
  const scope = search.location?.trim().toLowerCase();
  if (scope && !(SCOPES as readonly string[]).includes(scope)) {
    throw unsupportedFilter("Built In", "location", "Only \"remote\" or \"hybrid\" are supported; use site for a city market.");
  }
  const page = search.page ?? 1;
  if (page > MAX_PAGE) throw unsupportedFilter("Built In", "page", `Built In's robots.txt permits pages 1-${MAX_PAGE} only.`);
  const keyword = isWildcardQuery(search.query) ? "" : keywordSlug(search.query);
  return `https://${host}/jobs${scope ? `/${scope}` : ""}/${category}${keyword ? `/search/${keyword}` : ""}${page > 1 ? `?page=${page}` : ""}`;
}

/** The page's schema.org ItemList, the stable half of a listing page. */
export function builtInListings(html: string, host: string): unknown[] {
  const list = jsonLdNodes(html).find((node) => node["@type"] === "ItemList");
  const items = Array.isArray(list?.itemListElement) ? list.itemListElement : [];
  return items.map((item) => {
    const entry = item && typeof item === "object" ? item as Record<string, unknown> : {};
    const url = httpsUrl(entry.url, [host.replace(/^www\./, "")]);
    const id = url ? /\/(\d+)(?:[/?#]|$)/.exec(new URL(url).pathname)?.[1] : undefined;
    const title = typeof entry.name === "string" ? decodeEntitiesOnce(entry.name).trim() : "";
    return url && id && title ? { id, title, url, summary: typeof entry.description === "string" ? entry.description : "" } : null;
  });
}

function textAfter(segment: string, icon: string): string {
  const at = segment.indexOf(icon);
  if (at < 0) return "";
  for (const match of segment.slice(at, at + 700).matchAll(/>([^<>]+)</g)) {
    const text = htmlToText(match[1] ?? "").trim();
    if (text) return text;
  }
  return "";
}

/** Company, workplace, places, posted badge and salary band for each rendered card, keyed by job id. */
export function builtInCards(html: string): Map<string, Card> {
  const starts = [...html.matchAll(/data-id="job-card-title"/g)].map((match) => match.index ?? 0);
  return new Map(starts.flatMap((start, index): Array<[string, Card]> => {
    const segment = html.slice(start, Math.min(starts[index + 1] ?? html.length, start + CARD_SPAN));
    const id = /data-builtin-track-job-id="(\d+)"/.exec(segment)?.[1];
    if (!id) return [];
    const company = new RegExp(`data-id="company-title"[^>]*data-builtin-track-job-id="${id}"[^>]*>([\\s\\S]{0,300}?)</a>`).exec(html)?.[1];
    const location = textAfter(segment, "fa-location-dot");
    const tooltip = /aria-label="Job locations"[^>]*data-bs-title="([^"]*)"/.exec(segment)?.[1];
    const places = /^\d+\s+Locations?$/i.test(location) || !location
      ? (tooltip ? decodeEntitiesOnce(tooltip).split(/<\/div>|<br\s*\/?>/i).map((part) => htmlToText(part).trim()).filter(Boolean) : [])
      : [location];
    return [[id, {
      company: company ? htmlToText(company).trim() : "",
      workplace: textAfter(segment, "fa-house-building"),
      places,
      posted: textAfter(segment, "fa-clock"),
      salary: textAfter(segment, "fa-sack-dollar"),
    }]];
  }));
}

const UNITS: Readonly<Record<string, number>> = { minute: 60_000, hour: 3_600_000, day: 86_400_000, week: 604_800_000, month: 2_592_000_000 };

/** Converts an exact badge such as "3 Days Ago"; reposts and capped ages ("30+") have no publication date. */
export function postedAt(badge: string, now: number): string | undefined {
  const text = badge.trim();
  if (/^reposted\b/i.test(text) || /\+/.test(text)) return undefined;
  if (/^(?:today|just posted)$/i.test(text)) return new Date(now).toISOString();
  if (/^yesterday$/i.test(text)) return new Date(now - 86_400_000).toISOString();
  const match = /^(\d+|an?|one)\s+(minute|hour|day|week|month)s?\s+ago$/i.exec(text);
  if (!match?.[1] || !match[2]) return undefined;
  const count = /^(?:an?|one)$/i.test(match[1]) ? 1 : Number(match[1]);
  return new Date(now - count * (UNITS[match[2].toLowerCase()] ?? 0)).toISOString();
}

/** "170K-230K Annually" keeps its stated unit; implausible hourly bands (a Built In data error) are dropped. */
export function salaryBand(text: string): LeadSalary | undefined {
  const match = /^\$?(\d+(?:\.\d+)?)(K)?(?:\s*-\s*\$?(\d+(?:\.\d+)?)(K)?)?\s+(Annually|Hourly|Monthly)$/i.exec(text.trim());
  if (!match?.[1] || !match[5]) return undefined;
  const low = Number(match[1]) * (match[2] ? 1000 : 1);
  const high = match[3] ? Number(match[3]) * (match[4] ? 1000 : 1) : low;
  if (/hourly/i.test(match[5]) && high > 1000) return undefined;
  return leadSalary(low, high, undefined, match[5]);
}

function toLead(listing: Listing, card: Card | undefined, endpoint: string, retrievedAt: string): JobLead {
  const workplace = card?.workplace ?? "";
  const places = card?.places ?? [];
  return buildLead("builtin", endpoint, retrievedAt, {
    sourceId: listing.id,
    sourceUrl: listing.url,
    title: listing.title,
    company: card?.company ?? "",
    locations: places.length ? places.map((place) => (workplace ? `${place} (${workplace})` : place)) : workplace ? [workplace] : [],
    locationRestrictions: [],
    timezoneRestrictions: [],
    description: listing.summary,
    salary: card?.salary ? salaryBand(card.salary) : undefined,
    publishedAt: card?.posted ? postedAt(card.posted, Date.parse(retrievedAt)) : undefined,
    publishedAtRaw: card?.posted || undefined,
  });
}

export async function searchBuiltIn(input: SourceSearchInput): Promise<SourceSearchResult> {
  const search = parseSourceSearchInput(input);
  const url = builtInUrl(search);
  const host = new URL(url).hostname;
  const { value: html, retrievedAt } = await cachedFetch(url, CACHE_TTL_MS, () =>
    fetchText(url, { allowedHosts: [host], maxBytes: 8 * 1024 * 1024, minIntervalMs: MIN_INTERVAL_MS }));
  const rows = builtInListings(html, host);
  const { items, skipped } = rows.length ? parseRows(rows, (row) => row as Listing | null, "builtin") : { items: [], skipped: 0 };
  const cards = builtInCards(html);
  const all = items.map((listing) => toLead(listing, cards.get(listing.id), url, retrievedAt))
    .filter((lead) => containsText(lead.company, search.company));
  const leads = all.slice(0, search.limit);
  const page = search.page ?? 1;
  return {
    source: "builtin", readiness: "ready", leads,
    pagination: openEndedPagination(page, PAGE_SIZE, all.length, leads.length, rows.length >= PAGE_SIZE && page < MAX_PAGE),
    attribution: ATTRIBUTION,
    limitations: [...LIMITATIONS, ...skippedNotice(skipped), ...(cards.size === 0 && items.length > 0
      ? ["Job cards could not be read on this page; company, location and salary are empty."] : [])],
  };
}
