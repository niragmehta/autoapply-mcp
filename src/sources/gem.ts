import { z } from "zod";
import type { Company } from "../domain/campaign.js";
import type { Job, WorkplaceType } from "../domain/job.js";
import { fetchJson } from "./http.js";
import { companyFromJob, pathParts, postingId, segmentBoard, type BoardFormat } from "./smb/board.js";
import { isGone, openCheck, safeCheck } from "./smb/checks.js";
import { absoluteDate } from "./smb/dates.js";
import { mapEach } from "./smb/details.js";
import { matchesQuery } from "./smb/query.js";
import { boardVerification, nonEmptyText, normalizePublicJob, optionalText, parseSourcePayload } from "./sourceValidation.js";
import type { SourceAdapter } from "./types.js";

/**
 * Gem Job Board API (documented, unauthenticated reads).
 * https://api.gem.com/job_board/v0/reference
 *
 * Board: the vanity path of `https://jobs.gem.com/<board>`, e.g. `acme`.
 * One request returns every published post with its full description, so no
 * per-posting requests are needed. Gem has no search parameter, so
 * `company.query` is matched against titles and departments locally.
 *
 * Endpoint behaviour adapted from career-ops (MIT).
 */

const FORMAT: BoardFormat = { ats: "Gem", shape: "the vanity path of jobs.gem.com/<board>", example: "acme" };
const API_HOST = "api.gem.com";
const BOARD_HOST = "jobs.gem.com";

const nameSchema = z.object({ name: optionalText }).partial().nullish();
const postSchema = z.object({
  id: nonEmptyText,
  title: nonEmptyText,
  absolute_url: optionalText,
  content: optionalText,
  content_plain: optionalText,
  first_published_at: optionalText,
  created_at: optionalText,
  location: nameSchema,
  location_type: optionalText,
  employment_type: optionalText,
  offices: z.array(z.object({ name: optionalText, location: nameSchema }).partial()).nullish(),
  departments: z.array(z.object({ name: optionalText }).partial()).nullish(),
});
type Post = z.infer<typeof postSchema>;

function board(company: Company): string {
  return segmentBoard(company.board, FORMAT);
}

function listUrl(company: Company): string {
  return `https://${API_HOST}/job_board/v0/${encodeURIComponent(board(company))}/job_posts/`;
}

async function readPosts(company: Company): Promise<Post[]> {
  const payload = await fetchJson<unknown>(listUrl(company), { allowedHosts: [API_HOST] });
  return mapEach(parseSourcePayload(z.array(z.unknown()), payload, "Gem job posts"), (row) => {
    const parsed = postSchema.safeParse(row);
    return parsed.success ? parsed.data : null;
  }, { ats: "gem", board: company.board });
}

async function readPost(company: Company, id: string): Promise<Post> {
  const payload = await fetchJson<unknown>(`${listUrl(company)}${encodeURIComponent(postingId(id, FORMAT.ats))}`, {
    allowedHosts: [API_HOST],
  });
  return parseSourcePayload(postSchema, payload, "Gem job post");
}

const WORKPLACE: Readonly<Record<string, WorkplaceType>> = { remote: "remote", hybrid: "hybrid", in_office: "onsite" };

/** Gem's own posting link, rebuilt when the payload points anywhere else. */
function postingUrl(company: Company, post: Post): string {
  try {
    const url = new URL(post.absolute_url ?? "");
    if (url.protocol === "https:" && url.hostname.toLowerCase() === BOARD_HOST) return url.href;
  } catch {
    // Fall through to the canonical shape.
  }
  return `https://${BOARD_HOST}/${encodeURIComponent(board(company))}/${encodeURIComponent(post.id)}`;
}

function normalize(company: Company, post: Post, capturedAt: string): Job {
  const type = WORKPLACE[(post.location_type ?? "").toLowerCase()] ?? "unknown";
  const offices = (post.offices ?? []).map((office) => office.location?.name || office.name || "");
  const url = postingUrl(company, post);
  return normalizePublicJob({
    company,
    externalId: post.id,
    title: post.title,
    locations: [...new Set([post.location?.name ?? "", ...offices].filter(Boolean))],
    url,
    applyUrl: url,
    descriptionHtml: post.content ?? "",
    descriptionPlain: post.content ? undefined : post.content_plain ?? undefined,
    postedAt: absoluteDate(post.first_published_at) ?? absoluteDate(post.created_at),
    workplaceType: type,
    isRemote: type === "remote",
    employmentType: post.employment_type ?? undefined,
  }, capturedAt, []);
}

export const gemAdapter: SourceAdapter = {
  kind: "gem",
  listUrl,
  boardUrl: (company) => `https://${BOARD_HOST}/${encodeURIComponent(board(company))}`,

  async listJobs(company, capturedAt) {
    const posts = (await readPosts(company)).filter((post) =>
      matchesQuery(company.query, post.title, ...(post.departments ?? []).map((department) => department.name)));
    return mapEach(posts, (post) => normalize(company, post, capturedAt), { ats: "gem", board: company.board });
  },

  async verifyBoard(company) {
    return boardVerification((await readPosts(company)).map((post) => post.title));
  },

  probeUrls(slug) {
    const candidate = slug.trim().toLowerCase();
    return /^[a-z0-9][a-z0-9_-]{0,99}$/.test(candidate)
      ? [`https://${API_HOST}/job_board/v0/${encodeURIComponent(candidate)}/job_posts/`] : [];
  },

  parsePostingUrl(url) {
    if (url.hostname.toLowerCase() !== BOARD_HOST) return null;
    const [boardPath, id, extra] = pathParts(url);
    if (!boardPath || !id || extra !== undefined) return null;
    return /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(boardPath) && /^[A-Za-z0-9_-]{1,200}$/.test(id)
      ? { board: boardPath, externalId: id } : null;
  },

  async fetchPosting(company, externalId, capturedAt) {
    try {
      return normalize(company, await readPost(company, externalId), capturedAt);
    } catch (error) {
      if (isGone(error)) return null;
      throw error;
    }
  },

  async checkPosting(job) {
    return safeCheck(async () => {
      await readPost(companyFromJob(job), job.externalId);
      return openCheck("Gem still serves this job post");
    });
  },
};
