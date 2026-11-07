import { z } from "zod";
import type { Company } from "../domain/campaign.js";
import type { Job, WorkplaceType } from "../domain/job.js";
import { AppError } from "../util/errors.js";
import { fetchJson } from "./http.js";
import { pathParts, postingId, segmentBoard, type BoardFormat } from "./smb/board.js";
import { closedCheck, isGone, openCheck, safeCheck } from "./smb/checks.js";
import { absoluteDate } from "./smb/dates.js";
import { mapEach, withDetails } from "./smb/details.js";
import { countryValues, publishedCountry } from "./smb/geo.js";
import { payPeriod, structuredPay } from "./smb/pay.js";
import { matchesQuery } from "./smb/query.js";
import { boardVerification, nonEmptyText, normalizePublicJob, optionalText, parseSourcePayload } from "./sourceValidation.js";
import type { SourceAdapter } from "./types.js";

/**
 * Dover careers pages (`app.dover.com/<slug>/careers/...`).
 *
 * Board: the company slug in Dover's apply and careers links, e.g. `acme` in
 * `https://app.dover.com/apply/acme/<job-id>`. The slug resolves to Dover's
 * internal client id, which keys the paginated job list. The list has no
 * description, date or pay; each posting's detail adds them, one capped
 * request per posting. Unpublished, sample, inactive and private jobs are
 * dropped.
 *
 * Endpoint behaviour adapted from career-ops (MIT).
 */

const FORMAT: BoardFormat = { ats: "Dover", shape: "the company slug in app.dover.com/apply/<slug>/<job-id>", example: "acme" };
const HOST = "app.dover.com";
const API = `https://${HOST}/api/v1`;
const PAGE_SIZE = 300;
const MAX_PAGES = 10;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const optionSchema = z.object({
  display_name: optionalText, location_type: optionalText, city: optionalText, state: optionalText, country: optionalText,
}).partial().nullish();
const locationSchema = z.object({ location_type: optionalText, location_option: optionSchema, name: optionalText }).partial();
const jobSchema = z.object({
  id: nonEmptyText.regex(UUID),
  title: nonEmptyText,
  locations: z.array(locationSchema).nullish(),
  workplace_type: optionalText,
  is_published: z.boolean().nullish(),
  is_sample: z.boolean().nullish(),
});
const pageSchema = z.object({ count: z.number().int().nonnegative().optional(), next: optionalText, results: z.array(z.unknown()) });
const detailSchema = z.object({
  id: nonEmptyText,
  title: nonEmptyText,
  user_provided_description: optionalText,
  locations: z.array(locationSchema).nullish(),
  workplace_type: optionalText,
  compensation: z.object({
    lower_bound: z.number().nullish(), upper_bound: z.number().nullish(), currency_code: optionalText,
    open_to_sharing_comp: z.boolean().nullish(), salary_range_type: optionalText, employment_type: optionalText,
  }).partial().nullish(),
  created: optionalText,
  active: z.boolean().nullish(),
  is_private: z.boolean().nullish(),
});
type DoverJob = z.infer<typeof jobSchema>;
type Detail = z.infer<typeof detailSchema>;
type Location = z.infer<typeof locationSchema>;

function slug(company: Company): string {
  return segmentBoard(company.board, FORMAT);
}

function slugUrl(company: Company): string {
  return `${API}/careers-page-slug/${encodeURIComponent(slug(company))}`;
}

function postingUrl(company: Company, id: string): string {
  return `https://${HOST}/apply/${encodeURIComponent(slug(company))}/${encodeURIComponent(id)}`;
}

async function clientId(company: Company): Promise<string> {
  const payload = await fetchJson<unknown>(slugUrl(company), { allowedHosts: [HOST] });
  const id = parseSourcePayload(z.object({ id: nonEmptyText.regex(UUID) }), payload, "Dover careers page").id;
  return id.toLowerCase();
}

function pageUrl(client: string, offset: number, limit = PAGE_SIZE): string {
  return `${API}/careers-page/${client}/jobs?limit=${limit}&offset=${offset}`;
}

function isListed(job: DoverJob): boolean {
  return job.is_published !== false && job.is_sample !== true;
}

async function readJobs(company: Company): Promise<{ jobs: DoverJob[]; total: number }> {
  const client = await clientId(company);
  let jobs: DoverJob[] = [];
  let total = 0;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const data = parseSourcePayload(pageSchema,
      await fetchJson<unknown>(pageUrl(client, page * PAGE_SIZE), { allowedHosts: [HOST] }), "Dover jobs");
    total = data.count ?? total;
    const parsed = mapEach(data.results, (row) => {
      const result = jobSchema.safeParse(row);
      return result.success ? result.data : null;
    }, { ats: "dover", board: company.board });
    jobs = [...jobs, ...parsed];
    if (data.results.length < PAGE_SIZE || !data.next) return { jobs: jobs.filter(isListed), total };
  }
  throw new AppError("source_limit", `Dover board exceeded ${MAX_PAGES * PAGE_SIZE} postings`);
}

