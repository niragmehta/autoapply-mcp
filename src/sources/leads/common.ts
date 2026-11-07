import type { CompensationRange } from "../../domain/job.js";
import { decodeEntitiesOnce } from "../../text/html.js";
import { AppError } from "../../util/errors.js";
import { SOURCE_SEARCH_MAX_LIMIT, sourcePagination } from "../leadTypes.js";
import type { JobLead, LeadSalary, SearchSourceId, SourcePagination } from "../leadTypes.js";
import { countryCode } from "../smb/geo.js";

/**
 * Shared plumbing for aggregator lead sources: a short-lived response cache,
 * local filters for feeds without server-side search, and pagination for
 * feeds that report no totals.
 */

type CacheEntry = { value: unknown; retrievedAt: string; expires: number };
const MAX_CACHE_ENTRIES = 64;
let cache = new Map<string, CacheEntry>();

/**
 * Reuses a recent response for the same request. Whole-feed sources ask to be
 * fetched rarely (Remotive: a few times a day; We Work Remotely: TTL 60), so a
 * repeated or refined search is served from memory instead of the network.
 */
export async function cachedFetch<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<{ value: T; retrievedAt: string }> {
  const hit = cache.get(key);
  if (hit && hit.expires > Date.now()) return { value: hit.value as T, retrievedAt: hit.retrievedAt };
  const value = await load();
  const retrievedAt = new Date().toISOString();
  const live = [...cache].filter(([, entry]) => entry.expires > Date.now()).slice(-(MAX_CACHE_ENTRIES - 1));
  cache = new Map([...live, [key, { value, retrievedAt, expires: Date.now() + ttlMs }]]);
  return { value, retrievedAt };
}

/** Test hook: forget every cached response. */
export function clearLeadCache(): void {
  cache = new Map();
}

export function unsupportedFilter(source: string, filter: string, hint: string): AppError {
  return new AppError("source_filter_unsupported", `${source} does not support the ${filter} filter. ${hint}`.trim());
}

const WORLDWIDE = /\b(?:worldwide|anywhere|global|international)\b/i;
const US_TEXT = /\b(?:us|u\.s\.(?:a\.)?|usa|united states|america|americas|north america)\b/i;
const CA_TEXT = /\b(?:canada|canadian|americas|north america)\b/i;

/**
 * Whether a lead's eligibility text admits the requested country. Worldwide
 * and unspecified eligibility are kept: they are leads, verified later, and
 * dropping them would hide real openings.
 */
export function matchesCountry(text: string, country: string | undefined): boolean {
  if (!country || !text.trim() || WORLDWIDE.test(text)) return true;
  const code = countryCode(country);
  if (code === "US") return US_TEXT.test(text);
  if (code === "CA") return CA_TEXT.test(text);
  return text.toLowerCase().includes(country.trim().toLowerCase());
}

export function containsText(text: string, needle: string | undefined): boolean {
  return !needle || text.toLowerCase().includes(needle.trim().toLowerCase());
}

/** Pages a locally filtered list, so totals describe the filtered result. */
export function pageSlice<T>(items: readonly T[], page: number, limit: number): { items: T[]; pagination: SourcePagination } {
  const start = (page - 1) * limit;
  const slice = items.slice(start, start + limit);
  return {
    items: slice,
    pagination: sourcePagination(page, limit, slice.length, slice.length, items.length, Math.ceil(items.length / limit)),
  };
}

/**
 * Pagination for feeds that report no total. `total` is a lower bound (what
 * has been seen so far); `hasMore` comes from the provider's own signal.
 */
export function openEndedPagination(
  page: number, pageSize: number, received: number, returned: number, providerHasMore: boolean,
): SourcePagination {
  const remainingOnPage = received - returned;
  const truncated = remainingOnPage > 0;
  return {
    page, pageSize, returned,
    total: (page - 1) * pageSize + received,
    totalPages: providerHasMore ? page + 1 : page,
    hasMore: truncated || providerHasMore,
    truncated, remainingOnPage,
    ...(truncated
      ? { nextPage: page, nextPageLimit: Math.min(SOURCE_SEARCH_MAX_LIMIT, Math.max(pageSize, received)) }
      : providerHasMore ? { nextPage: page + 1 } : {}),
  };
}

/** Plain-text fields some feeds deliver entity-encoded ("Zone &#038; Co"). */
export function plain(value: unknown): string {
  return typeof value === "string" ? decodeEntitiesOnce(value).replace(/\s+/g, " ").trim() : "";
}

const MOJIBAKE = /Ã[\u0080-\u00bf]|â\u0080|Â[\u0080-\u00bf ]/;

/** Repairs UTF-8 text that a feed double-encoded as Latin-1 ("MÃ¼nchen"). */
export function repairMojibake(value: string): string {
  if (!MOJIBAKE.test(value)) return value;
  const repaired = Buffer.from(value, "latin1").toString("utf8");
  return repaired.includes("\uFFFD") ? value : repaired;
}

/** An HTTPS URL without credentials, optionally restricted to given hosts (and their subdomains). */
export function httpsUrl(value: unknown, hosts?: readonly string[]): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  try {
    const url = new URL(value.trim());
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || url.username || url.password || url.port) return undefined;
    if (hosts && !hosts.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))) return undefined;
    return url.href;
  } catch {
    return undefined;
  }
}

/** Aggregator salary with only explicit units; an unknown period is left unset. */
export function salaryFromRange(range: CompensationRange | null): LeadSalary | undefined {
  if (!range || (range.min === null && range.max === null)) return undefined;
  return {
    ...(range.min === null ? {} : { min: range.min }),
    ...(range.max === null ? {} : { max: range.max }),
    currency: range.currency,
    ...(range.period === "unknown" ? {} : { period: range.period }),
    provenance: "aggregator",
  };
}

export type LeadFields = Omit<JobLead, "source" | "provenance" | "mustVerifyEmployer"> & {
  readonly publishedAtRaw?: string | number;
};

export function buildLead(source: SearchSourceId, endpoint: string, retrievedAt: string, fields: LeadFields): JobLead {
  const { publishedAtRaw, ...lead } = fields;
  return {
    source,
    ...lead,
    provenance: { kind: "aggregator", endpoint, retrievedAt, ...(publishedAtRaw === undefined ? {} : { publishedAtRaw }) },
    mustVerifyEmployer: true,
  };
}

/** Validates rows leniently: malformed rows are skipped, but a feed where every row fails is a format change. */
export function parseRows<T>(rows: readonly unknown[], parse: (row: unknown) => T | null, source: SearchSourceId): { items: T[]; skipped: number } {
  const items = rows.map(parse).filter((item): item is T => item !== null);
  if (rows.length > 0 && items.length === 0) {
    throw new AppError("invalid_source_response", `${source} returned no readable listings.`, { source });
  }
  return { items, skipped: rows.length - items.length };
}

export function skippedNotice(skipped: number): string[] {
  return skipped > 0 ? [`${skipped} malformed listing(s) in this response were skipped.`] : [];
}
