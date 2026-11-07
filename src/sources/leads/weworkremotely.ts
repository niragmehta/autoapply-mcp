import { fetchText } from "../http.js";
import { SOURCE_MIN_INTERVAL_MS, parseSourceSearchInput } from "../leadTypes.js";
import type { JobLead, SourceAttribution, SourceSearchInput, SourceSearchResult } from "../leadTypes.js";
import { absoluteDate } from "../smb/dates.js";
import { matchesQuery } from "../smb/query.js";
import { parseFeedXml, xmlText } from "../smb/xml.js";
import {
  buildLead, cachedFetch, containsText, httpsUrl, matchesCountry, pageSlice, parseRows, skippedNotice, unsupportedFilter,
} from "./common.js";

/**
 * We Work Remotely public RSS feeds.
 * https://weworkremotely.com/remote-job-rss-feed
 *
 * WWR lets anyone use its feeds as long as listings link back to it. The
 * all-jobs feed (or one category feed) is fetched at most hourly — the feed's
 * own `<ttl>` — and filtered locally. Item titles read "Company: Role".
 *
 * Endpoint behaviour adapted from career-ops (MIT).
 */

const HOST = "weworkremotely.com";
const ALL_JOBS = `https://${HOST}/remote-jobs.rss`;
const CACHE_TTL_MS = 60 * 60_000;
const CATEGORY = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

type Item = {
  title: string;
  company: string;
  link: string;
  region: string;
  country: string;
  state: string;
  skills: string;
  category: string;
  type: string;
  description: string;
  pubDate: string;
  expiresAt: string | null;
};

const ATTRIBUTION: SourceAttribution = {
  label: "We Work Remotely",
  url: "https://weworkremotely.com",
  changes: "RSS items normalized into unverified job leads; company split from the item title.",
  requirements: [
    "Attribute each listing to We Work Remotely and link back to its We Work Remotely page.",
    "Do not republish We Work Remotely listings as your own job board.",
  ],
};
const LIMITATIONS = [
  "Reads one public RSS feed (all jobs, or one category feed via category, e.g. remote-back-end-programming-jobs) and filters it locally.",
  "Feeds are cached for 60 minutes, matching the feed's TTL.",
  "Region text is WWR's own (e.g. \"Anywhere in the World\", \"USA Only\"); worldwide or unspecified listings are kept for any country.",
  "Verify each lead on the employer's own careers site before preparing an application.",
] as const;

function feedUrl(category: string | undefined): string {
  if (!category) return ALL_JOBS;
  if (!CATEGORY.test(category)) throw unsupportedFilter("We Work Remotely", "category", "Use a feed slug such as remote-full-stack-programming-jobs.");
  return `https://${HOST}/categories/${category}.rss`;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** WWR prefixes countries with a flag emoji ("🇺🇸 United States of America"). */
function withoutFlags(value: string): string {
  return value.replace(/[\u{1F1E6}-\u{1F1FF}]{2}\s*/gu, "").trim();
}

/** RSS items; the title's "Company: Role" form is split when present. */
export function parseWwrFeed(xml: string): unknown[] {
  const channel = record(record(record(parseFeedXml(xml, "We Work Remotely", (path) => path === "rss.channel.item")).rss).channel);
  return Array.isArray(channel.item) ? channel.item : [];
}

function readItem(raw: unknown): Item | null {
  const item = record(raw);
  const rawTitle = xmlText(item.title);
  const link = httpsUrl(xmlText(item.link), [HOST]);
  if (!rawTitle || !link) return null;
  const split = /^([^:]{1,120}):\s+(.+)$/.exec(rawTitle);
  return {
    title: (split?.[2] ?? rawTitle).trim(),
    company: (split?.[1] ?? "").trim(),
    link,
    region: withoutFlags(xmlText(item.region)),
    country: withoutFlags(xmlText(item.country)),
    state: xmlText(item.state),
    skills: xmlText(item.skills),
    category: xmlText(item.category),
    type: xmlText(item.type),
    description: xmlText(item.description),
    pubDate: xmlText(item.pubDate),
    expiresAt: absoluteDate(xmlText(item.expires_at)),
  };
}

function eligibility(item: Item): string {
  return [item.region, item.country, item.state].filter(Boolean).join(", ");
}

function toLead(item: Item, endpoint: string, retrievedAt: string): JobLead {
  const area = eligibility(item);
  return buildLead("weworkremotely", endpoint, retrievedAt, {
    sourceId: item.link,
    sourceUrl: item.link,
    title: item.title,
    company: item.company,
    locations: [area ? `Remote — ${area}` : "Remote — location restrictions unspecified"],
    locationRestrictions: [item.region, item.country].filter(Boolean),
    timezoneRestrictions: [],
    description: item.description,
    publishedAt: absoluteDate(item.pubDate) ?? undefined,
    publishedAtRaw: item.pubDate || undefined,
  });
}

export async function searchWeWorkRemotely(input: SourceSearchInput): Promise<SourceSearchResult> {
  const search = parseSourceSearchInput(input);
  const url = feedUrl(search.category);
  const { value: xml, retrievedAt } = await cachedFetch(url, CACHE_TTL_MS, () =>
    fetchText(url, { allowedHosts: [HOST], accept: "application/rss+xml, application/xml", minIntervalMs: SOURCE_MIN_INTERVAL_MS }));
  const { items, skipped } = parseRows(parseWwrFeed(xml), readItem, "weworkremotely");
  const now = Date.now();
  const matches = items.filter((item) =>
    (item.expiresAt === null || Date.parse(item.expiresAt) > now)
    && matchesQuery(search.query, item.title, item.skills, item.category)
    && matchesCountry(eligibility(item), search.country)
    && containsText(eligibility(item), search.location)
    && containsText(item.company, search.company)).map((item) => toLead(item, url, retrievedAt));
  const { items: leads, pagination } = pageSlice(matches, search.page ?? 1, search.limit);
  return {
    source: "weworkremotely", readiness: "ready", leads, pagination, attribution: ATTRIBUTION,
    limitations: [...LIMITATIONS, ...skippedNotice(skipped)],
  };
}
