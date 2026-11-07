import { z } from "zod";
import type { Company } from "../domain/campaign.js";
import type { Job } from "../domain/job.js";
import { AppError } from "../util/errors.js";
import { fetchJson } from "./http.js";
import { companyFromJob, invalidBoard, postingId, type BoardFormat } from "./smb/board.js";
import { isGone, openCheck, safeCheck } from "./smb/checks.js";
import { absoluteDate } from "./smb/dates.js";
import { mapEach } from "./smb/details.js";
import { countryValues, publishedCountry } from "./smb/geo.js";
import { payPeriod, structuredPay } from "./smb/pay.js";
import { matchesQuery } from "./smb/query.js";
import { boardVerification, locationLabel, nonEmptyText, normalizePublicJob, optionalText, parseSourcePayload } from "./sourceValidation.js";
import type { SourceAdapter } from "./types.js";

/**
 * ClearCompany careers API (the JSON behind the embeddable career-site widget).
 *
 * Board: the career site's `siteId` GUID, copied from the employer careers
 * page source: `careers-content.clearcompany.com/js/v1/career-site.js?siteId=<GUID>`.
 * The paginated list carries full descriptions, dates, structured locations
 * and pay, so no per-posting requests are needed. A GUID cannot be guessed
 * from a company name, so board resolution does not probe ClearCompany.
 *
 * Endpoint behaviour adapted from career-ops (MIT).
 */

const FORMAT: BoardFormat = {
  ats: "ClearCompany",
  shape: "the siteId GUID from the careers page's career-site.js?siteId=<GUID> embed script",
  example: "0b1c2d3e-4f50-6172-8394-a5b6c7d8e9f0",
};
const HOST = "careers-api.clearcompany.com";
const PAGE_SIZE = 100;
const MAX_PAGES = 30;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const locationSchema = z.object({
  city: optionalText, subdivision: optionalText, subdivisionFullName: optionalText, country: optionalText,
  isRemote: z.boolean().nullish(),
}).partial();
const recordSchema = z.object({
  id: nonEmptyText.regex(GUID),
  positionTitle: nonEmptyText,
  description: optionalText,
  openDate: optionalText,
  postedDate: optionalText,
  departmentName: optionalText,
  jobFunctionName: optionalText,
  location: optionalText,
  locations: z.array(locationSchema).nullish(),
  applyLink: optionalText,
  salaryRangeLow: z.union([z.string(), z.number()]).nullish(),
  salaryRangeHigh: z.union([z.string(), z.number()]).nullish(),
  salaryType: optionalText,
});
const pageSchema = z.object({ results: z.array(z.unknown()), totalCount: z.number().int().nonnegative().optional() });
type ClearRecord = z.infer<typeof recordSchema>;

function siteId(company: Company): string {
  const value = company.board.trim().toLowerCase();
  if (!GUID.test(value)) throw invalidBoard(FORMAT, company.board);
  return value;
}

function apiBase(company: Company): string {
  return `https://${HOST}/v1/${siteId(company)}`;
}

function pageUrl(company: Company, page: number, size = PAGE_SIZE): string {
  return `${apiBase(company)}?pageIndex=${page}&pageSize=${size}`;
}

function parseRecords(rows: unknown[], company: Company): ClearRecord[] {
  return mapEach(rows, (row) => {
    const parsed = recordSchema.safeParse(row);
    return parsed.success ? parsed.data : null;
  }, { ats: "clearcompany", board: company.board });
}

async function readRecords(company: Company): Promise<ClearRecord[]> {
  let records: ClearRecord[] = [];
  const seen = new Set<string>();
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const data = parseSourcePayload(pageSchema,
      await fetchJson<unknown>(pageUrl(company, page), { allowedHosts: [HOST] }), "ClearCompany jobs");
    const fresh = parseRecords(data.results, company).filter((record) => !seen.has(record.id));
    fresh.forEach((record) => seen.add(record.id));
    records = [...records, ...fresh];
    // A short or repeated page ends the board even when the server clamps pageSize.
    if (data.results.length === 0 || fresh.length === 0 || (data.totalCount !== undefined && seen.size >= data.totalCount)) {
      return records;
    }
  }
  throw new AppError("source_limit", `ClearCompany site exceeded ${MAX_PAGES} pages`);
}

