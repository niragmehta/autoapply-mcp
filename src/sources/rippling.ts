import { z } from "zod";
import type { Company } from "../domain/campaign.js";
import type { CompensationRange, Job, WorkplaceType } from "../domain/job.js";
import { AppError } from "../util/errors.js";
import { fetchJson } from "./http.js";
import { companyFromJob, pathParts, postingId, segmentBoard, type BoardFormat } from "./smb/board.js";
import { isGone, openCheck, safeCheck } from "./smb/checks.js";
import { absoluteDate } from "./smb/dates.js";
import { mapEach, withDetails } from "./smb/details.js";
import { countryValues, publishedCountry } from "./smb/geo.js";
import { payPeriod, structuredPay } from "./smb/pay.js";
import { matchesQuery } from "./smb/query.js";
import { boardVerification, nonEmptyText, normalizePublicJob, optionalText, parseSourcePayload } from "./sourceValidation.js";
import type { SourceAdapter } from "./types.js";

/**
 * Rippling ATS public board API (the JSON its hosted board page reads).
 *
 * Board: the slug in `https://ats.rippling.com/<slug>/jobs`, e.g. `acme`.
 * The listing is paginated and carries titles, departments and structured
 * locations; each posting's description, creation date and pay ranges cost
 * one capped request to the posting endpoint. `company.query` filters titles
 * and departments before details are read.
 *
 * Endpoint behaviour adapted from career-ops (MIT).
 */

const FORMAT: BoardFormat = { ats: "Rippling", shape: "the board slug in ats.rippling.com/<slug>/jobs", example: "acme" };
const HOST = "ats.rippling.com";
const API = `https://${HOST}/api/v2/board`;
const PAGE_SIZE = 100;
const MAX_PAGES = 40;

const locationSchema = z.object({
  name: optionalText, country: optionalText, countryCode: optionalText, state: optionalText,
  city: optionalText, workplaceType: optionalText,
}).partial();
const itemSchema = z.object({
  id: nonEmptyText,
  name: nonEmptyText,
  url: optionalText,
  department: z.object({ name: optionalText }).partial().nullish(),
  locations: z.array(locationSchema).nullish(),
});
const pageSchema = z.object({
  items: z.array(z.unknown()),
  page: z.number().int().nonnegative().optional(),
  totalItems: z.number().int().nonnegative().optional(),
  totalPages: z.number().int().nonnegative().optional(),
});
const payRangeSchema = z.object({
  location: optionalText, currency: optionalText, frequency: optionalText,
  rangeStart: z.number().nullish(), rangeEnd: z.number().nullish(),
});
const detailSchema = z.object({
  uuid: nonEmptyText,
  name: nonEmptyText,
  description: z.object({ company: optionalText, role: optionalText }).partial().nullish(),
  workLocations: z.array(z.string()).nullish(),
  department: z.object({ name: optionalText }).partial().nullish(),
  employmentType: z.object({ label: optionalText, id: optionalText }).partial().nullish(),
  createdOn: optionalText,
  payRangeDetails: z.array(payRangeSchema).nullish(),
});
type Item = z.infer<typeof itemSchema>;
type Detail = z.infer<typeof detailSchema>;

function slug(company: Company): string {
  return segmentBoard(company.board, FORMAT);
}

function listingUrl(company: Company, page = 0, size = PAGE_SIZE): string {
  return `${API}/${encodeURIComponent(slug(company))}/jobs?page=${page}&pageSize=${size}`;
}

function postingUrl(company: Company, id: string): string {
  return `https://${HOST}/${encodeURIComponent(slug(company))}/jobs/${encodeURIComponent(id)}`;
}

async function readPage(company: Company, page: number, size = PAGE_SIZE) {
  const payload = await fetchJson<unknown>(listingUrl(company, page, size), { allowedHosts: [HOST] });
  return parseSourcePayload(pageSchema, payload, "Rippling board");
}

function parseItems(rows: unknown[], company: Company): Item[] {
  return mapEach(rows, (row) => {
    const parsed = itemSchema.safeParse(row);
    return parsed.success ? parsed.data : null;
  }, { ats: "rippling", board: company.board });
}

async function readItems(company: Company): Promise<Item[]> {
  let items: Item[] = [];
  const seen = new Set<string>();
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const data = await readPage(company, page);
    const fresh = parseItems(data.items, company).filter((item) => !seen.has(item.id));
    fresh.forEach((item) => seen.add(item.id));
    items = [...items, ...fresh];
    const lastPage = data.totalPages !== undefined ? page + 1 >= data.totalPages : data.items.length < PAGE_SIZE;
    if (lastPage || data.items.length === 0 || fresh.length === 0) return items;
  }
  throw new AppError("source_limit", `Rippling board exceeded ${MAX_PAGES * PAGE_SIZE} postings`);
}

