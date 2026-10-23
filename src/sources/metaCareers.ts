import type { Company } from "../domain/campaign.js";
import type { Job } from "../domain/job.js";
import { AppError } from "../util/errors.js";
import { logger } from "../util/logger.js";
import { fetchText, userAgent } from "./http.js";
import { asString, normalizeJob } from "./normalize.js";
import { fetchSourceResponse } from "./sourceRedirects.js";
import type { BoardVerification, SourceAdapter } from "./types.js";

/**
 * Meta Careers (metacareers.com).
 *
 * Search runs through the site's own GraphQL endpoint, which answers one query
 * with every match. The request needs the page's `lsd` token, read fresh from
 * the search page each time, and a persisted query id that Meta rotates when
 * it deploys: when it goes stale the endpoint answers with errors rather than
 * results, so set AUTOAPPLY_META_SEARCH_DOC_ID to the id the live search page
 * sends. Each posting's page carries a schema.org JobPosting block with the
 * description and qualifications.
 *
 * Board: a label only (e.g. `metacareers`); the company's `query` is the
 * search text.
 */

const ORIGIN = "https://www.metacareers.com";
const SEARCH_QUERY_NAME = "CareersJobSearchResultsV2DataQuery";
const DEFAULT_SEARCH_DOC_ID = "27129360303422352";

export type MetaPosting = { id: string; title: string; locations: string[]; teams: string[] };

export function metaJobUrl(id: string): string {
  return `${ORIGIN}/jobs/${encodeURIComponent(id)}/`;
}

export function metaApplyUrl(id: string): string {
  return `${ORIGIN}/profile/create_application/${encodeURIComponent(id)}/`;
}

export function metaSearchPageUrl(query: string): string {
  return `${ORIGIN}/jobsearch/?q=${encodeURIComponent(query.trim())}`;
}

