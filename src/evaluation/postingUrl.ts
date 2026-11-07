import { z } from "zod";
import type { Workspace } from "../config/load.js";
import { recordLiveness } from "../db/repositories/liveness.js";
import { upsertJobs } from "../db/repositories/jobs.js";
import { CompanySchema, type Company } from "../domain/campaign.js";
import type { CompensationRange, Job } from "../domain/job.js";
import { classifyPostingPage } from "../hygiene/livenessPage.js";
import { extractJobPostings, type JsonLdJobPosting } from "../hygiene/jsonLd.js";
import { assertPublicHttpsUrl, fetchPostingPage } from "../hygiene/pageFetch.js";
import { evaluateAndStore } from "../pipeline.js";
import { normalizeJob } from "../sources/normalize.js";
import { allAdapters } from "../sources/registry.js";
import type { PostingRef, SourceAdapter } from "../sources/types.js";
import { prepareUntrusted } from "../text/untrusted.js";
import { AppError } from "../util/errors.js";
import { nowIso, shortHash } from "../util/hash.js";
import { buildEvaluationScaffold, type EvaluationScaffold } from "./scaffold.js";

/**
 * "Paste a job URL and get an evaluation."
 *
 * A URL on a supported ATS is read through that ATS's API, so the posting is
 * stored exactly as discovery would have stored it. Any other host is read
 * through its schema.org JobPosting metadata. Pasted text becomes an
 * `external` posting. Everything fetched or pasted is untrusted: it is capped,
 * neutralised and stored as data, and nothing in it is followed.
 */

type PostingEvaluation = {
  jobId: string;
  source: "ats-api" | "json-ld" | "pasted-text";
  ats: string;
  companyNameSource: "configured" | "provided" | "posting" | "board-slug";
  scaffold: EvaluationScaffold;
};

const MAX_DESCRIPTION_CHARS = 60_000;

function displayName(slug: string): string {
  return slug
    .split(/[-_\s]+/)
    .filter((part) => part.length > 0)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(" ");
}

/** The configured board when the candidate already tracks it; otherwise a transient one that is never saved. */
function companyFor(workspace: Workspace, adapter: SourceAdapter, ref: PostingRef, provided?: string): { company: Company; source: PostingEvaluation["companyNameSource"] } {
  const configured = workspace.companies.find(
    (company) => company.ats === adapter.kind && company.board.toLowerCase() === ref.board.toLowerCase(),
  );
  if (configured) return { company: configured, source: "configured" };
  const name = provided?.trim() || displayName(ref.board.split("/")[0] ?? ref.board);
  return {
    company: CompanySchema.parse({ name, ats: adapter.kind, board: ref.board, region: ref.region ?? "global", tags: ["pasted-url"] }),
    source: provided?.trim() ? "provided" : "board-slug",
  };
}

function untrustedJob(job: Job): Job {
  const prepared = prepareUntrusted(job.descriptionText, MAX_DESCRIPTION_CHARS);
  return prepared.text === job.descriptionText ? job : { ...job, descriptionText: prepared.text };
}

function store(workspace: Workspace, job: Job): void {
  upsertJobs(workspace.db, [job]);
  evaluateAndStore(workspace.db, [job], workspace.campaign, workspace.profile);
}

function salaryRange(posting: JsonLdJobPosting): CompensationRange | null {
  const salary = posting.salary;
  if (!salary) return null;
  const periods: Record<string, CompensationRange["period"]> = { YEAR: "year", MONTH: "month", HOUR: "hour" };
  return {
    min: salary.min,
    max: salary.max,
    currency: salary.currency,
    period: periods[salary.unit] ?? "unknown",
    source: "ats-structured",
    raw: salary.raw,
  };
}

function jobFromJsonLd(posting: JsonLdJobPosting, url: URL, workspace: Workspace, provided?: string): { job: Job; source: PostingEvaluation["companyNameSource"] } {
  const host = url.hostname.toLowerCase();
  const name = provided?.trim() || posting.hiringOrganization || displayName(host.replace(/^(?:www|jobs|careers)\./, "").split(".")[0] ?? host);
  const configured = workspace.companies.find((company) => company.name.toLowerCase() === name.toLowerCase());
  const company = CompanySchema.parse({ name, ats: "external", board: host, tier: configured?.tier ?? "B", tags: ["pasted-url"] });
  const job = normalizeJob(
    {
      company,
      externalId: posting.identifier ?? shortHash(url.toString(), 12),
      title: posting.title,
      locations: posting.locations,
      url: url.toString(),
      applyUrl: url.toString(),
      descriptionHtml: posting.description,
      postedAt: posting.datePosted,
      isRemote: posting.remote,
      employmentType: posting.employmentType || undefined,
      structuredCompensation: salaryRange(posting),
      country: countryCode(posting.countries),
    },
    nowIso(),
  );
  return { job: untrustedJob(job), source: provided?.trim() ? "provided" : posting.hiringOrganization ? "posting" : "board-slug" };
}