async function readDetail(company: Company, id: string): Promise<Detail> {
  const payload = await fetchJson<unknown>(
    `${API}/${encodeURIComponent(slug(company))}/jobs/${encodeURIComponent(postingId(id, FORMAT.ats))}`,
    { allowedHosts: [HOST] },
  );
  return parseSourcePayload(detailSchema, payload, "Rippling posting");
}

function workplaceType(types: ReadonlyArray<string | null | undefined>): WorkplaceType {
  const values = new Set(types.map((type) => (type ?? "").toUpperCase()).filter(Boolean));
  if (values.size === 0) return "unknown";
  if (values.has("HYBRID")) return "hybrid";
  if ([...values].every((type) => type === "REMOTE")) return "remote";
  return [...values].every((type) => type === "ON_SITE" || type === "ONSITE") ? "onsite" : "unknown";
}

/** One published range, or the span of several that share currency and unit. */
function pay(detail: Detail | null): CompensationRange | null {
  const ranges = (detail?.payRangeDetails ?? []).filter((range) => range.rangeStart || range.rangeEnd);
  if (ranges.length === 0) return null;
  const units = new Set(ranges.map((range) => `${range.currency ?? ""}/${range.frequency ?? ""}`));
  if (units.size !== 1) return null;
  const first = ranges[0]!;
  const starts = ranges.map((range) => range.rangeStart).filter((value): value is number => typeof value === "number" && value > 0);
  const ends = ranges.map((range) => range.rangeEnd).filter((value): value is number => typeof value === "number" && value > 0);
  return structuredPay(
    starts.length ? Math.min(...starts) : null, ends.length ? Math.max(...ends) : null,
    first.currency, payPeriod(first.frequency),
    ranges.map((range) => `${range.location ?? "all"}: ${range.rangeStart ?? "?"}-${range.rangeEnd ?? "?"} ${range.currency ?? ""}/${range.frequency ?? ""}`).join("; "),
  );
}

function normalize(company: Company, item: Item, detail: Detail | null, capturedAt: string): Job {
  const locations = item.locations ?? [];
  const type = workplaceType(locations.map((location) => location.workplaceType));
  const countries = countryValues(locations.map((location) => location.countryCode || location.country));
  const url = postingUrl(company, item.id);
  return normalizePublicJob({
    company,
    externalId: item.id,
    title: item.name,
    locations: [...new Set([...locations.map((location) => location.name ?? ""), ...(detail?.workLocations ?? [])].filter(Boolean))],
    url,
    applyUrl: url,
    descriptionHtml: [detail?.description?.role, detail?.description?.company].filter(Boolean).join("\n"),
    postedAt: absoluteDate(detail?.createdOn),
    workplaceType: type,
    isRemote: type === "remote",
    employmentType: detail?.employmentType?.id ?? detail?.employmentType?.label ?? undefined,
    structuredCompensation: pay(detail),
    country: publishedCountry(countries),
  }, capturedAt, countries);
}

export const ripplingAdapter: SourceAdapter = {
  kind: "rippling",
  listUrl: (company) => listingUrl(company),
  boardUrl: (company) => `https://${HOST}/${encodeURIComponent(slug(company))}/jobs`,

  async listJobs(company, capturedAt) {
    const items = (await readItems(company)).filter((item) => matchesQuery(company.query, item.name, item.department?.name));
    const enriched = await withDetails(items, (item) => readDetail(company, item.id), { ats: "rippling", board: company.board });
    return mapEach(enriched, ({ item, detail }) => normalize(company, item, detail, capturedAt), {
      ats: "rippling", board: company.board,
    });
  },

  async verifyBoard(company) {
    const page = await readPage(company, 0, 5);
    return boardVerification(parseItems(page.items, company).map((item) => item.name), page.totalItems);
  },

  probeUrls(value) {
    const candidate = value.trim().toLowerCase();
    return /^[a-z0-9][a-z0-9_-]{0,99}$/.test(candidate)
      ? [`${API}/${encodeURIComponent(candidate)}/jobs?page=0&pageSize=1`] : [];
  },

  parsePostingUrl(url) {
    if (url.hostname.toLowerCase() !== HOST) return null;
    const parts = pathParts(url);
    const offset = /^[a-z]{2}(?:-[A-Za-z]{2})?$/.test(parts[0] ?? "") && parts[2] === "jobs" ? 1 : 0;
    const [board, marker, id] = parts.slice(offset);
    if (!board || marker !== "jobs" || !id || board === "api") return null;
    return /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(board) && /^[0-9a-f-]{16,64}$/i.test(id) ? { board, externalId: id } : null;
  },

  async fetchPosting(company, externalId, capturedAt) {
    try {
      const detail = await readDetail(company, externalId);
      const item: Item = { id: detail.uuid, name: detail.name, url: null, department: detail.department, locations: [] };
      return normalize(company, item, detail, capturedAt);
    } catch (error) {
      if (isGone(error)) return null;
      throw error;
    }
  },

  async checkPosting(job) {
    return safeCheck(async () => {
      await readDetail(companyFromJob(job), job.externalId);
      return openCheck("Rippling still serves this posting");
    });
  },
};
