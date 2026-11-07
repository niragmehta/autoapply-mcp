import { z } from "zod";
import { AppError } from "../../util/errors.js";
import { fetchJson, fetchText } from "../http.js";
import { SOURCE_MIN_INTERVAL_MS, leadSalary, parseSourceResponse, parseSourceSearchInput, sourcePagination } from "../leadTypes.js";
import type { JobLead, SourceAttribution, SourceSearchInput, SourceSearchResult } from "../leadTypes.js";
import { countryCode } from "../smb/geo.js";
import { isWildcardQuery } from "../smb/query.js";
import { countryName } from "../sourceValidation.js";
import { buildLead, cachedFetch, httpsUrl, parseRows, skippedNotice, unsupportedFilter } from "./common.js";
import { GETRO_NETWORKS, siteHost, type GetroNetwork } from "./networks.js";

/**
 * VC portfolio job boards powered by Getro.
 *
 * `site` names the network: a known board host (for example
 * jobs.generalcatalyst.com), any `<name>.getro.com` board, or a numeric Getro
 * collection id. Getro's public search API answers 20 jobs a page with the
 * portfolio company and the job's own ATS link, which becomes the lead's
 * apply URL for employer-board verification.
 *
 * Endpoint behaviour adapted from career-ops (MIT).
 */

const API_HOST = "api.getro.com";
const HITS_PER_PAGE = 20;
const CACHE_TTL_MS = 10 * 60_000;
const ID_TTL_MS = 24 * 60 * 60_000;
/** Getro also reports "period_not_defined"; only a stated unit is kept. */
const PAY_PERIODS = new Set(["year", "month", "week", "day", "hour"]);

const JobSchema = z.object({
  id: z.union([z.number().int().positive(), z.string().regex(/^\d+$/)]).transform(String),
  title: z.string().trim().min(1),
  url: z.string().nullish(),
  slug: z.string().nullish(),
  created_at: z.union([z.number(), z.string()]).nullish(),
  locations: z.array(z.string()).nullish(),
  work_mode: z.string().nullish(),
  seniority: z.string().nullish(),
  compensation_public: z.boolean().nullish(),
  compensation_amount_min_cents: z.number().nullish(),
  compensation_amount_max_cents: z.number().nullish(),
  compensation_currency: z.string().nullish(),
  compensation_period: z.string().nullish(),
  organization: z.object({ name: z.string().nullish(), slug: z.string().nullish() }).nullish(),
});
const ResponseSchema = z.object({
  results: z.object({ jobs: z.array(z.unknown()), count: z.number().int().nonnegative() }),
});
type GetroJob = z.infer<typeof JobSchema>;
type Network = { host: string | null; name: string; collectionId: string };

const LIMITATIONS = [
  "Getro boards aggregate portfolio companies' own career pages; verify each job on its applyUrl (the employer's ATS) before preparing an application.",
  "Search returns 20 jobs a page. Country or location filter Getro's searchable locations; company is not supported.",
  "Search results carry no description; read the employer posting.",
  `Accepted sites: ${GETRO_NETWORKS.map((network) => network.host).join(", ")}, any <name>.getro.com board, or a numeric Getro collection id.`,
] as const;

function attribution(network: Network): SourceAttribution {
  return {
    label: `${network.name} job board (Getro)`,
    url: network.host ? `https://${network.host}/jobs` : "https://www.getro.com",
    changes: "Search results normalized into unverified job leads; compensation converted from cents.",
    requirements: [
      `Credit the ${network.name} job board, powered by Getro, and link to the listing.`,
      "Do not republish the network's listings.",
    ],
  };
}

