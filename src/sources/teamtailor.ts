import { z } from "zod";
import type { Company } from "../domain/campaign.js";
import type { Job } from "../domain/job.js";
import { AppError } from "../util/errors.js";
import { logger } from "../util/logger.js";
import { fetchJson } from "./http.js";
import { companyFromJob, invalidBoard, isDnsLabel, pathParts, type BoardFormat } from "./smb/board.js";
import { isGone, listingCheck, safeCheck } from "./smb/checks.js";
import { absoluteDate } from "./smb/dates.js";
import { mapEach } from "./smb/details.js";
import { countryValues, publishedCountry } from "./smb/geo.js";
import { jobPostingFromNode, type JobPostingLd } from "./smb/jsonLd.js";
import { matchesQuery } from "./smb/query.js";
import { boardVerification, locationLabel, nonEmptyText, normalizePublicJob, optionalText, parseSourcePayload } from "./sourceValidation.js";
import type { SourceAdapter } from "./types.js";

/**
 * Teamtailor career-site job feed (JSON Feed 1.1 with schema.org JobPosting).
 *
 * Board: the career-site subdomain of `<slug>.teamtailor.com`, e.g. `acme`;
 * North American tenants live on `<slug>.na.teamtailor.com` and use
 * `acme.na`. A bare slug whose global host does not exist is retried once on
 * the NA host. The feed carries full descriptions, dates, locations and any
 * published pay, so no per-posting requests are needed; `company.query` is
 * matched against titles locally.
 *
 * Endpoint behaviour adapted from career-ops (MIT), which reads the RSS twin.
 */

const FORMAT: BoardFormat = {
  ats: "Teamtailor", shape: "the subdomain of <slug>.teamtailor.com, or \"<slug>.na\" for <slug>.na.teamtailor.com", example: "acme",
};
const HOST_SUFFIX = ".teamtailor.com";
const MAX_PAGES = 10;

const itemSchema = z.object({
  id: nonEmptyText,
  title: nonEmptyText,
  url: optionalText,
  date_published: optionalText,
  content_html: optionalText,
  _jobposting: z.unknown().optional(),
});
const feedSchema = z.object({ items: z.array(z.unknown()), next_url: optionalText });
type Item = z.infer<typeof itemSchema>;
type Entry = { item: Item; posting: JobPostingLd | null; id: string };

/** Splits `acme` or `acme.na` into the slug and its region label. */
function parseBoard(board: string): { slug: string; region: "" | "na" } {
  const [slug = "", region, extra] = board.trim().toLowerCase().split(".");
  if (!isDnsLabel(slug) || extra !== undefined || (region !== undefined && region !== "na")) throw invalidBoard(FORMAT, board);
  return { slug, region: region === "na" ? "na" : "" };
}

function hostFor(slug: string, region: "" | "na"): string {
  return `${slug}${region ? `.${region}` : ""}${HOST_SUFFIX}`;
}

function host(company: Company): string {
  const { slug, region } = parseBoard(company.board);
  return hostFor(slug, region);
}

function feedUrl(company: Company): string {
  return `https://${host(company)}/jobs.json`;
}

/** The numeric job id, from the posting identifier or the `/jobs/<id>-<slug>` URL. */
function jobId(item: Item, posting: JobPostingLd | null): string {
  if (posting?.identifier && /^\d+$/.test(posting.identifier)) return posting.identifier;
  try {
    const parts = pathParts(new URL(item.url ?? ""));
    const segment = parts[parts.indexOf("jobs") + 1] ?? "";
    return /^(\d+)(?:-|$)/.exec(segment)?.[1] ?? item.id;
  } catch {
    return item.id;
  }
}

