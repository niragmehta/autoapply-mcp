import { z } from "zod";
import type { Company } from "../domain/campaign.js";
import type { CompensationRange, Job, WorkplaceType } from "../domain/job.js";
import { AppError } from "../util/errors.js";
import { logger } from "../util/logger.js";
import { fetchText } from "./http.js";
import { normalizeJob } from "./normalize.js";

const HOST = "jobs.ashbyhq.com";
const IdSchema = z.string().regex(/^[a-zA-Z0-9_-]+$/);
const PageSchema = z.object({
  organization: z.object({ hostedJobsPageSlug: z.string().min(1) }),
  jobBoard: z.object({
    jobPostings: z.array(z.object({ id: IdSchema, title: z.string().min(1) })).max(500),
  }).nullish(),
  posting: z.unknown().optional(),
});
const PostingSchema = z.object({
  id: IdSchema, title: z.string().min(1), isListed: z.boolean(), isConfidential: z.boolean(),
  locationName: z.string().min(1), secondaryLocationNames: z.array(z.string()).default([]),
  workplaceType: z.string().nullish(), employmentType: z.string(),
  descriptionHtml: z.string().min(1), compensationTierSummary: z.string().nullish(),
  compensationTiers: z.array(z.unknown()).optional(),
});
const MetadataSchema = z.object({
  "@type": z.literal("JobPosting"),
  identifier: z.object({ value: IdSchema }),
  datePosted: z.iso.date().or(z.iso.datetime({ offset: true })).nullish(),
  baseSalary: z.object({
    currency: z.string().regex(/^[A-Z]{3}$/),
    value: z.object({
      minValue: z.number().finite().nonnegative().nullish(),
      maxValue: z.number().finite().nonnegative().nullish(),
      unitText: z.string().optional(),
    }).refine((value) => value.minValue != null || value.maxValue != null)
      .refine((value) => value.minValue == null || value.maxValue == null || value.minValue <= value.maxValue),
  }).nullish(),
});

function validate<T>(schema: z.ZodType<T>, value: unknown, part: string): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new AppError("source_schema_error", `Invalid Ashby hosted ${part}`);
  return result.data;
}

function decodeJson(text: string | undefined, part: string): unknown {
  if (!text) throw new AppError("source_schema_error", `Missing Ashby hosted ${part}`);
  try {
    return JSON.parse(text);
  } catch {
    throw new AppError("source_schema_error", `Invalid JSON in Ashby hosted ${part}`);
  }
}

async function loadPage(url: string, company: Company) {
  const html = await fetchText(url, { allowedHosts: [HOST], maxBytes: 4 * 1024 * 1024 });
  const scripts = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script\s*>/gi)];
  // Parse the public JSON initializer, never execute the surrounding JavaScript.
  const initializers = scripts.flatMap((script) => {
    const match = script[1]?.match(/^\s*window\.__appData\s*=\s*(\{[^\r\n]*\});\s*$/m);
    return match?.[1] ? [match[1]] : [];
  });
  if (initializers.length !== 1) throw new AppError("source_schema_error", "Missing or ambiguous Ashby hosted app data");
  const data = validate(PageSchema, decodeJson(initializers[0], "app data"), "app data");
  if (data.organization.hostedJobsPageSlug.toLowerCase() !== company.board.toLowerCase()) {
    throw new AppError("source_identity_mismatch", "Ashby hosted page belongs to a different board");
  }
  return { html, data };
}

function metadata(html: string, id: string) {
  const entries = [...html.matchAll(/<script\b[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script\s*>/gi)]
    .map((match) => decodeJson(match[1], "job metadata"))
    .filter((value) => z.object({ "@type": z.literal("JobPosting") }).safeParse(value).success);
  if (entries.length !== 1) throw new AppError("source_schema_error", "Missing or ambiguous Ashby hosted job metadata");
  const result = validate(MetadataSchema, entries[0], "job metadata");
  if (result.identifier.value !== id) throw new AppError("source_identity_mismatch", "Ashby hosted job metadata ID mismatch");
  return result;
}

function compensation(data: z.infer<typeof MetadataSchema>, posting: z.infer<typeof PostingSchema>): CompensationRange | null {
  if (!data.baseSalary) {
    if (posting.compensationTierSummary?.trim()) {
      logger.warn("Ashby hosted published pay lacks structured currency/units; holding as unknown", { id: posting.id });
      return {
        min: null, max: null, currency: "XXX", period: "unknown",
        source: "ats-structured", raw: posting.compensationTierSummary,
      };
    }
    return null;
  }
  const { currency, value } = data.baseSalary;
  const periods: Record<string, CompensationRange["period"]> = { YEAR: "year", MONTH: "month", HOUR: "hour" };
  if ((posting.compensationTiers?.length ?? 0) > 1) {
    logger.warn("Ashby hosted pay uses published JSON-LD summary; verify geographic tiers");
  }
  return {
    min: value.minValue ?? null, max: value.maxValue ?? null, currency,
    period: periods[value.unitText?.toUpperCase() ?? ""] ?? "unknown",
    source: "ats-structured", raw: JSON.stringify(data.baseSalary),
  };
}

async function loadPosting(company: Company, id: string, capturedAt: string): Promise<Job | null> {
  const url = `https://${HOST}/${encodeURIComponent(company.board)}/${encodeURIComponent(id)}`;
  const { html, data } = await loadPage(url, company);
  const posting = validate(PostingSchema, data.posting, "posting");
  if (posting.id !== id) throw new AppError("source_identity_mismatch", "Ashby hosted posting ID mismatch");
  if (!posting.isListed || posting.isConfidential) {
    logger.warn("Skipping unlisted or confidential Ashby hosted posting", { id });
    return null;
  }
  const detail = metadata(html, id);
  const kinds: Record<string, WorkplaceType> = { remote: "remote", hybrid: "hybrid", onsite: "onsite" };
  const workplaceType = kinds[posting.workplaceType?.toLowerCase() ?? ""] ?? "unknown";
  if (!detail.datePosted) logger.warn("Ashby hosted posting has no published date", { id });
  return normalizeJob({
    company, externalId: id, title: posting.title, url, applyUrl: `${url}/application`,
    locations: [...new Set([posting.locationName, ...posting.secondaryLocationNames])],
    descriptionHtml: posting.descriptionHtml, postedAt: detail.datePosted ?? null,
    workplaceType, isRemote: workplaceType === "remote", employmentType: posting.employmentType,
    structuredCompensation: compensation(detail, posting),
  }, capturedAt);
}

export async function listHostedAshbyJobs(company: Company, capturedAt: string): Promise<Job[]> {
  const { data } = await loadPage(`https://${HOST}/${encodeURIComponent(company.board)}`, company);
  if (!data.jobBoard) throw new AppError("source_schema_error", "Missing Ashby hosted job board");
  const listings = [...new Map(data.jobBoard.jobPostings.map((posting) => [posting.id, posting])).values()];
  let jobs: Job[] = [];
  for (const listing of listings) {
    const job = await loadPosting(company, listing.id, capturedAt);
    if (job) jobs = [...jobs, job];
  }
  return jobs;
}
