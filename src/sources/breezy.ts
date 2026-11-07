import { z } from "zod";
import type { Company } from "../domain/campaign.js";
import type { Job } from "../domain/job.js";
import { fetchJson, fetchText } from "./http.js";
import { companyFromJob, isDnsLabel, pathParts, tenantBoard, type BoardFormat } from "./smb/board.js";
import { listingCheck, safeCheck } from "./smb/checks.js";
import { absoluteDate, earliestDate } from "./smb/dates.js";
import { mapEach, withDetails } from "./smb/details.js";
import { countryValues, publishedCountry } from "./smb/geo.js";
import { readJobPostingLd, type JobPostingLd } from "./smb/jsonLd.js";
import { textPay } from "./smb/pay.js";
import { matchesQuery } from "./smb/query.js";
import {
  boardVerification, locationLabel, nonEmptyText, normalizePublicJob, optionalText, parseSourcePayload,
} from "./sourceValidation.js";
import type { SourceAdapter } from "./types.js";

/**
 * Breezy HR public position feed.
 *
 * Board: the tenant subdomain of `<tenant>.breezy.hr`, e.g. `acme`.
 * `/json` lists every published position with locations, a publish date and
 * the pay text, but no description; each posting page's schema.org metadata
 * supplies the description and structured pay, one capped request per
 * posting. `company.query` filters titles and departments before details.
 *
 * Endpoint behaviour adapted from career-ops (MIT).
 */

const FORMAT: BoardFormat = { ats: "Breezy HR", shape: "the tenant subdomain of <tenant>.breezy.hr", example: "acme" };
const HOST_SUFFIX = ".breezy.hr";
const BREEZY_ID = /^[0-9a-f]{12}$/;

const namedSchema = z.object({ id: optionalText, name: optionalText }).partial().nullish();
const locationSchema = z.object({
  name: optionalText, city: optionalText, country: namedSchema, state: namedSchema, is_remote: z.boolean().nullish(),
}).partial();
const positionSchema = z.object({
  id: nonEmptyText.regex(BREEZY_ID),
  friendly_id: optionalText,
  name: nonEmptyText,
  url: optionalText,
  published_date: optionalText,
  type: namedSchema,
  location: locationSchema.nullish(),
  locations: z.array(locationSchema).nullish(),
  department: optionalText,
  salary: optionalText,
});
type Position = z.infer<typeof positionSchema>;
type Location = z.infer<typeof locationSchema>;

function host(company: Company): string {
  return `${tenantBoard(company.board, FORMAT)}${HOST_SUFFIX}`;
}

function listUrl(company: Company): string {
  return `https://${host(company)}/json`;
}

async function readPositions(company: Company): Promise<Position[]> {
  const payload = await fetchJson<unknown>(listUrl(company), { allowedHosts: [host(company)] });
  const rows = parseSourcePayload(z.array(z.unknown()), payload, "Breezy feed");
  return mapEach(rows, (row) => {
    const parsed = positionSchema.safeParse(row);
    return parsed.success ? parsed.data : null;
  }, { ats: "breezy", board: company.board });
}

/** The posting page on the tenant's own host; a feed URL elsewhere is never fetched. */
function postingUrl(company: Company, position: Position): string {
  const own = `https://${host(company)}/p/${encodeURIComponent(position.friendly_id || position.id)}`;
  try {
    const url = new URL(position.url ?? "");
    return url.protocol === "https:" && url.hostname.toLowerCase() === host(company) ? `${url.origin}${url.pathname}` : own;
  } catch {
    return own;
  }
}

async function readPosting(company: Company, position: Position): Promise<JobPostingLd | null> {
  const html = await fetchText(postingUrl(company, position), { allowedHosts: [host(company)], maxBytes: 4 * 1024 * 1024 });
  return readJobPostingLd(html);
}

function label(location: Location): string {
  const country = location.country?.name ?? "";
  const name = location.name?.trim() ?? "";
  if (name) return country && !name.toLowerCase().includes(country.toLowerCase()) ? `${name}, ${country}` : name;
  return locationLabel({ city: location.city, region: location.state?.name, country: country || location.country?.id });
}

function normalize(company: Company, position: Position, posting: JobPostingLd | null, capturedAt: string): Job {
  const locations = position.locations?.length ? position.locations : position.location ? [position.location] : [];
  const remote = locations.length > 0 && locations.every((location) => location.is_remote === true);
  const countries = countryValues(locations.map((location) => location.country?.id || location.country?.name));
  const url = postingUrl(company, position);
  return normalizePublicJob({
    company,
    externalId: position.id,
    title: position.name,
    locations: [...new Set(locations.map(label).filter(Boolean))],
    url,
    applyUrl: url,
    descriptionHtml: posting?.description ?? "",
    postedAt: earliestDate(absoluteDate(position.published_date), posting?.datePosted),
    workplaceType: remote ? "remote" : "unknown",
    isRemote: remote,
    employmentType: position.type?.name ?? posting?.employmentType ?? undefined,
    structuredCompensation: posting?.pay ?? textPay(position.salary, publishedCountry(countries) === "CA" ? "CAD" : "USD"),
    country: publishedCountry(countries),
  }, capturedAt, countries);
}

async function readOne(company: Company, externalId: string): Promise<Position | undefined> {
  return (await readPositions(company)).find((position) => position.id === externalId);
}

export const breezyAdapter: SourceAdapter = {
  kind: "breezy",
  listUrl,
  boardUrl: (company) => `https://${host(company)}/`,

  async listJobs(company, capturedAt) {
    const positions = (await readPositions(company))
      .filter((position) => matchesQuery(company.query, position.name, position.department));
    const enriched = await withDetails(positions, (position) => readPosting(company, position), {
      ats: "breezy", board: company.board,
    });
    return mapEach(enriched, ({ item, detail }) => normalize(company, item, detail, capturedAt), {
      ats: "breezy", board: company.board,
    });
  },

  async verifyBoard(company) {
    return boardVerification((await readPositions(company)).map((position) => position.name));
  },

  probeUrls(slug) {
    const label = slug.trim().toLowerCase();
    return isDnsLabel(label) ? [`https://${label}${HOST_SUFFIX}/json`] : [];
  },

  parsePostingUrl(url) {
    const hostname = url.hostname.toLowerCase();
    const tenant = hostname.endsWith(HOST_SUFFIX) ? hostname.slice(0, -HOST_SUFFIX.length) : "";
    const parts = pathParts(url);
    const id = parts[0] === "p" ? /^([0-9a-f]{12})(?:-|$)/.exec(parts[1] ?? "")?.[1] : undefined;
    return isDnsLabel(tenant) && tenant !== "www" && id ? { board: tenant, externalId: id } : null;
  },

  async fetchPosting(company, externalId, capturedAt) {
    const position = await readOne(company, externalId);
    if (!position) return null;
    const [entry] = await withDetails([position], (item) => readPosting(company, item), { ats: "breezy", board: company.board });
    return normalize(company, position, entry?.detail ?? null, capturedAt);
  },

  /** The feed lists every published position, so absence from it means closed. */
  async checkPosting(job) {
    return safeCheck(async () => listingCheck(Boolean(await readOne(companyFromJob(job), job.externalId)), "Breezy"));
  },
};