async function readFeedAt(boardHost: string, company: Company): Promise<Entry[]> {
  let entries: Entry[] = [];
  let next: string | null = `https://${boardHost}/jobs.json`;
  for (let page = 0; next !== null && page < MAX_PAGES; page += 1) {
    const payload: unknown = await fetchJson<unknown>(next, { allowedHosts: [boardHost] });
    const feed = parseSourcePayload(feedSchema, payload, "Teamtailor feed");
    entries = [...entries, ...mapEach(feed.items, (raw): Entry | null => {
      const parsed = itemSchema.safeParse(raw);
      if (!parsed.success) return null;
      const posting = jobPostingFromNode(parsed.data._jobposting);
      return { item: parsed.data, posting, id: jobId(parsed.data, posting) };
    }, { ats: "teamtailor", board: company.board })];
    const following: URL | null = feed.next_url ? new URL(feed.next_url, `https://${boardHost}/`) : null;
    if (following && (following.protocol !== "https:" || following.hostname.toLowerCase() !== boardHost)) {
      throw new AppError("source_host_not_allowed", "Teamtailor feed pointed its next page at another host");
    }
    next = following?.href ?? null;
  }
  if (next !== null) logger.warn("Teamtailor feed page limit reached", { board: company.board, pages: MAX_PAGES });
  return entries;
}

async function readFeed(company: Company): Promise<Entry[]> {
  const { slug, region } = parseBoard(company.board);
  try {
    return await readFeedAt(hostFor(slug, region), company);
  } catch (error) {
    // North American tenants 404 on the global host; one retry finds them.
    if (region === "" && isGone(error)) return readFeedAt(hostFor(slug, "na"), company);
    throw error;
  }
}

function normalize(company: Company, entry: Entry, capturedAt: string): Job {
  const { item, posting } = entry;
  const places = (posting?.places ?? []).map((place) => locationLabel({ city: place.city, region: place.region, country: place.country }));
  const countries = countryValues([...(posting?.places ?? []).map((place) => place.country), ...(posting?.applicantCountries ?? [])]);
  const remote = posting?.remote === true;
  const url = item.url && /^https:\/\//i.test(item.url) ? item.url : `https://${host(company)}/jobs/${entry.id}`;
  return normalizePublicJob({
    company,
    externalId: entry.id,
    title: item.title,
    locations: [...new Set(places.filter(Boolean))],
    url,
    applyUrl: url,
    descriptionHtml: item.content_html || posting?.description || "",
    postedAt: posting?.datePosted ?? absoluteDate(item.date_published),
    workplaceType: remote ? "remote" : "unknown",
    isRemote: remote,
    employmentType: posting?.employmentType || undefined,
    structuredCompensation: posting?.pay ?? null,
    country: publishedCountry(countries),
  }, capturedAt, countries);
}

export const teamtailorAdapter: SourceAdapter = {
  kind: "teamtailor",
  listUrl: feedUrl,
  boardUrl: (company) => `https://${host(company)}/jobs`,

  async listJobs(company, capturedAt) {
    const entries = (await readFeed(company)).filter((entry) => matchesQuery(company.query, entry.item.title));
    return mapEach(entries, (entry) => normalize(company, entry, capturedAt), { ats: "teamtailor", board: company.board });
  },

  async verifyBoard(company) {
    return boardVerification((await readFeed(company)).map((entry) => entry.item.title));
  },

  probeUrls(slug) {
    const label = slug.trim().toLowerCase();
    return isDnsLabel(label)
      ? [`https://${label}${HOST_SUFFIX}/jobs.json`, `https://${label}.na${HOST_SUFFIX}/jobs.json`] : [];
  },

  parsePostingUrl(url) {
    const hostname = url.hostname.toLowerCase();
    if (!hostname.endsWith(HOST_SUFFIX)) return null;
    const labels = hostname.slice(0, -HOST_SUFFIX.length).split(".");
    const [slug = "", region] = labels;
    if (!isDnsLabel(slug) || labels.length > 2 || (region !== undefined && region !== "na") || slug === "www") return null;
    const parts = pathParts(url);
    const id = /^(\d+)(?:-|$)/.exec(parts[parts.indexOf("jobs") + 1] ?? "")?.[1];
    return parts.includes("jobs") && id ? { board: region ? `${slug}.${region}` : slug, externalId: id } : null;
  },

  async fetchPosting(company, externalId, capturedAt) {
    const entry = (await readFeed(company)).find((candidate) => candidate.id === externalId);
    return entry ? normalize(company, entry, capturedAt) : null;
  },

  /** The feed lists every published job, so absence from it means closed. */
  async checkPosting(job) {
    return safeCheck(async () => listingCheck(
      (await readFeed(companyFromJob(job))).some((entry) => entry.id === job.externalId), "Teamtailor"));
  },
};
