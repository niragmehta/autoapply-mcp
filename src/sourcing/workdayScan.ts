import type { Campaign, Company } from "../domain/campaign.js";
import type { Job } from "../domain/job.js";
import { detectSeniority } from "../ranking/gates.js";
import { fetchJson } from "../sources/http.js";
import { asString, asStringArray, normalizeJob } from "../sources/normalize.js";
import { publishedDate } from "../sources/sourceValidation.js";
import { parseBoard, postedOnToIso } from "../sources/workday.js";
import { logger } from "../util/logger.js";

/**
 * Title-first scan of a Workday board.
 *
 * The Workday adapter reads every posting's detail page, which suits a
 * configured board but not a sweep of thousands of harvested tenants. Here the
 * list endpoint is searched with the campaign's own title phrases, titles that
 * could never pass the gates are dropped, and only the survivors cost a detail
 * request. The detail-to-Job mapping mirrors the adapter's so evaluation sees
 * the same shape.
 */

const PAGE_SIZE = 20;
const MAX_QUERIES = 3;

type ListEntry = { title?: unknown; externalPath?: unknown; postedOn?: unknown };
type Detail = {
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

/** Search phrases for the list endpoint: the tracks' title phrases, a few at most. */
export function workdayQueries(campaign: Campaign): string[] {
  const phrases = campaign.tracks.flatMap((track) => track.titleIncludes.map((phrase) => phrase.trim().toLowerCase()));
  const unique = [...new Set(phrases.filter((phrase) => phrase.length > 0))];
  return unique.length > 0 ? unique.slice(0, MAX_QUERIES) : [""];
}

function containsWord(haystack: string, needle: string): boolean {
  const escaped = needle.toLowerCase().trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return escaped.length > 0 && new RegExp(`(^|[^a-z0-9])${escaped}([^a-z0-9]|$)`, "i").test(haystack);
}

/**
 * Whether a title alone could pass the gates and score into a track. Cheap and
 * deliberately lenient where the full evaluation is the judge: it only drops
 * titles the exclusions or seniority rules would reject outright, or that match
 * no track's title phrases at all.
 */
export function titleMayFit(title: string, campaign: Campaign): boolean {
  const lower = title.toLowerCase();
  if (campaign.exclusions.titlePatterns.some((pattern) => containsWord(lower, pattern))) return false;
  const seniority = detectSeniority(title);
  if (campaign.seniority.reject.includes(seniority)) return false;
  if (campaign.seniority.allow.length > 0 && !campaign.seniority.allow.includes(seniority)) return false;
  const tracks = campaign.tracks.filter((track) => track.titleIncludes.length > 0);
  if (tracks.length === 0) return true;
  return tracks.some(
    (track) =>
      track.titleIncludes.some((phrase) => lower.includes(phrase.toLowerCase())) &&
      !track.titleExcludes.some((phrase) => lower.includes(phrase.toLowerCase())),
  );
}

function country(detail: Detail): string | undefined {
  const value = detail.country;
  const descriptor = value && typeof value === "object" ? asString((value as { descriptor?: unknown }).descriptor).trim() : "";
  if (/^united states(?: of america)?$/i.test(descriptor)) return "US";
  if (/^canada$/i.test(descriptor)) return "CA";
  return undefined;
}

function toJob(company: Company, detail: Detail, path: string, capturedAt: string): Job {
  const board = parseBoard(company.board);
  const locations = [...new Set([asString(detail.location), ...asStringArray(detail.additionalLocations)].map((value) => value.trim()).filter(Boolean))];
  const external = asString(detail.externalUrl);
  const url = /(^|\.)myworkdaysite\.com$/i.test(safeHost(external)) || !external
    ? `https://${board.tenant}.${board.datacenter}.myworkdayjobs.com/${board.site}${path}`
    : external;
  const absolute = publishedDate(asString(detail.startDate));
  return normalizeJob(
    {
      company,
      externalId: asString(detail.id) || asString(detail.jobReqId),
      title: asString(detail.title),
      locations,
      url,
      applyUrl: url,
      descriptionHtml: asString(detail.jobDescription),
      postedAt: absolute ? new Date(absolute).toISOString() : postedOnToIso(asString(detail.postedOn), new Date(capturedAt)),
      isRemote: asString(detail.remoteType).toLowerCase().includes("remote") || locations.some((value) => /\bremote\b/i.test(value)),
      employmentType: asString(detail.timeType),
      country: country(detail),
    },
    capturedAt,
  );
}

function safeHost(value: string): string {
  try {
    return new URL(value).hostname;
  } catch {
    return "";
  }
}

export type WorkdayScan = { jobs: Job[]; postings: number };

export async function scanWorkdayBoard(
  company: Company,
  campaign: Campaign,
  capturedAt: string,
  options: { maxDetails?: number } = {},
): Promise<WorkdayScan> {
  const board = parseBoard(company.board);
  const base = `https://${board.tenant}.${board.datacenter}.myworkdayjobs.com/wday/cxs/${board.tenant}/${board.site}`;
  const freshest = new Date(new Date(capturedAt).getTime() - campaign.freshnessDays * 86_400_000).toISOString();
  const paths = new Set<string>();
  let postings = 0;
  for (const searchText of workdayQueries(campaign)) {
    const payload = await fetchJson<{ jobPostings?: ListEntry[]; total?: unknown }>(`${base}/jobs`, {
      body: { appliedFacets: {}, limit: PAGE_SIZE, offset: 0, searchText },
      retries: 1,
    });
    if (typeof payload.total === "number") postings = Math.max(postings, payload.total);
    for (const entry of payload.jobPostings ?? []) {
      const path = asString(entry.externalPath);
      const posted = postedOnToIso(asString(entry.postedOn), new Date(capturedAt));
      if (!path.startsWith("/") || !titleMayFit(asString(entry.title), campaign)) continue;
      if (posted && posted < freshest) continue;
      paths.add(path);
    }
  }
  const jobs: Job[] = [];
  for (const path of [...paths].slice(0, options.maxDetails ?? 8)) {
    try {
      const payload = await fetchJson<{ jobPostingInfo?: Detail }>(`${base}${path}`, { retries: 1 });
      const detail = payload.jobPostingInfo;
      if (!detail || detail.posted === false || detail.canApply === false) continue;
      jobs.push(toJob(company, detail, path, capturedAt));
    } catch (error) {
      logger.warn("workday scan detail failed", { board: company.board, error: String(error) });
    }
  }
  return { jobs, postings: Math.max(postings, paths.size) };
}
