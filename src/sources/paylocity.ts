import { z } from "zod";
import type { Company } from "../domain/campaign.js";
import type { Job, WorkplaceType } from "../domain/job.js";
import { AppError } from "../util/errors.js";
import { fetchText } from "./http.js";
import { normalizeJob } from "./normalize.js";
import { boardVerification, parseSourcePayload } from "./sourceValidation.js";
import type { PostingCheck, SourceAdapter } from "./types.js";
import { invalidBoard } from "./enterprise/boards.js";
import { checkFromError, closedCheck, httpStatus, openCheck, unknownCheck, unparseableBoardCheck } from "./enterprise/checks.js";
import { normalizeEach, validRows, withDetails } from "./enterprise/collect.js";
import type { DetailResult } from "./enterprise/collect.js";
import { isoInstant } from "./enterprise/dates.js";
import { maxDetails, maxPostings } from "./enterprise/limits.js";
import { balancedObject, elementInner, inlineText, innerHtmlOf } from "./enterprise/markup.js";

/**
 * Paylocity hosted job boards. Endpoint behaviour adapted from career-ops (MIT).
 *
 * Board: the board GUID, e.g. "a432d829-f701-4cf3-9108-56ef703b2ac5", read off
 * https://recruiting.paylocity.com/Recruiting/Jobs/All/<guid>.
 *
 * The board page embeds every posting in one `window.pageData` script, so a
 * listing is one request; descriptions come from each posting's Details page.
 * A posting's own URL does not name its board, so pasted posting URLs cannot
 * be resolved to a board, and there is no server-side search.
 */

const KIND = "paylocity" as const;
const HOST = "recruiting.paylocity.com";
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const JOB_ID = /^\d{1,12}$/;
const EXPECTED = 'the board GUID (e.g. a432d829-f701-4cf3-9108-56ef703b2ac5), read off https://recruiting.paylocity.com/Recruiting/Jobs/All/<guid>';

export function parsePaylocityBoard(board: string): string {
  const guid = board.trim().toLowerCase();
  if (!GUID.test(guid)) {
    throw invalidBoard(KIND, board, EXPECTED, (url) => {
      const found = /\/Recruiting\/Jobs\/All\/([0-9a-f-]{36})/i.exec(url.pathname)?.[1];
      return url.hostname.toLowerCase() === HOST && found && GUID.test(found) ? found.toLowerCase() : null;
    });
  }
  return guid;
}

function boardPageUrl(guid: string): string {
  return `https://${HOST}/Recruiting/Jobs/All/${guid}`;
}

export function paylocityPostingUrl(jobId: string): string {
  return `https://${HOST}/Recruiting/Jobs/Details/${jobId}`;
}

const text = z.string().nullish();
const jobSchema = z.object({
  JobId: z.union([z.string(), z.number()]).transform(String).pipe(z.string().regex(JOB_ID)),
  JobTitle: z.string().trim().min(1),
  LocationName: text,
  ShouldDisplayLocation: z.boolean().nullish(),
  PublishedDate: text,
  Description: text,
  IsInternal: z.boolean().nullish(),
  HiringDepartment: text,
  JobLocation: z.object({ City: text, State: text }).nullish(),
  IsRemote: z.boolean().nullish(),
  IndeedRemoteType: z.union([z.number(), z.string()]).nullish(),
});
type PaylocityJob = z.infer<typeof jobSchema>;
const pageDataSchema = z.object({ Jobs: z.array(z.unknown()), ModuleTitle: text });

/** The board's `window.pageData` object; throws when the page is not a job board. */
export function paylocityPageData(html: string): z.infer<typeof pageDataSchema> {
  const marker = html.indexOf("window.pageData");
  const json = marker >= 0 ? balancedObject(html, marker) : null;
  if (!json) throw new AppError("not_found", "Paylocity answered without a job board (unknown board GUID?)");
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch {
    throw new AppError("invalid_source_payload", "Paylocity board data is not valid JSON");
  }
  return parseSourcePayload(pageDataSchema, value, "Paylocity board");
}

async function readBoard(guid: string, company: Company): Promise<PaylocityJob[]> {
  const data = paylocityPageData(await fetchText(boardPageUrl(guid), { allowedHosts: [HOST], timeoutMs: 30_000 }));
  return validRows(jobSchema, data.Jobs, { kind: KIND, company }).filter((job) => job.IsInternal !== true);
}

export type PaylocityDetail = { title: string; location: string; descriptionHtml: string };

