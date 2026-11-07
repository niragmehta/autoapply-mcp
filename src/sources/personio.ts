import { z } from "zod";
import type { Company } from "../domain/campaign.js";
import type { Job } from "../domain/job.js";
import { fetchJson, fetchText } from "./http.js";
import { companyFromJob, isDnsLabel, pathParts, tenantBoard, type BoardFormat } from "./smb/board.js";
import { isGone, openCheck, safeCheck, unknownCheck } from "./smb/checks.js";
import { absoluteDate, earliestDate } from "./smb/dates.js";
import { mapEach, withDetails } from "./smb/details.js";
import { countryValues, publishedCountry } from "./smb/geo.js";
import { readJobPostingLd, type JobPostingLd } from "./smb/jsonLd.js";
import { payPeriod, structuredPay } from "./smb/pay.js";
import { matchesQuery } from "./smb/query.js";
import { parseFeedXml, xmlText } from "./smb/xml.js";
import { boardVerification, locationLabel, normalizePublicJob, parseSourcePayload } from "./sourceValidation.js";
import type { SourceAdapter } from "./types.js";

/**
 * Personio public career site (`<slug>.jobs.personio.de`).
 *
 * Board: the career-site subdomain, e.g. `acme` for acme.jobs.personio.de.
 * The documented `/xml` feed lists every position with offices, creation
 * date and any published salary; tenants that disable it still serve the
 * same list at `/search.json`. Descriptions now come from each posting page's
 * schema.org metadata (the feed's description blocks are usually empty), one
 * capped request per posting.
 *
 * Endpoint behaviour adapted from career-ops (MIT).
 */

const FORMAT: BoardFormat = { ats: "Personio", shape: "the subdomain of <slug>.jobs.personio.de", example: "acme" };
const HOST_SUFFIX = ".jobs.personio.de";

type Position = {
  id: string;
  name: string;
  offices: string[];
  department: string;
  employmentType: string;
  createdAt: string | null;
  descriptionHtml: string;
  salary: { min: unknown; max: unknown; currency: unknown; type: unknown } | null;
};

const searchSchema = z.array(z.object({
  id: z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]).transform(String),
  name: z.string().trim().min(1),
  office: z.string().nullish(),
  offices: z.array(z.string()).nullish(),
  department: z.string().nullish(),
  employment_type: z.string().nullish(),
  schedule: z.string().nullish(),
}).passthrough());

function host(company: Company): string {
  return `${tenantBoard(company.board, FORMAT)}${HOST_SUFFIX}`;
}

function xmlUrl(company: Company): string {
  return `https://${host(company)}/xml`;
}

function postingUrl(company: Company, id: string): string {
  return `https://${host(company)}/job/${id}`;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : value === undefined || value === "" ? [] : [value];
}

/** Positions from the documented XML feed; positions without a numeric id are skipped. */
export function parsePersonioXml(xml: string): Position[] {
  const root = record(record(parseFeedXml(xml, "Personio", (path) => [
    "workzag-jobs.position", "workzag-jobs.position.additionalOffices.office",
    "workzag-jobs.position.jobDescriptions.jobDescription",
  ].includes(path)))["workzag-jobs"]);
  return list(root.position).map(record).flatMap((position) => {
    const id = xmlText(position.id);
    const name = xmlText(position.name);
    if (!/^\d+$/.test(id) || !name) return [];
    const salary = record(position.salaryInformation);
    const descriptions = list(record(position.jobDescriptions).jobDescription).map(record)
      .filter((part) => xmlText(part.value).length > 0)
      .map((part) => `<h3>${xmlText(part.name)}</h3>${xmlText(part.value)}`);
    return [{
      id, name,
      offices: [xmlText(position.office), ...list(record(position.additionalOffices).office).map(xmlText)].filter(Boolean),
      department: xmlText(position.department),
      employmentType: [xmlText(position.employmentType), xmlText(position.schedule)].filter(Boolean).join(", "),
      createdAt: absoluteDate(xmlText(position.createdAt)),
      descriptionHtml: descriptions.join("\n"),
      salary: Object.keys(salary).length
        ? { min: xmlText(salary.min), max: xmlText(salary.max), currency: xmlText(salary.currencyCode), type: xmlText(salary.type) }
        : null,
    }];
  });
}

