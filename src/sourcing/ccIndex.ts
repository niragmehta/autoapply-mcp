import { z } from "zod";
import { userAgent } from "../sources/http.js";
import { AppError } from "../util/errors.js";
import type { HarvestAts } from "../db/repositories/harvest.js";

/**
 * Client for the public Common Crawl URL index (CDX API).
 *
 * Every crawl publishes an index of the URLs it captured. Querying it for an
 * ATS host lists the public job boards the crawler happened to see, which is
 * far more than any curated list - the source of most companies this project
 * would never otherwise hear about. The index server is shared and often
 * overloaded: 502 and 504 answers are normal, so every request retries with a
 * growing delay, and pages are fetched one at a time with a pause between.
 */

export const CC_HOST = "index.commoncrawl.org";
const INDEX_ID = /^CC-MAIN-\d{4}-\d{2}$/;

export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;

export type CdxClientOptions = {
  fetchImpl?: FetchLike;
  /** Total tries per request, including the first. */
  attempts?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  timeoutMs?: number;
  /** Pause between consecutive page requests. */
  pageDelayMs?: number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** Called before each retry, for progress reporting. */
  onRetry?: (detail: string) => void;
};

export type CrawlIndex = { id: string; name: string; from: string; to: string };

/** One query per ATS host. Workday tenants live on subdomains, so it is a domain query. */
export const HARVEST_QUERIES: Readonly<Record<HarvestAts, ReadonlyArray<{ url: string; matchType?: "domain" }>>> = {
  greenhouse: [{ url: "job-boards.greenhouse.io/*" }, { url: "boards.greenhouse.io/*" }],
  ashby: [{ url: "jobs.ashbyhq.com/*" }],
  lever: [{ url: "jobs.lever.co/*" }, { url: "jobs.eu.lever.co/*" }],
  workday: [{ url: "myworkdayjobs.com", matchType: "domain" }],
};

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export function abortError(): AppError {
  return new AppError("aborted", "the run was cancelled");
}

export function isAbort(error: unknown): boolean {
  return error instanceof AppError && error.code === "aborted";
}

/** GET with retries on 429/5xx and network failures. A 404 means "no captures" and returns null. */
async function getText(url: string, options: CdxClientOptions, signal?: AbortSignal): Promise<string | null> {
  const fetchImpl = options.fetchImpl ?? ((input, init) => fetch(input, init));
  const sleep = options.sleep ?? abortableSleep;
  const attempts = Math.max(1, options.attempts ?? 6);
  const base = options.baseDelayMs ?? 10_000;
  const max = options.maxDelayMs ?? 60_000;
  let lastError = "";
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (signal?.aborted) throw abortError();
    const timeout = AbortSignal.timeout(options.timeoutMs ?? 180_000);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const response = await fetchImpl(url, { headers: { "user-agent": userAgent(), accept: "application/json" }, signal: combined });
      if (response.status === 404) return null;
      if (response.ok) return await response.text();
      lastError = `HTTP ${response.status}`;
      await response.body?.cancel().catch(() => undefined);
      if (!RETRYABLE.has(response.status)) break;
    } catch (error) {
      if (signal?.aborted) throw abortError();
      lastError = error instanceof Error ? error.message : String(error);
    }
    if (attempt < attempts - 1) {
      const delay = Math.min(max, base * 2 ** attempt);
      options.onRetry?.(`${lastError}; retrying in ${Math.round(delay / 1000)}s`);
      await sleep(delay, signal);
    }
  }
  throw new AppError("cc_unavailable", `Common Crawl index request failed (${lastError}): ${url}`, { url });
}

const CollinfoSchema = z.array(
  z.object({ id: z.string(), name: z.string().default(""), from: z.string().default(""), to: z.string().default("") }).passthrough(),
);

/** Crawl indexes, newest first, as published at collinfo.json. */
export async function listCrawlIndexes(options: CdxClientOptions = {}, signal?: AbortSignal): Promise<CrawlIndex[]> {
  const body = await getText(`https://${CC_HOST}/collinfo.json`, options, signal);
  const parsed = CollinfoSchema.safeParse(JSON.parse(body ?? "[]"));
  if (!parsed.success) throw new AppError("cc_invalid_response", "collinfo.json did not have the expected shape");
  return parsed.data
    .filter((entry) => INDEX_ID.test(entry.id))
    .map((entry) => ({ id: entry.id, name: entry.name, from: entry.from, to: entry.to }))
    .sort((a, b) => b.id.localeCompare(a.id));
}