/** "US" or "CA" when the posting names one of them; the shared location classifier knows only those two. */
function countryCode(values: readonly string[]): string | undefined {
  for (const value of values.map((entry) => entry.trim())) {
    if (/^(?:us|usa|united states(?: of america)?)$/i.test(value)) return "US";
    if (/^(?:ca|can|canada)$/i.test(value)) return "CA";
  }
  return undefined;
}

async function evaluateExternalPage(workspace: Workspace, url: URL, company?: string): Promise<PostingEvaluation> {
  const page = await fetchPostingPage(url.toString(), { maxBytes: 4 * 1024 * 1024 });
  if (page.status === 404 || page.status === 410) {
    throw new AppError("posting_closed", `the posting page answers HTTP ${page.status}; it is gone`);
  }
  if (page.status < 200 || page.status >= 300) {
    throw new AppError("posting_unreadable", `the posting page answered HTTP ${page.status}; paste the posting text instead`);
  }
  const posting = extractJobPostings(page.body)[0];
  if (!posting) {
    throw new AppError(
      "posting_unreadable",
      "this page publishes no schema.org JobPosting; paste the posting text with evaluate_posting {text, company, title}",
    );
  }
  const { job, source } = jobFromJsonLd(posting, new URL(page.finalUrl), workspace, company);
  store(workspace, job);
  const verdict = classifyPostingPage({ status: page.status, requestedUrl: page.requestedUrl, finalUrl: page.finalUrl, body: page.body, title: job.title });
  recordLiveness(workspace.db, { jobId: job.id, ...verdict, checkedAt: nowIso() });
  return { jobId: job.id, source: "json-ld", ats: "external", companyNameSource: source, scaffold: buildEvaluationScaffold(workspace, job.id) };
}

/** Fetches, stores, evaluates and scaffolds the posting a URL points at. */
export async function evaluatePostingUrl(workspace: Workspace, rawUrl: string, options: { company?: string } = {}): Promise<PostingEvaluation> {
  const url = assertPublicHttpsUrl(rawUrl);
  for (const adapter of allAdapters()) {
    const ref = adapter.parsePostingUrl?.(url) ?? null;
    if (!ref || !adapter.fetchPosting) continue;
    const { company, source } = companyFor(workspace, adapter, ref, options.company);
    const capturedAt = nowIso();
    const fetched = await adapter.fetchPosting(company, ref.externalId, capturedAt);
    if (!fetched) {
      throw new AppError("posting_closed", `${adapter.kind} no longer publishes this posting (${ref.board}/${ref.externalId})`);
    }
    const job = untrustedJob(fetched);
    store(workspace, job);
    recordLiveness(workspace.db, {
      jobId: job.id,
      status: "open",
      via: "api",
      detail: `${adapter.kind} published the posting when it was evaluated from a pasted URL`,
      checkedAt: capturedAt,
    });
    return { jobId: job.id, source: "ats-api", ats: adapter.kind, companyNameSource: source, scaffold: buildEvaluationScaffold(workspace, job.id) };
  }
  return evaluateExternalPage(workspace, url, options.company);
}

const PastedPostingSchema = z.object({
  company: z.string().trim().min(1).max(200),
  title: z.string().trim().min(1).max(300),
  location: z.string().trim().max(300).optional(),
  text: z.string().trim().min(80, "paste the full posting text, not a summary").max(200_000),
  url: z.string().trim().max(2000).optional(),
});
type PastedPosting = z.input<typeof PastedPostingSchema>;

/** Stores pasted posting text as an `external` posting and scaffolds it. */
export function evaluatePostingText(workspace: Workspace, input: PastedPosting): PostingEvaluation {
  const parsed = PastedPostingSchema.safeParse(input);
  if (!parsed.success) {
    throw new AppError("invalid_posting", parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
  }
  const posting = parsed.data;
  const url = posting.url ? assertPublicHttpsUrl(posting.url) : null;
  const board = url?.hostname.toLowerCase() ?? "pasted";
  const company = CompanySchema.parse({ name: posting.company, ats: "external", board, tags: ["pasted-text"] });
  const externalId = shortHash(`${posting.company}|${posting.title}|${posting.text}`, 16);
  const job = untrustedJob(
    normalizeJob(
      {
        company,
        externalId,
        title: posting.title,
        locations: posting.location ? [posting.location] : [],
        url: url?.toString() ?? "",
        applyUrl: url?.toString() ?? "",
        descriptionPlain: posting.text,
      },
      nowIso(),
    ),
  );
  store(workspace, job);
  return { jobId: job.id, source: "pasted-text", ats: "external", companyNameSource: "provided", scaffold: buildEvaluationScaffold(workspace, job.id) };
}
