import { z } from "zod";
import type { Company } from "../domain/campaign.js";
import type { Job, WorkplaceType } from "../domain/job.js";
import { fetchJson } from "./http.js";
import { companyFromJob, isDnsLabel, pathParts, postingId, tenantBoard, type BoardFormat } from "./smb/board.js";
import { closedCheck, isGone, openCheck, safeCheck } from "./smb/checks.js";
import { absoluteDate } from "./smb/dates.js";
import { mapEach, withDetails } from "./smb/details.js";
import { missingBoard } from "./smb/errors.js";
import { countryValues, publishedCountry } from "./smb/geo.js";
import { textPay } from "./smb/pay.js";
import { matchesQuery } from "./smb/query.js";
import {
  boardVerification, locationLabel, nonEmptyText, normalizePublicJob, optionalText, parseSourcePayload,
} from "./sourceValidation.js";
import type { SourceAdapter } from "./types.js";

/**
 * BambooHR public careers API (the JSON the hosted careers page reads).
 *
 * Board: the tenant subdomain of `<tenant>.bamboohr.com`, e.g. `acme`.
 * `/careers/list` returns every open posting without descriptions; each
 * posting's description, date, pay and office country cost one request to
 * `/careers/<id>/detail`, capped per board. BambooHR has no search endpoint,
 * so `company.query` is matched against titles and departments before any
 * detail is requested.
 *
 * Endpoint behaviour adapted from career-ops (MIT).
 */

const FORMAT: BoardFormat = { ats: "BambooHR", shape: "the tenant subdomain of <tenant>.bamboohr.com", example: "acme" };
const HOST_SUFFIX = ".bamboohr.com";

const placeSchema = z.object({
  city: optionalText, state: optionalText, province: optionalText, country: optionalText, addressCountry: optionalText,
}).partial().nullish();
const rowSchema = z.object({
  id: z.union([nonEmptyText, z.number().int().nonnegative()]).transform(String),
  jobOpeningName: nonEmptyText,
  departmentLabel: optionalText,
  employmentStatusLabel: optionalText,
  location: placeSchema,
  atsLocation: placeSchema,
  isRemote: z.union([z.boolean(), z.number()]).nullish(),
  locationType: z.union([z.string(), z.number()]).nullish(),
});
const listSchema = z.object({
  meta: z.object({ totalCount: z.number().int().nonnegative().optional() }).nullish(),
  result: z.array(z.unknown()),
});
const detailSchema = z.object({
  result: z.object({
    jobOpening: z.object({
      jobOpeningName: optionalText,
      jobOpeningStatus: optionalText,
      employmentStatusLabel: optionalText,
      description: optionalText,
      compensation: optionalText,
      datePosted: optionalText,
      location: placeSchema,
      atsLocation: placeSchema,
      locationType: z.union([z.string(), z.number()]).nullish(),
    }),
  }),
});
type Row = z.infer<typeof rowSchema>;
type Detail = z.infer<typeof detailSchema>["result"]["jobOpening"];
type Place = z.infer<typeof placeSchema>;

function host(company: Company): string {
  return `${tenantBoard(company.board, FORMAT)}${HOST_SUFFIX}`;
}

function listUrl(company: Company): string {
  return `https://${host(company)}/careers/list`;
}

function postingUrl(company: Company, id: string): string {
  return `https://${host(company)}/careers/${encodeURIComponent(id)}`;
}

async function readRows(company: Company): Promise<{ rows: Row[]; total: number }> {
  let payload: unknown;
  try {
    payload = await fetchJson<unknown>(listUrl(company), { allowedHosts: [host(company)] });
  } catch (error) {
    throw missingBoard(error, FORMAT.ats, company.board);
  }
  const list = parseSourcePayload(listSchema, payload, "BambooHR list");
  const rows = mapEach(list.result, (row) => {
    const parsed = rowSchema.safeParse(row);
    return parsed.success ? parsed.data : null;
  }, { ats: "bamboohr", board: company.board });
  return { rows, total: list.meta?.totalCount ?? rows.length };
}

async function readDetail(company: Company, id: string): Promise<Detail> {
  const payload = await fetchJson<unknown>(`${postingUrl(company, postingId(id, FORMAT.ats))}/detail`, {
    allowedHosts: [host(company)],
  });
  return parseSourcePayload(detailSchema, payload, "BambooHR detail").result.jobOpening;
}