/** A Details page: title, location line and the description below the apply button. */
export function parsePaylocityDetail(html: string): PaylocityDetail | null {
  const details = /<div\b[^>]*class\s*=\s*["'][^"']*\bjob-preview-details\b[^"']*["'][^>]*>/i.exec(html);
  if (!details) return null;
  const block = elementInner(html, details.index) ?? "";
  const button = /<div\b[^>]*class\s*=\s*["'][^"']*\bmobile-apply-btn\b[^"']*["'][^>]*>/i.exec(block);
  const description = button ? block.slice(0, button.index) + block.slice(button.index + (`${button[0]}${elementInner(block, button.index) ?? ""}</div>`).length) : block;
  return {
    title: inlineText(innerHtmlOf(html, /<span\b[^>]*class\s*=\s*["'][^"']*\bjob-preview-title\b[^"']*["'][^>]*>/i) ?? ""),
    location: inlineText((innerHtmlOf(html, /<div\b[^>]*class\s*=\s*["'][^"']*\bpreview-location\b[^"']*["'][^>]*>/i) ?? "").split(/<span>\s*&bull;\s*<\/span>/i)[0] ?? ""),
    descriptionHtml: description,
  };
}

/** A Details page; `gone` when Paylocity redirects it to "Job Not Found". */
async function readDetail(jobId: string): Promise<DetailResult<PaylocityDetail>> {
  let html: string;
  try {
    html = await fetchText(paylocityPostingUrl(jobId), { allowedHosts: [HOST] });
  } catch (error) {
    const status = httpStatus(error);
    if (status === 404 || status === 410) return { status: "gone" };
    throw error;
  }
  const detail = parsePaylocityDetail(html);
  if (detail) return { status: "ok", detail };
  if (/<title>\s*Job Not Found\s*<\/title>/i.test(html)) return { status: "gone" };
  throw new AppError("unreadable_posting", `Paylocity job ${jobId} page carried no description`);
}

/** The board labels remote work from `IndeedRemoteType`: 1 is hybrid, 0 and 2 remote. */
function workplaceOf(job: PaylocityJob): WorkplaceType {
  if (job.IsRemote !== true) return "unknown";
  return String(job.IndeedRemoteType) === "1" ? "hybrid" : "remote";
}

function locationOf(job: PaylocityJob): string {
  if (job.ShouldDisplayLocation === false) return "";
  return job.LocationName?.trim() || [job.JobLocation?.City, job.JobLocation?.State].filter((part) => part?.trim()).join(", ");
}

function toJob(company: Company, job: PaylocityJob, detail: PaylocityDetail | null, capturedAt: string): Job {
  const url = paylocityPostingUrl(job.JobId);
  const location = locationOf(job) || detail?.location || "";
  const workplaceType = workplaceOf(job);
  return normalizeJob({
    company,
    externalId: job.JobId,
    title: job.JobTitle,
    locations: location ? [location] : [],
    url,
    applyUrl: url,
    ...(detail ? { descriptionHtml: detail.descriptionHtml } : { descriptionPlain: job.Description ?? "" }),
    postedAt: isoInstant(job.PublishedDate),
    workplaceType,
    isRemote: workplaceType === "remote",
  }, capturedAt);
}

export const paylocityAdapter: SourceAdapter = {
  kind: KIND,

  listUrl(company: Company): string {
    return boardPageUrl(parsePaylocityBoard(company.board));
  },

  boardUrl(company: Company): string {
    return boardPageUrl(parsePaylocityBoard(company.board));
  },

  async listJobs(company: Company, capturedAt: string): Promise<Job[]> {
    const jobs = (await readBoard(parsePaylocityBoard(company.board), company)).slice(0, maxPostings(KIND));
    const context = { kind: KIND, company };
    const detailed = await withDetails(jobs, maxDetails(KIND), (job) => readDetail(job.JobId), context);
    return normalizeEach(detailed, ({ row, detail }) => toJob(company, row, detail, capturedAt), context);
  },

  async verifyBoard(company: Company) {
    const jobs = await readBoard(parsePaylocityBoard(company.board), company);
    return boardVerification(jobs.map((job) => job.JobTitle));
  },

  probeUrls(): string[] {
    return [];
  },

  async fetchPosting(company: Company, externalId: string, capturedAt: string): Promise<Job | null> {
    parsePaylocityBoard(company.board);
    if (!JOB_ID.test(externalId)) throw new AppError("invalid_posting_id", `not a Paylocity job id: ${externalId}`);
    const result = await readDetail(externalId);
    if (result.status === "gone") return null;
    const job: PaylocityJob = { JobId: externalId, JobTitle: result.detail.title, LocationName: result.detail.location };
    return toJob(company, job, result.detail, capturedAt);
  },

  async checkPosting(job: Job): Promise<PostingCheck> {
    try {
      parsePaylocityBoard(job.board);
    } catch (error) {
      return unparseableBoardCheck(error);
    }
    if (!JOB_ID.test(job.externalId)) return unknownCheck("the stored id is not a Paylocity job id", "page");
    try {
      const result = await readDetail(job.externalId);
      return result.status === "gone"
        ? closedCheck("Paylocity redirects the posting to Job Not Found", "page")
        : openCheck("the Details page still shows the job", "page");
    } catch (error) {
      return checkFromError(error, "page", false);
    }
  },
};
