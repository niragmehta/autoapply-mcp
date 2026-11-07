import { z } from "zod";
import { AppError } from "../../util/errors.js";
import { fetchJson } from "../http.js";
import { SOURCE_MIN_INTERVAL_MS, leadSalary, parseSourceResponse, parseSourceSearchInput, sourcePagination } from "../leadTypes.js";
import type { JobLead, LeadSalary, SourceAttribution, SourceSearchInput, SourceSearchResult } from "../leadTypes.js";
import { absoluteDate } from "../smb/dates.js";
import { countryCode } from "../smb/geo.js";
import { isWildcardQuery } from "../smb/query.js";
import { countryName } from "../sourceValidation.js";
import { fetchPageWithSession } from "./boardSession.js";
import { buildLead, cachedFetch, httpsUrl, openEndedPagination, parseRows, skippedNotice, unsupportedFilter } from "./common.js";
import { CONSIDER_NETWORKS, siteHost } from "./networks.js";

/**
 * VC portfolio job boards built on Consider (consider.com).
 *
 * `site` names a known board host, e.g. jobs.sequoiacap.com. The board page
 * hands every visitor an anonymous session and CSRF token, which its own
 * search request then carries; this connector does the same, once per search.
 * Each job links to the employer's own ATS posting, which becomes the lead's
 * apply URL. Pages continue with an opaque cursor, so page N replays N-1
 * cursors (capped at page 5).
 *
 * Endpoint behaviour adapted from career-ops (MIT).
 */

const SEARCH_PATH = "/api-boards/search-jobs";
const PAGE_SIZE = 50;
const MAX_PAGE = 5;
const CACHE_TTL_MS = 10 * 60_000;
const PAY_PERIODS = new Set(["year", "month", "week", "day", "hour"]);

const BoardSchema = z.object({ id: z.string().trim().min(1), isParent: z.boolean().optional() });
const ServerDataSchema = z.object({ csrfToken: z.string().min(8), board: BoardSchema });
const SalarySchema = z.object({
  minValue: z.number().nonnegative().nullish(),
  maxValue: z.number().nonnegative().nullish(),
  currency: z.object({ value: z.string().regex(/^[A-Za-z]{3}$/).nullish() }).nullish(),
  period: z.object({ value: z.string().nullish() }).nullish(),
});
const JobSchema = z.object({
  jobId: z.string().min(1),
  title: z.string().trim().min(1),
  url: z.string().nullish(),
  applyUrl: z.string().nullish(),
  companyName: z.string().nullish(),
  locations: z.array(z.string()).nullish(),
  normalizedLocations: z.array(z.object({ label: z.string().nullish(), value: z.string().nullish() })).nullish(),
  remote: z.boolean().nullish(),
  hybrid: z.boolean().nullish(),
  timeStamp: z.union([z.string(), z.number()]).nullish(),
  applicationWindow: z.object({ status: z.string().nullish() }).nullish(),
  salary: z.unknown().optional(),
});
const PageSchema = z.object({
  jobs: z.array(z.unknown()),
  total: z.number().int().nonnegative().optional(),
  meta: z.object({ sequence: z.string().nullish() }).nullish(),
});
type ConsiderJob = z.infer<typeof JobSchema>;
type Page = z.infer<typeof PageSchema>;

const LIMITATIONS = [
  "Consider boards aggregate portfolio companies' own career pages; verify each job on its applyUrl (the employer's ATS) before preparing an application.",
  "Query matches the start of job-title words (Consider's titlePrefix). Location \"remote\" limits to remote jobs; other locations and country use Consider's location filter. Company is not supported.",
  "Search results carry no description; read the employer posting.",
  "Consider reports a total but pages continue by cursor; pages beyond 5 are not fetched.",
  `Accepted sites: ${CONSIDER_NETWORKS.map((network) => network.host).join(", ")}.`,
] as const;

function attribution(name: string, host: string): SourceAttribution {
  return {
    label: `${name} job board (Consider)`,
    url: `https://${host}/jobs`,
    changes: "Search results normalized into unverified job leads; employer ATS links retained.",
    requirements: [`Credit the ${name} job board, powered by Consider, and link to it.`, "Do not republish the network's listings."],
  };
}

/** Reads `window.serverInitialData`, the board page's own state, as data. */
export function considerServerData(html: string): z.infer<typeof ServerDataSchema> {
  const match = /window\.serverInitialData\s*=\s*(\{.*?\})\s*;?\s*(?:<\/script>|$)/m.exec(html);
  let parsed: unknown;
  try {
    parsed = JSON.parse(match?.[1] ?? "");
  } catch {
    throw new AppError("invalid_source_response", "consider board page did not carry its session data.", { source: "consider" });
  }
  return parseSourceResponse(ServerDataSchema, parsed, "consider");
}