/** `locationType` 0 is on-site, 1 remote, 2 hybrid; `isRemote` is usually null. */
function workplaceType(locationType: unknown, isRemote: unknown): WorkplaceType {
  const type = String(locationType ?? "");
  if (type === "1") return "remote";
  if (type === "2") return "hybrid";
  if (type === "0") return "onsite";
  return isRemote === true || isRemote === 1 ? "remote" : "unknown";
}

function placeLabel(place: Place): string {
  return place ? locationLabel({
    city: place.city, region: place.state || place.province, country: place.addressCountry || place.country,
  }) : "";
}

function isOpen(detail: Detail | null): boolean {
  return detail === null || !detail.jobOpeningStatus || /^open$/i.test(detail.jobOpeningStatus);
}

function normalize(company: Company, row: Row, detail: Detail | null, capturedAt: string): Job | null {
  if (!isOpen(detail)) return null;
  const office = detail?.location ?? row.location;
  const remoteArea = detail?.atsLocation ?? row.atsLocation;
  const type = workplaceType(detail?.locationType ?? row.locationType, row.isRemote);
  const countries = countryValues([office?.addressCountry, remoteArea?.country]);
  const url = postingUrl(company, row.id);
  return normalizePublicJob({
    company,
    externalId: row.id,
    title: detail?.jobOpeningName || row.jobOpeningName,
    locations: [...new Set([placeLabel(office), placeLabel(remoteArea)].filter(Boolean))],
    url,
    applyUrl: url,
    descriptionHtml: detail?.description ?? "",
    postedAt: absoluteDate(detail?.datePosted),
    workplaceType: type,
    isRemote: type === "remote",
    employmentType: detail?.employmentStatusLabel ?? row.employmentStatusLabel ?? undefined,
    structuredCompensation: textPay(detail?.compensation, publishedCountry(countries) === "CA" ? "CAD" : "USD"),
    country: publishedCountry(countries),
  }, capturedAt, countries);
}

function rowFromDetail(id: string, detail: Detail): Row {
  return {
    id, jobOpeningName: detail.jobOpeningName ?? "", departmentLabel: null,
    employmentStatusLabel: detail.employmentStatusLabel, location: detail.location,
    atsLocation: detail.atsLocation, isRemote: null, locationType: detail.locationType,
  };
}

export const bambooHrAdapter: SourceAdapter = {
  kind: "bamboohr",
  listUrl,
  boardUrl: (company) => `https://${host(company)}/careers`,

  async listJobs(company, capturedAt) {
    const { rows } = await readRows(company);
    const wanted = rows.filter((row) => matchesQuery(company.query, row.jobOpeningName, row.departmentLabel));
    const enriched = await withDetails(wanted, (row) => readDetail(company, row.id), {
      ats: "bamboohr", board: company.board,
    });
    return mapEach(enriched, ({ item, detail }) => normalize(company, item, detail, capturedAt), {
      ats: "bamboohr", board: company.board,
    });
  },

  async verifyBoard(company) {
    const { rows, total } = await readRows(company);
    return boardVerification(rows.map((row) => row.jobOpeningName), total);
  },

  probeUrls(slug) {
    const label = slug.trim().toLowerCase();
    return isDnsLabel(label) ? [`https://${label}${HOST_SUFFIX}/careers/list`] : [];
  },

  parsePostingUrl(url) {
    const hostname = url.hostname.toLowerCase();
    const tenant = hostname.endsWith(HOST_SUFFIX) ? hostname.slice(0, -HOST_SUFFIX.length) : "";
    if (!isDnsLabel(tenant) || ["www", "api", "app"].includes(tenant)) return null;
    const parts = pathParts(url);
    const id = parts[0] === "careers" ? parts[1] : parts[0] === "jobs" && parts[1] === "view.php" ? url.searchParams.get("id") : null;
    return id && /^\d+$/.test(id) ? { board: tenant, externalId: id } : null;
  },

  async fetchPosting(company, externalId, capturedAt) {
    try {
      const detail = await readDetail(company, externalId);
      return normalize(company, rowFromDetail(externalId, detail), detail, capturedAt);
    } catch (error) {
      if (isGone(error)) return null;
      throw error;
    }
  },

  async checkPosting(job) {
    return safeCheck(async () => {
      const detail = await readDetail(companyFromJob(job), job.externalId);
      return isOpen(detail)
        ? openCheck("BambooHR reports the opening as open")
        : closedCheck(`BambooHR reports the opening as ${detail.jobOpeningStatus}`);
    });
  },
};
