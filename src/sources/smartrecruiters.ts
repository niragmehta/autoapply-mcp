import { z } from "zod";
import type { Company } from "../domain/campaign.js";
import type { Job } from "../domain/job.js";
import { AppError, toErrorMessage } from "../util/errors.js";
import { fetchJson } from "./http.js";
import {
  boardToken, boardVerification, locationLabel, nonEmptyText, normalizePublicJob,
  optionalText, parseSourcePayload, postingIdentifier, publishedDate, publishedSalary,
} from "./sourceValidation.js";
import type { SourceAdapter } from "./types.js";

const HOST = "api.smartrecruiters.com";
const ALLOWED_HOSTS = [HOST] as const;
const PAGE_SIZE = 100;
const MAX_POSTINGS = 10_000;
const MAX_PAGES = 1_000;

const summarySchema = z.object({
  id: postingIdentifier,
  name: nonEmptyText,
  active: z.boolean().optional(),
  visibility: optionalText,
});
const pageSchema = z.object({
  content: z.array(summarySchema),
  totalFound: z.number().int().nonnegative(),
  offset: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().optional(),
});
const detailSchema = summarySchema.extend({
  location: z.object({
    city: optionalText, region: optionalText, country: optionalText, fullLocation: optionalText,
    remote: z.boolean().optional(), hybrid: z.boolean().optional(),
  }),
  releasedDate: optionalText,
  releaseDate: optionalText,
  typeOfEmployment: z.object({ label: optionalText }).nullish(),
  jobAd: z.object({
    sections: z.record(z.string(), z.object({ title: optionalText, text: optionalText }))
      .refine((sections) => Object.values(sections).some((section) => (section.text?.trim().length ?? 0) > 0)),
  }),
  compensation: z.unknown().optional(),
});
type Summary = z.infer<typeof summarySchema>;

function apiBase(company: Company): string {
  return `https://${HOST}/v1/companies/${boardToken(company.board)}/postings`;
}

function listingUrl(company: Company, offset = 0, limit = PAGE_SIZE): string {
  const query = new URLSearchParams({
    limit: String(limit), offset: String(offset), ...(company.query ? { q: company.query } : {}),
  });
  return `${apiBase(company)}?${query}`;
}

function isPublished(posting: Summary): boolean {
  return posting.active !== false && (!posting.visibility || posting.visibility.toUpperCase() === "PUBLIC");
}

async function listPostings(company: Company): Promise<Summary[]> {
  let postings: Summary[] = [];
  let expectedTotal: number | undefined;
  for (let pageNumber = 0; pageNumber < MAX_PAGES; pageNumber += 1) {
    const offset = postings.length;
    const page = parseSourcePayload(pageSchema,
      await fetchJson<unknown>(listingUrl(company, offset), { allowedHosts: ALLOWED_HOSTS }), "SmartRecruiters");
    if (page.totalFound > MAX_POSTINGS) {
      throw new AppError("source_limit", `SmartRecruiters exceeds the ${MAX_POSTINGS} posting limit; narrow company.query`);
    }
    if ((expectedTotal !== undefined && page.totalFound !== expectedTotal)
      || (page.offset !== undefined && page.offset !== offset)) {
      throw new AppError("source_pagination", "SmartRecruiters pagination offset or total changed during discovery");
    }
    expectedTotal = page.totalFound;
    const next = [...postings, ...page.content];
    if (new Set(next.map((posting) => posting.id)).size !== next.length) {
      throw new AppError("source_pagination", "SmartRecruiters pagination repeated a posting identifier");
    }
    if (next.length > expectedTotal || (page.content.length === 0 && offset < expectedTotal)) {
      throw new AppError("source_pagination", "SmartRecruiters pagination made no valid progress toward totalFound");
    }
    postings = next;
    if (postings.length === expectedTotal) return postings.filter(isPublished);
  }
  throw new AppError("source_limit", `SmartRecruiters exceeded the ${MAX_PAGES} page ceiling; narrow company.query`);
}