async function readDetail(id: string): Promise<Detail> {
  const payload = await fetchJson<unknown>(
    `${API}/inbound/application-portal-job/${encodeURIComponent(postingId(id, FORMAT.ats))}`, { allowedHosts: [HOST] });
  return parseSourcePayload(detailSchema, payload, "Dover job");
}

/** Rendered the way Dover's own careers page shows it: "Remote (Canada)", "San Mateo, CA (Hybrid)". */
function label(location: Location): string {
  const raw = (location.location_option?.display_name || location.name || "").trim();
  // Dover's worldwide option is the region "International".
  const place = /^international$/i.test(raw) && (location.location_option?.location_type ?? "").toUpperCase() === "REGION"
    ? "Worldwide" : raw;
  const type = (location.location_type ?? "").toUpperCase();
  if (type === "REMOTE") return place ? `Remote (${place})` : "Remote";
  if (type === "HYBRID") return place ? `${place} (Hybrid)` : "";
  return place;
}

/** Region options ("International") carry a placeholder country, so only real places count. */
function countriesOf(locations: readonly Location[]): string[] {
  return countryValues(locations
    .filter((location) => ["COUNTRY", "STATE", "CITY"].includes((location.location_option?.location_type ?? "").toUpperCase()))
    .map((location) => location.location_option?.country));
}

function workplaceType(value: string | null | undefined): WorkplaceType {
  const type = (value ?? "").toUpperCase();
  if (type === "REMOTE") return "remote";
  if (type === "HYBRID") return "hybrid";
  return type === "ONSITE" || type === "IN_OFFICE" || type === "ON_SITE" ? "onsite" : "unknown";
}

function isOpen(detail: Detail | null): boolean {
  return detail === null || (detail.active !== false && detail.is_private !== true);
}

function normalize(company: Company, job: DoverJob, detail: Detail | null, capturedAt: string): Job | null {
  if (!isOpen(detail)) return null;
  const locations = detail?.locations?.length ? detail.locations : job.locations ?? [];
  const countries = countriesOf(locations);
  const type = workplaceType(detail?.workplace_type ?? job.workplace_type);
  const comp = detail?.compensation;
  const url = postingUrl(company, job.id);
  return normalizePublicJob({
    company,
    externalId: job.id,
    title: detail?.title ?? job.title,
    locations: [...new Set(locations.map(label).filter(Boolean))],
    url,
    applyUrl: url,
    descriptionHtml: detail?.user_provided_description ?? "",
    postedAt: absoluteDate(detail?.created),
    workplaceType: type,
    isRemote: type === "remote",
    employmentType: comp?.employment_type ?? undefined,
    structuredCompensation: comp?.open_to_sharing_comp === true
      ? structuredPay(comp.lower_bound, comp.upper_bound, comp.currency_code, payPeriod(comp.salary_range_type), JSON.stringify(comp))
      : null,
    country: publishedCountry(countries),
  }, capturedAt, countries);
}

export const doverAdapter: SourceAdapter = {
  kind: "dover",
  listUrl: slugUrl,
  boardUrl: (company) => `https://${HOST}/jobs/${encodeURIComponent(slug(company))}`,

  async listJobs(company, capturedAt) {
    const jobs = (await readJobs(company)).jobs.filter((job) => matchesQuery(company.query, job.title));
    const enriched = await withDetails(jobs, (job) => readDetail(job.id), { ats: "dover", board: company.board });
    return mapEach(enriched, ({ item, detail }) => normalize(company, item, detail, capturedAt), {
      ats: "dover", board: company.board,
    });
  },

  async verifyBoard(company) {
    const { jobs, total } = await readJobs(company);
    return boardVerification(jobs.map((job) => job.title), Math.max(total, jobs.length));
  },

  probeUrls(value) {
    const candidate = value.trim();
    return /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(candidate) ? [`${API}/careers-page-slug/${encodeURIComponent(candidate)}`] : [];
  },

  parsePostingUrl(url) {
    if (url.hostname.toLowerCase() !== HOST) return null;
    const [marker, board, id] = pathParts(url);
    return marker === "apply" && board && /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(board) && id && UUID.test(id)
      ? { board, externalId: id.toLowerCase() } : null;
  },

  async fetchPosting(company, externalId, capturedAt) {
    try {
      const detail = await readDetail(externalId);
      const job: DoverJob = { id: detail.id, title: detail.title, locations: detail.locations, workplace_type: detail.workplace_type };
      return normalize(company, job, detail, capturedAt);
    } catch (error) {
      if (isGone(error)) return null;
      throw error;
    }
  },

  async checkPosting(job) {
    return safeCheck(async () => {
      const detail = await readDetail(job.externalId);
      return isOpen(detail)
        ? openCheck("Dover reports the job as active")
        : closedCheck("Dover reports the job as inactive or private");
    });
  },
};