export function cdxUrl(indexId: string, query: { url: string; matchType?: "domain" }, extra: string): string {
  if (!INDEX_ID.test(indexId)) throw new AppError("invalid_index", `not a Common Crawl index id: ${indexId}`);
  const match = query.matchType ? `&matchType=${query.matchType}` : "";
  return `https://${CC_HOST}/${indexId}-index?url=${encodeURIComponent(query.url)}${match}&output=json&fl=url&${extra}`;
}

export async function cdxPageCount(indexId: string, query: { url: string; matchType?: "domain" }, options: CdxClientOptions = {}, signal?: AbortSignal): Promise<number> {
  const body = await getText(cdxUrl(indexId, query, "showNumPages=true"), options, signal);
  if (!body) return 0;
  const pages = (JSON.parse(body) as { pages?: unknown }).pages;
  return typeof pages === "number" && Number.isInteger(pages) && pages >= 0 ? pages : 0;
}

/** The URLs on one page of results. Malformed lines are skipped. */
export async function cdxPage(indexId: string, query: { url: string; matchType?: "domain" }, page: number, options: CdxClientOptions = {}, signal?: AbortSignal): Promise<string[]> {
  const body = await getText(cdxUrl(indexId, query, `page=${page}`), options, signal);
  return parseCdxLines(body ?? "");
}

export function parseCdxLines(body: string): string[] {
  const urls: string[] = [];
  for (const line of body.split("\n")) {
    if (!line.trim()) continue;
    try {
      const value = (JSON.parse(line) as { url?: unknown }).url;
      if (typeof value === "string") urls.push(value);
    } catch {
      // A truncated or garbled line costs one URL, not the page.
    }
  }
  return urls;
}

export type CrawlBoard = { ats: HarvestAts; board: string; region: "global" | "eu" };

const GREENHOUSE_RESERVED = new Set(["embed", "v1", "jobs", "api", "assets", "static", "static_files", "favicon.ico", "robots.txt", "sitemap.xml", "users", "login", "job_app", "careers"]);
const PATH_RESERVED = new Set(["api", "embed", "static", "assets", "_next", "favicon.ico", "robots.txt", "sitemap.xml", "jobs", "job", "careers", "_health"]);
const WORKDAY_SKIP_SITE = /^(?:wday|login|job|jobs|details|apply|userhome|internal|intern|staffing|en-us)$/i;
const LOCALE = /^[a-z]{2}(?:-[A-Za-z]{2,4})?$/;
const SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/;

/** The board a crawled URL belongs to, for the ATS hosts harvesting covers. */
export function boardFromCrawlUrl(raw: string): CrawlBoard | null {
  let url: URL;
  try {
    url = new URL(raw.replace(/^http:\/\//i, "https://"));
  } catch {
    return null;
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  const segments = url.pathname.split("/").filter(Boolean).map((segment) => {
    try {
      return decodeURIComponent(segment);
    } catch {
      return segment;
    }
  });
  const first = segments[0] ?? "";

  if (host === "job-boards.greenhouse.io" || host === "boards.greenhouse.io") {
    const slug = (url.searchParams.get("for") ?? (GREENHOUSE_RESERVED.has(first.toLowerCase()) ? "" : first)).toLowerCase();
    return /^[a-z0-9][a-z0-9_-]{1,60}$/.test(slug) && !GREENHOUSE_RESERVED.has(slug) ? { ats: "greenhouse", board: slug, region: "global" } : null;
  }
  if (host === "jobs.ashbyhq.com") {
    return SLUG.test(first) && !PATH_RESERVED.has(first.toLowerCase()) ? { ats: "ashby", board: first, region: "global" } : null;
  }
  if (host === "jobs.lever.co" || host === "jobs.eu.lever.co") {
    return SLUG.test(first) && !PATH_RESERVED.has(first.toLowerCase()) ? { ats: "lever", board: first, region: host === "jobs.eu.lever.co" ? "eu" : "global" } : null;
  }
  const workday = /^([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com$/.exec(host);
  if (workday) {
    const site = LOCALE.test(first) ? segments[1] : first;
    if (!site || WORKDAY_SKIP_SITE.test(site) || !/^[A-Za-z0-9_.-]{2,80}$/.test(site)) return null;
    return { ats: "workday", board: `${workday[1]}/${workday[2]}/${site}`, region: "global" };
  }
  return null;
}

/**
 * De-duplication key. Workday is keyed by tenant: one employer publishes
 * several career sites (external, internal, university) and only one is wanted.
 */
export function harvestKey(ats: string, board: string): string {
  if (ats === "workday") return `workday:${board.split("/")[0]!.toLowerCase()}`;
  return `${ats}:${board.toLowerCase()}`;
}
