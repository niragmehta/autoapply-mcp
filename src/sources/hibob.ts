import { z } from "zod";
import type { Company } from "../domain/campaign.js";
import type { Job, WorkplaceType } from "../domain/job.js";
import { AppError } from "../util/errors.js";
import { fetchJson } from "./http.js";
import { companyFromJob, isDnsLabel, pathParts, tenantBoard, type BoardFormat } from "./smb/board.js";
import { listingCheck, safeCheck } from "./smb/checks.js";
import { absoluteDate } from "./smb/dates.js";
import { mapEach } from "./smb/details.js";
import { countryValues, publishedCountry } from "./smb/geo.js";
import { payPeriod, structuredPay } from "./smb/pay.js";
import { matchesQuery } from "./smb/query.js";
import { boardVerification, locationLabel, nonEmptyText, normalizePublicJob, optionalText, parseSourcePayload } from "./sourceValidation.js";
import type { SourceAdapter } from "./types.js";

/**
 * HiBob ("Bob") hosted careers sites.
 *
 * Board: the tenant label of `<tenant>.careers.hibob.com`, exactly as the host
 * shows it, e.g. `acme` or `acme-641e1b39232b`. The site's own app reads every
 * job ad, with full text, sites, workplace type and any published pay, from
 * one JSON endpoint that names the tenant in a `companyidentifier` header (the
 * same value the page sends; no login or token). That header requirement is
 * why board resolution cannot probe HiBob: `verifyBoard` confirms a tenant.
 *
 * Endpoint behaviour adapted from career-ops (MIT).
 */

const FORMAT: BoardFormat = { ats: "HiBob", shape: "the tenant label of <tenant>.careers.hibob.com", example: "acme" };
const HOST_SUFFIX = ".careers.hibob.com";

const locationSchema = z.object({
  name: optionalText, city: optionalText, region: optionalText, country: optionalText,
}).partial();
const adSchema = z.object({
  id: nonEmptyText,
  title: nonEmptyText,
  department: optionalText,
  employmentType: optionalText,
  site: optionalText,
  country: optionalText,
  description: optionalText,
  responsibilities: optionalText,
  requirements: optionalText,
  benefits: optionalText,
  publishedAt: optionalText,
  workspaceTypeId: optionalText,
  payTransparencyMinSalary: z.union([z.number(), z.string()]).nullish(),
  payTransparencyMaxSalary: z.union([z.number(), z.string()]).nullish(),
  payTransparencySalaryCurrency: optionalText,
  payTransparencySalaryPayPeriod: optionalText,
  postingLocations: z.array(locationSchema).nullish(),
});
type Ad = z.infer<typeof adSchema>;

function tenant(company: Company): string {
  return tenantBoard(company.board, FORMAT);
}

function host(company: Company): string {
  return `${tenant(company)}${HOST_SUFFIX}`;
}

function listUrl(company: Company): string {
  return `https://${host(company)}/api/job-ad`;
}

async function readAds(company: Company): Promise<Ad[]> {
  let payload: unknown;
  try {
    payload = await fetchJson<unknown>(listUrl(company), {
      allowedHosts: [host(company)],
      headers: { companyidentifier: tenant(company) },
    });
  } catch (error) {
    // An unknown tenant label answers 401 rather than 404.
    if (error instanceof AppError && Number(error.details.status) === 401) {
      throw new AppError("not_found", `HiBob board "${company.board}" was not found (HTTP 401 for an unknown tenant)`, { board: company.board });
    }
    throw error;
  }
  const ads = parseSourcePayload(z.object({ jobAdDetails: z.array(z.unknown()) }), payload, "HiBob job ads").jobAdDetails;
  return mapEach(ads, (row) => {
    const parsed = adSchema.safeParse(row);
    return parsed.success ? parsed.data : null;
  }, { ats: "hibob", board: company.board });
}

const WORKPLACE: Readonly<Record<string, WorkplaceType>> = { remote: "remote", hybrid: "hybrid", onsite: "onsite", office: "onsite" };

function normalize(company: Company, ad: Ad, capturedAt: string): Job {
  const posted = ad.postingLocations ?? [];
  const countries = countryValues([ad.country, ...posted.map((location) => location.country)]);
  const type = WORKPLACE[(ad.workspaceTypeId ?? "").toLowerCase()] ?? "unknown";
  const url = `https://${host(company)}/jobs/${encodeURIComponent(ad.id)}`;
  return normalizePublicJob({
    company,
    externalId: ad.id,
    title: ad.title,
    locations: [...new Set([
      locationLabel({ city: ad.site, country: ad.country }),
      ...posted.map((location) => locationLabel({ city: location.city || location.name, region: location.region, country: location.country })),
    ].filter(Boolean))],
    url,
    applyUrl: url,
    descriptionHtml: [ad.description, ad.responsibilities, ad.requirements, ad.benefits].filter(Boolean).join("\n"),
    postedAt: absoluteDate(ad.publishedAt),
    workplaceType: type,
    isRemote: type === "remote",
    employmentType: ad.employmentType ?? undefined,
    structuredCompensation: structuredPay(
      ad.payTransparencyMinSalary, ad.payTransparencyMaxSalary, ad.payTransparencySalaryCurrency,
      payPeriod(ad.payTransparencySalaryPayPeriod), `hibob pay transparency ${ad.payTransparencySalaryPayPeriod ?? ""}`.trim(),
    ),
    country: publishedCountry(countries),
  }, capturedAt, countries);
}

export const hibobAdapter: SourceAdapter = {
  kind: "hibob",
  listUrl,
  boardUrl: (company) => `https://${host(company)}/jobs`,

  async listJobs(company, capturedAt) {
    const ads = (await readAds(company)).filter((ad) => matchesQuery(company.query, ad.title, ad.department));
    return mapEach(ads, (ad) => normalize(company, ad, capturedAt), { ats: "hibob", board: company.board });
  },

  async verifyBoard(company) {
    return boardVerification((await readAds(company)).map((ad) => ad.title));
  },

  /** The job-ad endpoint needs a tenant header that board probing cannot send. */
  probeUrls: () => [],

  parsePostingUrl(url) {
    const hostname = url.hostname.toLowerCase();
    const label = hostname.endsWith(HOST_SUFFIX) ? hostname.slice(0, -HOST_SUFFIX.length) : "";
    const [marker, id] = pathParts(url);
    return isDnsLabel(label) && marker === "jobs" && id && /^[0-9a-f-]{16,64}$/i.test(id) ? { board: label, externalId: id } : null;
  },

  async fetchPosting(company, externalId, capturedAt) {
    const ad = (await readAds(company)).find((candidate) => candidate.id === externalId);
    return ad ? normalize(company, ad, capturedAt) : null;
  },

  /** One request returns every published ad, so absence means closed. */
  async checkPosting(job) {
    return safeCheck(async () => listingCheck((await readAds(companyFromJob(job))).some((ad) => ad.id === job.externalId), "HiBob"));
  },
};