/** The anti-CSRF token the GraphQL endpoint expects, as embedded in any page. */
export function parseLsdToken(html: string): string | null {
  return /"LSD",\[\],\{"token":"([^"]+)"/.exec(html)?.[1] ?? /name="lsd" value="([^"]+)"/.exec(html)?.[1] ?? null;
}

/** Reads search results out of a GraphQL response, failing loudly on a stale query id. */
export function parseMetaSearchResponse(text: string): MetaPosting[] {
  // The endpoint can stream several JSON documents; the first carries the data.
  const first = text.split("\n").find((line) => line.trim().startsWith("{")) ?? "";
  let payload: { data?: { job_search_with_featured_jobs_v2?: { all_jobs?: unknown[] } }; errors?: Array<{ message?: unknown }> };
  try {
    payload = JSON.parse(first) as typeof payload;
  } catch {
    throw new AppError("source_format", "Meta search returned something other than JSON");
  }
  const jobs = payload.data?.job_search_with_featured_jobs_v2?.all_jobs;
  if (!Array.isArray(jobs)) {
    const message = payload.errors?.map((error) => asString(error.message)).filter(Boolean).join("; ") ?? "";
    throw new AppError(
      "source_format",
      `Meta search returned no results list${message ? ` (${message})` : ""}; the persisted query id may have rotated - set AUTOAPPLY_META_SEARCH_DOC_ID`,
    );
  }
  return jobs.flatMap((job) => {
    // GraphQL returns null for a list item that failed to resolve.
    if (!job || typeof job !== "object") return [];
    const record = job as { id?: unknown; title?: unknown; locations?: unknown; teams?: unknown };
    const id = asString(record.id);
    const title = asString(record.title).trim();
    if (!id || !title) return [];
    const list = (value: unknown) => (Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []);
    return [{ id, title, locations: list(record.locations), teams: list(record.teams) }];
  });
}

export type MetaPostingDetail = { descriptionHtml: string; postedAt: string | null; locations: string[] };

/** Reads the schema.org JobPosting block from a posting page. */
export function parseMetaPostingPage(html: string): MetaPostingDetail | null {
  const block = /<script type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/.exec(html)?.[1];
  if (!block) return null;
  let ld: Record<string, unknown>;
  try {
    ld = JSON.parse(block) as Record<string, unknown>;
  } catch {
    return null;
  }
  const section = (heading: string, value: unknown) => {
    const text = asString(value).trim();
    return text ? `<h3>${heading}</h3><p>${text.replace(/\n/g, "<br>")}</p>` : "";
  };
  const places = Array.isArray(ld.jobLocation) ? ld.jobLocation : [];
  const locations = places
    .map((place) => asString((place as { name?: unknown }).name))
    .filter((name) => name.length > 0);
  return {
    descriptionHtml: [
      section("About the role", ld.description),
      section("Responsibilities", ld.responsibilities),
      section("Qualifications", ld.qualifications),
    ].join("\n"),
    postedAt: asString(ld.datePosted) || null,
    locations,
  };
}

function searchDocId(): string {
  return process.env.AUTOAPPLY_META_SEARCH_DOC_ID?.trim() || DEFAULT_SEARCH_DOC_ID;
}

async function searchMeta(query: string): Promise<MetaPosting[]> {
  const page = await fetchText(metaSearchPageUrl(query));
  const lsd = parseLsdToken(page);
  if (!lsd) throw new AppError("source_format", "Meta search page carried no lsd token");
  const variables = {
    search_input: {
      q: query.trim(),
      divisions: [],
      offices: [],
      roles: [],
      leadership_levels: [],
      saved_jobs: [],
      saved_searches: [],
      sub_teams: [],
      teams: [],
      is_leadership: false,
      is_remote_only: false,
      sort_by_new: false,
      results_per_page: null,
    },
    viewasUserID: null,
    isLoggedIn: false,
  };
  const body = new URLSearchParams({
    lsd,
    fb_api_caller_class: "RelayModern",
    fb_api_req_friendly_name: SEARCH_QUERY_NAME,
    variables: JSON.stringify(variables),
    server_timestamps: "true",
    doc_id: searchDocId(),
  });
  // A form-encoded POST, which the shared JSON client does not send. Same
  // honest User-Agent, and the host is pinned to Meta's own.
  const response = await fetchSourceResponse(
    `${ORIGIN}/graphql`,
    {
      method: "POST",
      headers: {
        "user-agent": userAgent(),
        accept: "*/*",
        "content-type": "application/x-www-form-urlencoded",
        "x-fb-lsd": lsd,
        "x-fb-friendly-name": SEARCH_QUERY_NAME,
      },
      body: body.toString(),
      signal: AbortSignal.timeout(30_000),
    },
    ["www.metacareers.com"],
    ["x-fb-lsd", "x-fb-friendly-name"],
  );
  if (!response.ok) throw new AppError("http_error", `HTTP ${response.status} from Meta search`);
  return parseMetaSearchResponse(await response.text());
}

export const metaCareersAdapter: SourceAdapter = {
  kind: "meta",

  listUrl(company: Company): string {
    return metaSearchPageUrl(company.query);
  },

  boardUrl(company: Company): string {
    return metaSearchPageUrl(company.query);
  },

  async listJobs(company: Company, capturedAt: string): Promise<Job[]> {
    const postings = await searchMeta(company.query);
    const jobs: Job[] = [];
    for (const posting of postings) {
      let detail: MetaPostingDetail | null = null;
      try {
        detail = parseMetaPostingPage(await fetchText(metaJobUrl(posting.id)));
      } catch (error) {
        logger.warn("meta posting page unreadable; keeping the search summary", { id: posting.id, error: String(error) });
      }
      jobs.push(
        normalizeJob(
          {
            company,
            externalId: posting.id,
            title: posting.title,
            locations: detail?.locations.length ? detail.locations : posting.locations,
            url: metaJobUrl(posting.id),
            applyUrl: metaApplyUrl(posting.id),
            descriptionHtml: detail?.descriptionHtml ?? "",
            postedAt: detail?.postedAt ?? null,
          },
          capturedAt,
        ),
      );
    }
    return jobs;
  },

  probeUrls(): string[] {
    return [];
  },

  async verifyBoard(company: Company): Promise<BoardVerification> {
    const postings = await searchMeta(company.query);
    return {
      ok: postings.length > 0,
      postings: postings.length,
      sampleTitles: postings.slice(0, 3).map((posting) => posting.title),
      detail: postings.length > 0 ? "search returned postings" : "search matched no postings",
    };
  },
};