async function readPosting(company: Company, summary: Summary, capturedAt: string): Promise<Job | null> {
  const payload = await fetchJson<unknown>(`${apiBase(company)}/${summary.id}`, { allowedHosts: ALLOWED_HOSTS });
  const identity = parseSourcePayload(summarySchema, payload, "SmartRecruiters detail");
  if (identity.id !== summary.id) {
    throw new AppError("invalid_source_payload", "SmartRecruiters detail identifier does not match the requested posting");
  }
  if (!isPublished(identity)) return null;
  const detail = parseSourcePayload(detailSchema, payload, "SmartRecruiters detail");
  const location = locationLabel(detail.location) || detail.location.fullLocation || "";
  const workplaceType = detail.location.hybrid ? "hybrid" : detail.location.remote ? "remote" : "unknown";
  const url = `https://jobs.smartrecruiters.com/${boardToken(company.board)}/${detail.id}`;
  return normalizePublicJob({
    company, externalId: detail.id, title: detail.name,
    locations: location ? [location] : [], url, applyUrl: `${url}?oga=true`,
    descriptionHtml: Object.values(detail.jobAd.sections).map((section) => section.text ?? "").filter(Boolean).join("\n"),
    postedAt: publishedDate(detail.releasedDate ?? detail.releaseDate),
    workplaceType, isRemote: workplaceType === "remote",
    employmentType: detail.typeOfEmployment?.label ?? undefined,
    structuredCompensation: publishedSalary(detail.compensation),
  }, capturedAt, [detail.location.country ?? ""]);
}

/** Public Posting API; list summaries never authorize arbitrary detail URLs. */
export const smartrecruitersAdapter: SourceAdapter = {
  kind: "smartrecruiters",
  listUrl: listingUrl,
  boardUrl: (company) => `https://careers.smartrecruiters.com/${boardToken(company.board)}`,
  async listJobs(company, capturedAt) {
    const summaries = await listPostings(company);
    let jobs: Job[] = [];
    for (const summary of summaries) {
      const job = await readPosting(company, summary, capturedAt);
      if (job) jobs = [...jobs, job];
    }
    return jobs;
  },
  async verifyBoard(company) {
    const page = parseSourcePayload(pageSchema,
      await fetchJson<unknown>(listingUrl(company, 0, 3), { allowedHosts: ALLOWED_HOSTS, retries: 0 }), "SmartRecruiters");
    return boardVerification(page.content.filter(isPublished).map((posting) => posting.name), page.totalFound);
  },
  probeUrls: () => [],

  /**
   * The detail's `active` flag and visibility decide. SmartRecruiters answers
   * an id it does not know with 400 or 404, which is not closure evidence.
   */
  async checkPosting(job) {
    try {
      const id = postingIdentifier.parse(job.externalId);
      const payload = await fetchJson<unknown>(`https://${HOST}/v1/companies/${boardToken(job.board)}/postings/${id}`, {
        allowedHosts: ALLOWED_HOSTS, retries: 1, timeoutMs: 12_000,
      });
      const identity = summarySchema.safeParse(payload);
      if (!identity.success || identity.data.id !== job.externalId) {
        return { status: "unknown", via: "api", detail: "SmartRecruiters answered without this posting's id" };
      }
      return isPublished(identity.data)
        ? { status: "open", via: "api", detail: "SmartRecruiters marks the posting active and public" }
        : { status: "closed", via: "api", detail: "SmartRecruiters marks the posting inactive or no longer public" };
    } catch (error) {
      return { status: "unknown", via: "api", detail: `SmartRecruiters check failed: ${toErrorMessage(error)}` };
    }
  },

  /** jobs.smartrecruiters.com/{company}/{id}[-{slug}]. */
  parsePostingUrl(url) {
    if (url.hostname.toLowerCase() !== "jobs.smartrecruiters.com") return null;
    const [board, posting] = url.pathname.split("/").filter((segment) => segment.length > 0);
    const id = /^(\d{6,20})(?:-[^/]*)?$/.exec(posting ?? "")?.[1];
    if (!board || !id || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,99}$/.test(board)) return null;
    return { board, externalId: id };
  },

  async fetchPosting(company, externalId, capturedAt) {
    if (!postingIdentifier.safeParse(externalId).success) {
      throw new AppError("invalid_posting_id", `not a SmartRecruiters posting id: ${externalId}`);
    }
    try {
      return await readPosting(company, { id: externalId, name: externalId }, capturedAt);
    } catch (error) {
      if (error instanceof AppError && (error.code === "not_found" || error.details.status === 400)) return null;
      throw error;
    }
  },
};