/** Reads `network.id` from a Getro board page's Next.js data, without executing it. */
export function getroCollectionId(html: string): string | null {
  const match = /<script\b[^>]*\sid\s*=\s*["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i.exec(html);
  try {
    const id: unknown = (JSON.parse(match?.[1] ?? "") as { props?: { pageProps?: { network?: { id?: unknown } } } })
      .props?.pageProps?.network?.id;
    const text = typeof id === "number" ? String(id) : typeof id === "string" ? id : "";
    return /^[1-9]\d*$/.test(text) ? text : null;
  } catch {
    return null;
  }
}

async function network(site: string | undefined): Promise<Network> {
  if (!site) throw unsupportedFilter("Getro", "missing site", "Set site to a Getro network board host or collection id.");
  if (/^[1-9]\d{0,9}$/.test(site.trim())) return { host: null, name: `Getro collection ${site.trim()}`, collectionId: site.trim() };
  const host = siteHost(site);
  const known: GetroNetwork | undefined = GETRO_NETWORKS.find((candidate) => candidate.host === host);
  if (known) return known;
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.getro\.com$/.test(host) || host.startsWith("www.") || host === "api.getro.com") {
    throw unsupportedFilter("Getro", "site", LIMITATIONS[3]);
  }
  const { value: id } = await cachedFetch(`getro-id:${host}`, ID_TTL_MS, async () =>
    getroCollectionId(await fetchText(`https://${host}/jobs`, { allowedHosts: [host], maxBytes: 4 * 1024 * 1024 })));
  if (!id) throw new AppError("invalid_source_response", `getro board ${host} did not publish a collection id.`, { source: "getro" });
  return { host, name: host, collectionId: id };
}

function sourceUrl(job: GetroJob, net: Network, endpoint: string): string {
  const org = job.organization?.slug ?? "";
  const slug = job.slug ?? "";
  return net.host && /^[a-z0-9-]+$/i.test(org) && /^[a-z0-9-]+$/i.test(slug)
    ? `https://${net.host}/companies/${org}/jobs/${slug}` : endpoint;
}

function toLead(job: GetroJob, net: Network, endpoint: string, retrievedAt: string): JobLead {
  const locations = (job.locations ?? []).map((location) => location.trim()).filter(Boolean);
  const remote = job.work_mode === "remote" && !locations.some((location) => /remote/i.test(location));
  const cents = (value: number | null | undefined) => (typeof value === "number" && value > 0 ? value / 100 : null);
  const period = job.compensation_period?.trim().toLowerCase() ?? "";
  return buildLead("getro", endpoint, retrievedAt, {
    sourceId: job.id,
    sourceUrl: sourceUrl(job, net, endpoint),
    title: job.title,
    company: job.organization?.name?.trim() ?? "",
    locations: remote ? [...locations, "Remote"] : locations,
    locationRestrictions: [],
    timezoneRestrictions: [],
    description: "",
    salary: job.compensation_public === false ? undefined : leadSalary(
      cents(job.compensation_amount_min_cents), cents(job.compensation_amount_max_cents),
      job.compensation_currency, PAY_PERIODS.has(period) ? period : undefined),
    publishedAt: typeof job.created_at === "number" ? new Date(job.created_at * 1000).toISOString()
      : typeof job.created_at === "string" && !Number.isNaN(Date.parse(job.created_at)) ? new Date(job.created_at).toISOString() : undefined,
    applyUrl: httpsUrl(job.url),
    publishedAtRaw: job.created_at ?? undefined,
  });
}

export async function searchGetro(input: SourceSearchInput): Promise<SourceSearchResult> {
  const search = parseSourceSearchInput(input);
  const net = await network(search.site);
  const page = (search.page ?? 1) - 1;
  const place = search.location ?? (search.country ? countryName(countryCode(search.country) ?? search.country) : undefined);
  const endpoint = `https://${API_HOST}/api/v2/collections/${net.collectionId}/search/jobs`;
  const body = {
    hitsPerPage: HITS_PER_PAGE, page,
    filters: { page, ...(place ? { searchable_locations: [place] } : {}) },
    query: isWildcardQuery(search.query) ? "" : search.query,
  };
  const { value, retrievedAt } = await cachedFetch(`${endpoint}#${JSON.stringify(body)}`, CACHE_TTL_MS, () =>
    fetchJson<unknown>(endpoint, { body, allowedHosts: [API_HOST], minIntervalMs: SOURCE_MIN_INTERVAL_MS }));
  const data = parseSourceResponse(ResponseSchema, value, "getro").results;
  const { items, skipped } = parseRows(data.jobs, (row) => {
    const parsed = JobSchema.safeParse(row);
    return parsed.success ? parsed.data : null;
  }, "getro");
  const leads = items.slice(0, search.limit).map((job) => toLead(job, net, endpoint, retrievedAt));
  return {
    source: "getro", readiness: "ready", leads,
    pagination: sourcePagination(page + 1, HITS_PER_PAGE, items.length, leads.length, data.count),
    attribution: attribution(net),
    limitations: [...LIMITATIONS, ...skippedNotice(skipped)],
  };
}