async function readRecord(company: Company, id: string): Promise<ClearRecord> {
  const payload = await fetchJson<unknown>(`${apiBase(company)}/${encodeURIComponent(postingId(id, FORMAT.ats))}`, {
    allowedHosts: [HOST],
  });
  return parseSourcePayload(recordSchema, payload, "ClearCompany job");
}

/** The posting's own ClearCompany page; any other host is ignored. */
function postingUrl(company: Company, record: ClearRecord): string {
  try {
    const url = new URL(record.applyLink ?? "");
    if (url.protocol === "https:" && url.hostname.toLowerCase().endsWith(".clearcompany.com")) return url.href;
  } catch {
    // Fall back to the API resource, which is at least stable and on the ATS.
  }
  return `${apiBase(company)}/${record.id}`;
}

function normalize(company: Company, record: ClearRecord, capturedAt: string): Job {
  const locations = record.locations ?? [];
  const countries = countryValues(locations.map((location) => location.country));
  const country = publishedCountry(countries);
  const remote = locations.length > 0 && locations.every((location) => location.isRemote === true);
  const labels = locations.map((location) => locationLabel({
    city: location.city, region: location.subdivisionFullName || location.subdivision, country: location.country,
  }));
  const url = postingUrl(company, record);
  // ClearCompany publishes no currency; amounts are only trusted for a US or Canadian posting.
  const currency = country === "CA" ? "CAD" : country === "US" ? "USD" : "";
  return normalizePublicJob({
    company,
    externalId: record.id,
    title: record.positionTitle.replace(/\s+/g, " "),
    locations: [...new Set([...labels, record.location ?? ""].filter(Boolean))],
    url,
    applyUrl: url,
    descriptionHtml: record.description ?? "",
    postedAt: absoluteDate(record.postedDate) ?? absoluteDate(record.openDate),
    workplaceType: remote ? "remote" : "unknown",
    isRemote: remote,
    structuredCompensation: structuredPay(
      record.salaryRangeLow, record.salaryRangeHigh, currency, payPeriod(record.salaryType), `clearcompany ${record.salaryType ?? ""}`.trim(),
    ),
    country,
  }, capturedAt, countries);
}

export const clearCompanyAdapter: SourceAdapter = {
  kind: "clearcompany",
  listUrl: (company) => pageUrl(company, 0),
  boardUrl: (company) => `https://careers-content.clearcompany.com/js/v1/career-site.js?siteId=${siteId(company)}`,

  async listJobs(company, capturedAt) {
    const records = (await readRecords(company))
      .filter((record) => matchesQuery(company.query, record.positionTitle, record.departmentName, record.jobFunctionName));
    return mapEach(records, (record) => normalize(company, record, capturedAt), { ats: "clearcompany", board: company.board });
  },

  async verifyBoard(company) {
    const data = parseSourcePayload(pageSchema,
      await fetchJson<unknown>(pageUrl(company, 0, 5), { allowedHosts: [HOST], retries: 0 }), "ClearCompany jobs");
    return boardVerification(parseRecords(data.results, company).map((record) => record.positionTitle), data.totalCount);
  },

  /** A siteId is a GUID that cannot be derived from a company name. */
  probeUrls: () => [],

  async fetchPosting(company, externalId, capturedAt) {
    try {
      return normalize(company, await readRecord(company, externalId), capturedAt);
    } catch (error) {
      if (isGone(error)) return null;
      throw error;
    }
  },

  async checkPosting(job) {
    return safeCheck(async () => {
      await readRecord(companyFromJob(job), job.externalId);
      return openCheck("ClearCompany still serves this posting");
    });
  },
};
