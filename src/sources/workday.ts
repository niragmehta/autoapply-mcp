import type { Company } from "../domain/campaign.js";
import type { Job } from "../domain/job.js";
import { AppError } from "../util/errors.js";
import { logger } from "../util/logger.js";
import { fetchJson } from "./http.js";
import { asString, asStringArray, normalizeJob } from "./normalize.js";
import type { SourceAdapter } from "./types.js";

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
  postedOn?: unknown;
  timeType?: unknown;
  jobReqId?: unknown;
  remoteType?: unknown;
  externalUrl?: unknown;
  canApply?: unknown;
  posted?: unknown;
};

/**
 * Converts Workday's relative posting age to an ISO date.
 *
 * Workday publishes no absolute posting date anywhere in either payload, only
 * strings like "Posted 11 Days Ago". This is therefore an approximation to the
 * day, and deliberately returns null rather than a fabricated date when the
 * phrasing is not understood.
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
    const now = new Date(capturedAt);
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

      const locationValues = locations(detail);
      const applyUrl = asString(detail.externalUrl);

      jobs.push(
        normalizeJob(
          {
            company,
            externalId: asString(detail.id) || asString(detail.jobReqId),
            title: asString(detail.title),
            locations: locationValues,
            url: applyUrl,
            applyUrl,
            descriptionHtml: asString(detail.jobDescription),
            postedAt: postedOnToIso(asString(detail.postedOn), now),
            isRemote: isRemote(detail, locationValues),
            employmentType: asString(detail.timeType),
          },
          capturedAt,
        ),
      );
    }

    return jobs;
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
};