async function readPositions(company: Company): Promise<Position[]> {
  try {
    return parsePersonioXml(await fetchText(xmlUrl(company), { allowedHosts: [host(company)], accept: "application/xml, text/xml" }));
  } catch (error) {
    if (!isGone(error)) throw error;
  }
  // Some tenants disable the XML feed; the careers page's own JSON still lists positions.
  const rows = parseSourcePayload(searchSchema,
    await fetchJson<unknown>(`https://${host(company)}/search.json`, { allowedHosts: [host(company)] }), "Personio search");
  return rows.map((row) => ({
    id: row.id, name: row.name,
    offices: [...new Set([row.office ?? "", ...(row.offices ?? [])].filter(Boolean))],
    department: row.department ?? "",
    employmentType: [row.employment_type, row.schedule].filter(Boolean).join(", "),
    createdAt: null, descriptionHtml: "", salary: null,
  }));
}

async function readPage(company: Company, id: string): Promise<JobPostingLd | null> {
  const html = await fetchText(postingUrl(company, id), { allowedHosts: [host(company)], maxBytes: 4 * 1024 * 1024 });
  return readJobPostingLd(html);
}

function normalize(company: Company, position: Position, page: JobPostingLd | null, capturedAt: string): Job {
  const places = (page?.places ?? []).map((place) => locationLabel({ city: place.city, region: place.region, country: place.country }));
  const countries = countryValues((page?.places ?? []).map((place) => place.country));
  const remote = position.offices.some((office) => /^remote$/i.test(office.trim()));
  const url = postingUrl(company, position.id);
  const salary = position.salary;
  return normalizePublicJob({
    company,
    externalId: position.id,
    title: position.name,
    locations: [...new Set([...position.offices, ...places].filter(Boolean))],
    url,
    applyUrl: url,
    descriptionHtml: position.descriptionHtml || page?.description || "",
    postedAt: earliestDate(position.createdAt, page?.datePosted),
    workplaceType: remote && position.offices.length === 1 ? "remote" : "unknown",
    isRemote: remote && position.offices.length === 1,
    employmentType: position.employmentType || page?.employmentType || undefined,
    structuredCompensation: salary
      ? structuredPay(salary.min, salary.max, salary.currency, payPeriod(salary.type), JSON.stringify(salary)) ?? page?.pay ?? null
      : page?.pay ?? null,
    country: publishedCountry(countries),
  }, capturedAt, countries);
}

export const personioAdapter: SourceAdapter = {
  kind: "personio",
  listUrl: xmlUrl,
  boardUrl: (company) => `https://${host(company)}/`,

  async listJobs(company, capturedAt) {
    const positions = (await readPositions(company)).filter((position) => matchesQuery(company.query, position.name, position.department));
    const enriched = await withDetails(positions, (position) => position.descriptionHtml ? Promise.resolve(null) : readPage(company, position.id), {
      ats: "personio", board: company.board,
    });
    return mapEach(enriched, ({ item, detail }) => normalize(company, item, detail, capturedAt), { ats: "personio", board: company.board });
  },

  async verifyBoard(company) {
    return boardVerification((await readPositions(company)).map((position) => position.name));
  },

  probeUrls(slug) {
    const label = slug.trim().toLowerCase();
    return isDnsLabel(label) ? [`https://${label}${HOST_SUFFIX}/search.json`] : [];
  },

  parsePostingUrl(url) {
    const match = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.jobs\.personio\.(?:de|com)$/.exec(url.hostname.toLowerCase());
    const [marker, id] = pathParts(url);
    return match?.[1] && marker === "job" && id && /^\d+$/.test(id) ? { board: match[1], externalId: id } : null;
  },

  async fetchPosting(company, externalId, capturedAt) {
    const position = (await readPositions(company)).find((candidate) => candidate.id === externalId);
    if (!position) return null;
    const [entry] = await withDetails([position], (item) => readPage(company, item.id), { ats: "personio", board: company.board });
    return normalize(company, position, entry?.detail ?? null, capturedAt);
  },

  async checkPosting(job) {
    return safeCheck(async () => {
      if (!/^\d+$/.test(job.externalId)) return unknownCheck("Personio posting id is not numeric", "page");
      const page = await readPage(companyFromJob(job), job.externalId);
      return page
        ? openCheck("Personio posting page is live", "page")
        : unknownCheck("Personio page carried no posting metadata", "page");
    }, "page");
  },
};