function query(search: SourceSearchInput): Record<string, unknown> {
  const location = search.location?.trim();
  const place = location && !/^remote$/i.test(location) ? location
    : search.country ? countryName(countryCode(search.country) ?? search.country) : undefined;
  return {
    promoteFeatured: true,
    ...(isWildcardQuery(search.query) ? {} : { titlePrefix: search.query }),
    ...(location && /^remote$/i.test(location) ? { remoteOnly: true } : {}),
    ...(place ? { locations: [place] } : {}),
  };
}

/** The employer's published range; a malformed salary is dropped, never the job. */
function salary(value: unknown): LeadSalary | undefined {
  const parsed = SalarySchema.safeParse(value);
  if (!parsed.success) return undefined;
  const { minValue, maxValue, currency, period } = parsed.data;
  const unit = period?.value?.trim().toLowerCase() ?? "";
  return leadSalary(minValue || null, maxValue || null, currency?.value?.toUpperCase(), PAY_PERIODS.has(unit) ? unit : undefined);
}

function toLead(job: ConsiderJob, host: string, endpoint: string, retrievedAt: string): JobLead {
  const locations = (job.locations?.length ? job.locations : (job.normalizedLocations ?? []).map((entry) => entry.label ?? entry.value ?? ""))
    .map((location) => location.trim()).filter(Boolean);
  const mode = job.remote ? "Remote" : job.hybrid ? "Hybrid" : "";
  return buildLead("consider", endpoint, retrievedAt, {
    sourceId: job.jobId,
    sourceUrl: `https://${host}/jobs`,
    title: job.title,
    company: job.companyName?.trim() ?? "",
    locations: mode && !locations.some((location) => location.toLowerCase().includes(mode.toLowerCase())) ? [...locations, mode] : locations,
    locationRestrictions: [],
    timezoneRestrictions: [],
    description: "",
    salary: salary(job.salary),
    publishedAt: absoluteDate(job.timeStamp) ?? undefined,
    applyUrl: httpsUrl(job.applyUrl) ?? httpsUrl(job.url),
    publishedAtRaw: job.timeStamp ?? undefined,
  });
}

async function readPages(host: string, body: Record<string, unknown>, page: number): Promise<{ data: Page; retrievedAt: string }> {
  const session = await fetchPageWithSession(`https://${host}/jobs`, host);
  const state = considerServerData(session.html);
  const headers = { "x-csrf-token": state.csrfToken, ...(session.cookie ? { cookie: session.cookie } : {}), referer: `https://${host}/jobs` };
  let sequence: string | null = null;
  let data: Page | null = null;
  for (let index = 0; index < page; index += 1) {
    if (index > 0 && !sequence) return { data: { jobs: [], meta: null }, retrievedAt: new Date().toISOString() };
    const request: Record<string, unknown> = {
      meta: sequence ? { size: PAGE_SIZE, sequence } : { size: PAGE_SIZE }, board: { isParent: true, ...state.board }, query: body,
    };
    const payload: unknown = await fetchJson<unknown>(`https://${host}${SEARCH_PATH}`, {
      body: request, headers, allowedHosts: [host], minIntervalMs: SOURCE_MIN_INTERVAL_MS,
    });
    data = parseSourceResponse(PageSchema, payload, "consider");
    sequence = data.meta?.sequence ?? null;
  }
  return { data: data ?? { jobs: [], meta: null }, retrievedAt: new Date().toISOString() };
}

export async function searchConsider(input: SourceSearchInput): Promise<SourceSearchResult> {
  const search = parseSourceSearchInput(input);
  const host = search.site ? siteHost(search.site) : "";
  const network = CONSIDER_NETWORKS.find((candidate) => candidate.host === host);
  if (!network) throw unsupportedFilter("Consider", "site", LIMITATIONS[4]);
  const page = search.page ?? 1;
  if (page > MAX_PAGE) throw unsupportedFilter("Consider", "page", `Pages beyond ${MAX_PAGE} are not fetched; narrow the search instead.`);
  const body = query(search);
  const endpoint = `https://${host}${SEARCH_PATH}`;
  const { value } = await cachedFetch(`${endpoint}#${page}#${JSON.stringify(body)}`, CACHE_TTL_MS, () => readPages(host, body, page));
  const { items: parsed, skipped } = parseRows(value.data.jobs, (row) => {
    const result = JobSchema.safeParse(row);
    return result.success ? result.data : null;
  }, "consider");
  const items = parsed.filter((job) => !job.applicationWindow?.status || job.applicationWindow.status === "accepting");
  const leads = items.slice(0, search.limit).map((job) => toLead(job, host, endpoint, value.retrievedAt));
  const hasMore = Boolean(value.data.meta?.sequence) && value.data.jobs.length >= PAGE_SIZE;
  const total = value.data.total;
  return {
    source: "consider", readiness: "ready", leads,
    pagination: total === undefined
      ? openEndedPagination(page, PAGE_SIZE, items.length, leads.length, hasMore)
      : sourcePagination(page, PAGE_SIZE, items.length, leads.length, total, Math.min(MAX_PAGE, Math.ceil(total / PAGE_SIZE))),
    attribution: attribution(network.name, host),
    limitations: [...LIMITATIONS, ...skippedNotice(skipped)],
  };
}
