import type { Company } from "../domain/campaign.js";
import type { Job } from "../domain/job.js";
import { AppError, toErrorMessage } from "../util/errors.js";
import { logger } from "../util/logger.js";
import { fetchJson, userAgent } from "./http.js";
import { asString, asStringArray, normalizeJob } from "./normalize.js";
import { fetchSourceResponse } from "./sourceRedirects.js";
import { publishedDate } from "./sourceValidation.js";
import type { BoardVerification, PostingCheck, PostingRef, SourceAdapter } from "./types.js";

/**
 * Workday "CXS" public career-site API.
 *
 * Workday is the only supported system with no single board token. A site is
 * addressed by three parts that have to be read off the employer's own career
 * page, so `company.board` carries them as `tenant/datacenter/site`, e.g.
 * `nvidia/wd5/NVIDIAExternalCareerSite`.
 *
 * It is also the only two-phase source. The list endpoint returns just a title,
 * a relative path and an unusable location summary ("5 Locations"), so the
 * description, real locations and pay range each cost a second request per
 * posting. Descriptions matter here because Workday employers are largely US
 * pay-transparency filers, and the range is stated in the description body
 * rather than a structured field.
 */

/** Workday rejects any page size above 20. */
const PAGE_SIZE = 20;

/**
 * Per-board ceiling on postings. Each posting costs a detail request, and large
 * tenants publish thousands of unrelated roles, so an unbounded crawl would be
 * both slow and rude. Prefer narrowing with `company.query` over raising this.
 */
