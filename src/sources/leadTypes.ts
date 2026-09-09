import { z } from "zod";
import { AppError } from "../util/errors.js";

export const SEARCH_SOURCE_IDS = ["himalayas", "foorilla"] as const;
export type SearchSourceId = (typeof SEARCH_SOURCE_IDS)[number];
export type SourceReadiness = "ready" | "credentials-required" | "credentials-configured" | "manual-only";
export const SOURCE_SEARCH_MAX_LIMIT = 100;
export const SOURCE_MIN_INTERVAL_MS = 700;

export const SourceSearchInputSchema = z.object({
  query: z.string().trim().min(1).max(300),
  country: z.string().trim().min(1).max(100).optional(),
  location: z.string().trim().min(1).max(200).optional(),
  company: z.string().trim().min(1).max(200).optional(),
  limit: z.number().int().min(1).max(SOURCE_SEARCH_MAX_LIMIT),
  page: z.number().int().min(1).optional(),
});
export type SourceSearchInput = z.infer<typeof SourceSearchInputSchema>;

export interface LeadSalary {
  readonly min?: number;
  readonly max?: number;
  readonly currency?: string;
  /** The explicit source value, not an assumed or annualized period. */
  readonly period?: string;
  readonly provenance: "aggregator";
}

/** Unverified leads deliberately have neither an ATS type nor campaign gate/score fields. */
export interface JobLead {
  readonly source: SearchSourceId;
  readonly sourceId: string;
  readonly sourceUrl: string;
  readonly title: string;
  readonly company: string;
  readonly locations: readonly string[];
  readonly locationRestrictions: readonly string[];
  readonly timezoneRestrictions: readonly string[];
  readonly description: string;
  readonly salary?: LeadSalary;
  readonly publishedAt?: string;
  readonly applyUrl?: string;
  readonly provenance: {
    readonly kind: "aggregator";
    readonly endpoint: string;
    readonly retrievedAt: string;
    readonly publishedAtRaw?: string | number;
  };
  readonly mustVerifyEmployer: true;
}

export interface SourceAttribution {
  readonly label: string;
  readonly url: string;
  readonly license?: string;
  readonly licenseUrl?: string;
  readonly changes: string;
  readonly requirements: readonly string[];
}

export interface SourcePagination {
  readonly page: number;
  readonly pageSize: number;
  readonly returned: number;
  readonly total: number;
  readonly totalPages: number;
  readonly hasMore: boolean;
  readonly nextPage?: number;
  readonly nextPageLimit?: number;
  readonly truncated: boolean;
  readonly remainingOnPage: number;
}

export interface SourceSearchResult {
  readonly source: SearchSourceId;
  readonly readiness: "ready";
  readonly leads: readonly JobLead[];
  readonly pagination: SourcePagination;
  readonly attribution: SourceAttribution;
  readonly limitations: readonly string[];
}

export const HttpUrlSchema = z.string().url().refine(
  (value) => /^https?:\/\//i.test(value) && !new URL(value).username && !new URL(value).password,
);
export const OptionalSourceUrlSchema = z.union([HttpUrlSchema, z.literal("")]).nullish();
const sourceTimestampMillis = (value: number): number => value < 100_000_000_000 ? value * 1000 : value;
export const SourceTimestampSchema = z.union([
  z.string().min(1).refine((value) => Number.isFinite(Date.parse(value))),
  z.number().int().nonnegative().refine((value) => Number.isFinite(new Date(sourceTimestampMillis(value)).getTime())),
]).nullish();

export function parseSourceSearchInput(input: SourceSearchInput): SourceSearchInput {
  const result = SourceSearchInputSchema.safeParse(input);
  if (!result.success) {
    throw new AppError("invalid_source_search", "Supply a query, a limit from 1 to 100, and a positive page.", {
      fields: result.error.issues.map((issue) => issue.path.join(".")),
    });
  }
  return result.data;
}

export function parseSourceResponse<T>(schema: z.ZodType<T>, payload: unknown, source: SearchSourceId): T {
  const result = schema.safeParse(payload);
  if (!result.success) {
    throw new AppError("invalid_source_response", `${source} returned an invalid search response.`, {
      source,
      fields: result.error.issues.map((issue) => issue.path.join(".")),
    });
  }
  return result.data;
}

export function sourcePublishedAt(value: string | number | null | undefined): string | undefined {
  if (value == null) return undefined;
  return typeof value === "string" ? value : new Date(sourceTimestampMillis(value)).toISOString();
}

export function leadSalary(
  min: number | null | undefined,
  max: number | null | undefined,
  currency: string | null | undefined,
  period?: string | null,
): LeadSalary | undefined {
  if (min == null && max == null) return undefined;
  return {
    ...(min == null ? {} : { min }),
    ...(max == null ? {} : { max }),
    ...(currency ? { currency } : {}),
    ...(period ? { period } : {}),
    provenance: "aggregator",
  };
}

export function sourcePagination(
  page: number,
  pageSize: number,
  received: number,
  returned: number,
  total: number,
  totalPages = Math.ceil(total / pageSize),
): SourcePagination {
  const remainingOnPage = received - returned;
  const truncated = remainingOnPage > 0;
  const hasMore = truncated || page < totalPages;
  return {
    page, pageSize, returned, total, totalPages, hasMore, truncated, remainingOnPage,
    ...(truncated
      ? { nextPage: page, nextPageLimit: Math.min(SOURCE_SEARCH_MAX_LIMIT, Math.max(pageSize, received)) }
      : hasMore ? { nextPage: page + 1 } : {}),
  };
}

export const TRUNCATED_PAGE_NOTICE =
  "The requested limit truncated this provider page. Re-run the same page with nextPageLimit before advancing; earlier leads will repeat.";