function maxPostings(): number {
  const raw = Number.parseInt(process.env.AUTOAPPLY_WORKDAY_MAX_POSTINGS ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 200;
}

export type WorkdayBoard = { tenant: string; datacenter: string; site: string };

/**
 * Splits the `tenant/datacenter/site` board value.
 *
 * Fails loudly rather than guessing a datacenter: Workday tenants are spread
 * across wd1..wd103 with no derivable pattern, so a wrong guess would silently
 * report an empty board instead of a misconfiguration.
 */
export function parseBoard(board: string): WorkdayBoard {
  const parts = board.split("/").map((part) => part.trim()).filter((part) => part.length > 0);
  if (parts.length !== 3) {
    throw new AppError(
      "invalid_board",
      `workday board must be "tenant/datacenter/site" (e.g. nvidia/wd5/NVIDIAExternalCareerSite), got: ${board}`,
      { board },
    );
  }
  const [tenant, datacenter, site] = parts as [string, string, string];
  if (!/^wd\d+$/.test(datacenter)) {
    throw new AppError(
      "invalid_board",
      `workday datacenter must look like "wd5", got: ${datacenter}`,
      { board, datacenter },
    );
  }
  return { tenant, datacenter, site };
}

function apiBase(board: WorkdayBoard): string {
  return `https://${board.tenant}.${board.datacenter}.myworkdayjobs.com/wday/cxs/${board.tenant}/${board.site}`;
}

type WorkdayListEntry = {
  title?: unknown;
  externalPath?: unknown;
  locationsText?: unknown;
  postedOn?: unknown;
  bulletFields?: unknown;
};

type WorkdayDetail = {
  id?: unknown;
  title?: unknown;
  jobDescription?: unknown;
  location?: unknown;
  additionalLocations?: unknown;
  startDate?: unknown;
  postedOn?: unknown;
  timeType?: unknown;
  jobReqId?: unknown;
  remoteType?: unknown;
  externalUrl?: unknown;
  canApply?: unknown;
  posted?: unknown;
  country?: unknown;
};

/**
 * The posting's country as "US" or "CA", read from the `{ descriptor }` object
 * Workday attaches to each detail. Anywhere else reads as nothing, so the
 * location text alone decides.
 */
function publishedCountry(detail: WorkdayDetail): string | undefined {
  const value = detail.country;
  const descriptor = value && typeof value === "object" ? asString((value as { descriptor?: unknown }).descriptor) : "";
  if (/^united states(?: of america)?$/i.test(descriptor.trim())) return "US";
  if (/^canada$/i.test(descriptor.trim())) return "CA";
  return undefined;
}

/**
 * Converts Workday's relative posting age to an ISO date.
 *
 * Used only when the detail has no valid absolute startDate. Relative labels
 * are approximate, and a capped "30+ Days Ago" value is only a lower age bound.
 */
export function postedOnToIso(postedOn: string, now: Date): string | null {
  const text = postedOn.toLowerCase();
  if (text.includes("today") || text.includes("just posted")) return isoDay(now, 0);
  if (text.includes("yesterday")) return isoDay(now, 1);
  const days = /(\d+)\+?\s*day/.exec(text);
  if (days?.[1]) return isoDay(now, Number.parseInt(days[1], 10));
  const months = /(\d+)\+?\s*month/.exec(text);
  if (months?.[1]) return isoDay(now, Number.parseInt(months[1], 10) * 30);
  return null;
}

function postingDate(detail: WorkdayDetail, now: Date): string | null {
  const absolute = publishedDate(asString(detail.startDate));
  if (absolute) return new Date(absolute).toISOString();
  if (detail.startDate != null && detail.startDate !== "") {
    logger.warn("invalid Workday startDate; using approximate relative posting age", {
      jobReqId: asString(detail.jobReqId),
    });
  }
  return postedOnToIso(asString(detail.postedOn), now);
}

function isoDay(now: Date, daysAgo: number): string {
  const date = new Date(now.getTime() - daysAgo * 86_400_000);
  return `${date.toISOString().slice(0, 10)}T00:00:00.000Z`;
}

function locations(detail: WorkdayDetail): string[] {
  const all = [asString(detail.location), ...asStringArray(detail.additionalLocations)];
  return [...new Set(all.map((value) => value.trim()).filter((value) => value.length > 0))];
}

function isRemote(detail: WorkdayDetail, locationValues: string[]): boolean {
  if (asString(detail.remoteType).toLowerCase().includes("remote")) return true;
  return locationValues.some((value) => /\bremote\b/i.test(value));
}

/**
 * Some tenants publish postings on myworkdaysite.com. The same requisition is
 * served on the tenant's myworkdayjobs.com host, which is the host the
 * submission driver and the ATS allowlist recognise.
 */
function tenantHostUrl(externalUrl: string, board: WorkdayBoard, path: string): string {
  let host = "";
  try {
    host = new URL(externalUrl).hostname;
  } catch {
    return externalUrl;
  }
  if (!/(^|\.)myworkdaysite\.com$/i.test(host)) return externalUrl;
  return `https://${board.tenant}.${board.datacenter}.myworkdayjobs.com/${board.site}${path}`;
}

/** Walks the paginated list endpoint, collecting posting paths. */
async function listPaths(company: Company, board: WorkdayBoard): Promise<string[]> {
  const url = `${apiBase(board)}/jobs`;
  const cap = maxPostings();
  const paths: string[] = [];

  for (let offset = 0; paths.length < cap; offset += PAGE_SIZE) {
    const payload = await fetchJson<{ jobPostings?: WorkdayListEntry[] }>(url, {
      body: { appliedFacets: {}, limit: PAGE_SIZE, offset, searchText: company.query },
    });
    const page = payload.jobPostings ?? [];
    if (page.length === 0) break;

    for (const entry of page) {
      const path = asString(entry.externalPath);
      if (path.startsWith("/") && paths.length < cap) paths.push(path);
    }
    if (page.length < PAGE_SIZE) break;
  }

  return paths;
}

export const workdayAdapter: SourceAdapter = {
  kind: "workday",

  listUrl(company: Company): string {
    return `${apiBase(parseBoard(company.board))}/jobs`;
  },

  boardUrl(company: Company): string {
    const board = parseBoard(company.board);
    return `https://${board.tenant}.${board.datacenter}.myworkdayjobs.com/${board.site}`;
  },

  async listJobs(company: Company, capturedAt: string): Promise<Job[]> {
    const board = parseBoard(company.board);
    const base = apiBase(board);
    const paths = await listPaths(company, board);
    const jobs: Job[] = [];

    for (const path of paths) {
      let detail: WorkdayDetail;
      try {
        const payload = await fetchJson<{ jobPostingInfo?: WorkdayDetail }>(`${base}${path}`);
        if (!payload.jobPostingInfo) continue;
        detail = payload.jobPostingInfo;
      } catch (error) {
        // One dead posting must not lose the rest of the board. Workday
        // unpublishes roles between the list call and the detail call often
        // enough that this is normal, not exceptional.
        logger.warn("workday detail failed", { company: company.name, path, error: String(error) });
        continue;
      }

      if (detail.posted === false || detail.canApply === false) continue;
      jobs.push(toJob(company, board, path, detail, capturedAt));
    }

    return jobs;
  },

  /**
   * Verifies with a single list request instead of the full two-phase crawl.
   *
   * A wrong Workday site slug does not 404. The host answers 200 with a generic
   * page, so the only trustworthy signal is the presence of a `jobPostings`
   * array — checking the status code alone accepts boards that do not exist.
   */
  async verifyBoard(company: Company): Promise<BoardVerification> {
    const board = parseBoard(company.board);
    const payload = await fetchJson<{ jobPostings?: unknown; total?: unknown }>(`${apiBase(board)}/jobs`, {
      body: { appliedFacets: {}, limit: 5, offset: 0, searchText: company.query },
      retries: 0,
    });

    if (!Array.isArray(payload.jobPostings)) {
      return {
        ok: false,
        postings: 0,
        sampleTitles: [],
        detail: "responded without a jobPostings array, which means the site slug is wrong",
      };
    }

    const titles = (payload.jobPostings as WorkdayListEntry[])
      .map((entry) => asString(entry.title))
      .filter((title) => title.length > 0);

    return {
      ok: titles.length > 0,
      postings: typeof payload.total === "number" ? payload.total : titles.length,
      sampleTitles: titles.slice(0, 3),
      detail: titles.length > 0 ? "board returned postings" : "board exists but matched no postings for this query",
    };
  },

  /**
   * Workday boards cannot be probed from a company name. The datacenter number
   * and the site slug are both arbitrary per tenant, so the search space is far
   * too large to guess at politely. Board resolution reports this honestly
   * instead of emitting hundreds of speculative requests.
   */
  probeUrls(): string[] {
    return [];
  },

  /**
   * Re-reads the posting's CXS detail. Workday answers 404 for a removed
   * posting and a structured 403 (errorCode S22) for a withdrawn one; a
   * detail with `posted` or `canApply` false no longer takes applications.
   */
  async checkPosting(job: Job): Promise<PostingCheck> {
    const result = (status: PostingCheck["status"], detail: string): PostingCheck => ({ status, via: "api", detail });
    try {
      const board = parseBoard(job.board);
      const path = jobPathOf(job.url) ?? jobPathOf(job.applyUrl);
      if (!path) return result("unknown", "the stored posting URL has no Workday /job/ path");
      const { status, payload } = await readDetail(board, path);
      if (status === 404) return result("closed", "Workday no longer has the posting (404)");
      if (status === 403 && errorCodeOf(payload) === "S22") return result("closed", "Workday reports the posting withdrawn (403 S22)");
      if (status !== 200) return result("unknown", `Workday answered HTTP ${status}`);
      const detail = (payload as { jobPostingInfo?: WorkdayDetail } | null)?.jobPostingInfo;
      if (!detail) return result("unknown", "Workday answered without posting details");
      if (detail.posted === false) return result("closed", "Workday marks the posting unpublished");
      if (detail.canApply === false) return result("closed", "Workday no longer accepts applications for the posting");
      return result("open", "Workday still publishes the posting and accepts applications");
    } catch (error) {
      return result("unknown", `Workday check failed: ${toErrorMessage(error)}`);
    }
  },

  /**
   * `{tenant}.{wdN}.myworkdayjobs.com[/{locale}]/{site}/job/...` and
   * `{wdN}.myworkdaysite.com[/{locale}]/recruiting/{tenant}/{site}/job/...`.
   * Workday addresses a posting by its `/job/...` path, so that path is the
   * reference's externalId.
   */
  parsePostingUrl(url: URL): PostingRef | null {
    const host = url.hostname.toLowerCase();
    const segments = url.pathname.split("/").filter((segment) => segment.length > 0);
    const parts = LOCALE_SEGMENT.test(segments[0] ?? "") ? segments.slice(1) : segments;
    let tenant: string | undefined;
    let datacenter: string | undefined;
    let rest: string[];
    const tenantHost = /^([a-z0-9-]+)\.(wd\d+)\.myworkdayjobs\.com$/.exec(host);
    const siteHost = /^(wd\d+)\.myworkdaysite\.com$/.exec(host);
    if (tenantHost) {
      [, tenant, datacenter] = tenantHost;
      rest = parts;
    } else if (siteHost && parts[0] === "recruiting") {
      datacenter = siteHost[1];
      tenant = parts[1];
      rest = parts.slice(2);
    } else {
      return null;
    }
    const [site, marker, ...jobPath] = rest;
    if (!tenant || !datacenter || !site || marker !== "job" || jobPath.length === 0) return null;
    if (!WORKDAY_TOKEN.test(tenant) || !WORKDAY_TOKEN.test(site) || jobPath.some((part) => part === "..")) return null;
    return { board: `${tenant}/${datacenter}/${site}`, externalId: `/job/${jobPath.join("/")}` };
  },

  async fetchPosting(company: Company, externalId: string, capturedAt: string): Promise<Job | null> {
    if (!externalId.startsWith("/job/") || externalId.split("/").includes("..")) {
      throw new AppError("invalid_posting_id", "Workday postings are addressed by their /job/ path");
    }
    const board = parseBoard(company.board);
    try {
      const payload = await fetchJson<{ jobPostingInfo?: WorkdayDetail }>(`${apiBase(board)}${externalId}`);
      const detail = payload.jobPostingInfo;
      if (!detail || detail.posted === false || detail.canApply === false) return null;
      return toJob(company, board, externalId, detail, capturedAt);
    } catch (error) {
      if (error instanceof AppError && error.code === "not_found") return null;
      throw error;
    }
  },
};

const LOCALE_SEGMENT = /^[a-z]{2}-[A-Z]{2}$/;
const WORKDAY_TOKEN = /^[A-Za-z0-9_-]{1,100}$/;

function toJob(company: Company, board: WorkdayBoard, path: string, detail: WorkdayDetail, capturedAt: string): Job {
  const locationValues = locations(detail);
  const applyUrl = tenantHostUrl(asString(detail.externalUrl), board, path);
  return normalizeJob(
    {
      company,
      externalId: asString(detail.id) || asString(detail.jobReqId),
      title: asString(detail.title),
      locations: locationValues,
      url: applyUrl,
      applyUrl,
      descriptionHtml: asString(detail.jobDescription),
      postedAt: postingDate(detail, new Date(capturedAt)),
      isRemote: isRemote(detail, locationValues),
      employmentType: asString(detail.timeType),
      country: publishedCountry(detail),
    },
    capturedAt,
  );
}

/** The `/job/...` part of a stored posting URL, locale prefix and all ignored. */
function jobPathOf(value: string): string | null {
  let pathname: string;
  try {
    pathname = new URL(value).pathname;
  } catch {
    return null;
  }
  const index = pathname.indexOf("/job/");
  if (index < 0) return null;
  const path = pathname.slice(index);
  return path.split("/").includes("..") ? null : path;
}

function errorCodeOf(payload: unknown): string {
  return payload !== null && typeof payload === "object" ? asString((payload as { errorCode?: unknown }).errorCode) : "";
}

/**
 * One detail read that keeps the status and body of a refusal. The shared
 * client drops the body of a 403, and a withdrawn posting is told apart from
 * an access block only by the body's error code.
 */
async function readDetail(board: WorkdayBoard, path: string): Promise<{ status: number; payload: unknown }> {
  const host = `${board.tenant}.${board.datacenter}.myworkdayjobs.com`;
  const response = await fetchSourceResponse(
    `${apiBase(board)}${path}`,
    {
      method: "GET",
      headers: { accept: "application/json", "user-agent": userAgent(), "accept-language": "en-US,en;q=0.9" },
      signal: AbortSignal.timeout(12_000),
    },
    [host],
  );
  const text = await response.text();
  try {
    return { status: response.status, payload: JSON.parse(text) as unknown };
  } catch {
    return { status: response.status, payload: null };
  }
}
