import { z } from "zod";
import type { Company } from "../domain/campaign.js";
import type { Job, WorkplaceType } from "../domain/job.js";
import { fetchJson, fetchText } from "./http.js";
import { companyFromJob, isDnsLabel, pathParts, tenantBoard, type BoardFormat } from "./smb/board.js";
import { openCheck, safeCheck, unknownCheck } from "./smb/checks.js";
import { absoluteDate } from "./smb/dates.js";
import { mapEach, withDetails } from "./smb/details.js";
import { countryValues, publishedCountry } from "./smb/geo.js";
import { readJobPostingLd, type JobPostingLd } from "./smb/jsonLd.js";
import { payPeriod, structuredPay } from "./smb/pay.js";
import { matchesQuery } from "./smb/query.js";
import { boardVerification, locationLabel, nonEmptyText, normalizePublicJob, optionalText, parseSourcePayload } from "./sourceValidation.js";
import type { SourceAdapter } from "./types.js";

/**
 * Pinpoint public postings feed.
 *
 * Board: the tenant subdomain of `<tenant>.pinpointhq.com`, e.g. `acme`.
 * `/postings.json` returns every live posting with its full text, workplace
 * type and structured pay. It has no dates or countries, which each posting
 * page's schema.org metadata supplies, one capped request per posting.
 * Pinpoint seeds some abandoned tenants with a canned demo posting; those are
 * recognised by its onboarding-video artifact and dropped.
 *
 * Endpoint behaviour adapted from career-ops (MIT).
 */

const FORMAT: BoardFormat = { ats: "Pinpoint", shape: "the tenant subdomain of <tenant>.pinpointhq.com", example: "acme" };
const HOST_SUFFIX = ".pinpointhq.com";
const DEMO_MARKER = "youtube.com/embed/https://www.youtube.com/embed/pFxm6fszrpw";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const postingSchema = z.object({
  id: z.union([nonEmptyText, z.number().int()]).transform(String),
  title: nonEmptyText,
  url: optionalText,
  path: optionalText,
  description: optionalText,
  key_responsibilities: optionalText, key_responsibilities_header: optionalText,
  skills_knowledge_expertise: optionalText, skills_knowledge_expertise_header: optionalText,
  benefits: optionalText, benefits_header: optionalText,
  compensation: optionalText,
  compensation_minimum: z.number().nullish(),
  compensation_maximum: z.number().nullish(),
  compensation_currency: optionalText,
  compensation_frequency: optionalText,
  compensation_visible: z.boolean().nullish(),
  deadline_at: optionalText,
  employment_type_text: optionalText,
  workplace_type: optionalText,
  job: z.object({ department: z.object({ name: optionalText }).partial().nullish() }).partial().nullish(),
  location: z.object({ name: optionalText, city: optionalText, province: optionalText }).partial().nullish(),
});
type Posting = z.infer<typeof postingSchema>;

function host(company: Company): string {
  return `${tenantBoard(company.board, FORMAT)}${HOST_SUFFIX}`;
}

function listUrl(company: Company): string {
  return `https://${host(company)}/postings.json`;
}

/** The posting's page uuid, which is what its public URL and liveness use. */
function pageId(posting: Posting): string {
  const fromPath = pathParts(new URL(posting.path || posting.url || "/", "https://pinpointhq.com")).at(-1) ?? "";
  return UUID.test(fromPath) ? fromPath.toLowerCase() : posting.id;
}

function postingUrl(company: Company, id: string): string {
  return `https://${host(company)}/en/postings/${encodeURIComponent(id)}`;
}

async function readPostings(company: Company): Promise<Posting[]> {
  const payload = await fetchJson<unknown>(listUrl(company), { allowedHosts: [host(company)] });
  const data = parseSourcePayload(z.object({ data: z.array(z.unknown()) }), payload, "Pinpoint postings").data;
  return mapEach(data, (row) => {
    const parsed = postingSchema.safeParse(row);
    return parsed.success && !(parsed.data.description ?? "").includes(DEMO_MARKER) ? parsed.data : null;
  }, { ats: "pinpoint", board: company.board });
}

async function readPage(company: Company, id: string): Promise<JobPostingLd | null> {
  if (!UUID.test(id)) return null;
  const html = await fetchText(postingUrl(company, id), { allowedHosts: [host(company)], maxBytes: 4 * 1024 * 1024 });
  return readJobPostingLd(html);
}

function isLive(posting: Posting, capturedAt: string): boolean {
  const deadline = absoluteDate(posting.deadline_at);
  return deadline === null || Date.parse(deadline) > Date.parse(capturedAt);
}

function section(header: string | null | undefined, body: string | null | undefined): string {
  return body ? `${header ? `<h3>${header}</h3>` : ""}${body}` : "";
}

const WORKPLACE: Readonly<Record<string, WorkplaceType>> = { remote: "remote", hybrid: "hybrid", onsite: "onsite" };

function normalize(company: Company, posting: Posting, page: JobPostingLd | null, capturedAt: string): Job | null {
  if (!isLive(posting, capturedAt)) return null;
  const type = WORKPLACE[(posting.workplace_type ?? "").toLowerCase()] ?? "unknown";
  const place = posting.location;
  const countries = countryValues([...(page?.places ?? []).map((entry) => entry.country), ...(page?.applicantCountries ?? [])]);
  const id = pageId(posting);
  const url = UUID.test(id) ? postingUrl(company, id) : posting.url ?? listUrl(company);
  return normalizePublicJob({
    company,
    externalId: id,
    title: posting.title,
    locations: [locationLabel({ city: place?.city || place?.name, region: place?.province })].filter(Boolean),
    url,
    applyUrl: url,
    descriptionHtml: [
      posting.description,
      section(posting.key_responsibilities_header, posting.key_responsibilities),
      section(posting.skills_knowledge_expertise_header, posting.skills_knowledge_expertise),
      section(posting.benefits_header, posting.benefits),
    ].filter(Boolean).join("\n"),
    postedAt: page?.datePosted ?? null,
    workplaceType: type,
    isRemote: type === "remote",
    employmentType: posting.employment_type_text ?? undefined,
    structuredCompensation: posting.compensation_visible === false ? null : structuredPay(
      posting.compensation_minimum, posting.compensation_maximum, posting.compensation_currency,
      payPeriod(posting.compensation_frequency), posting.compensation ?? "pinpoint compensation",
    ) ?? page?.pay ?? null,
    country: publishedCountry(countries),
  }, capturedAt, countries);
}

export const pinpointAdapter: SourceAdapter = {
  kind: "pinpoint",
  listUrl,
  boardUrl: (company) => `https://${host(company)}/`,

  async listJobs(company, capturedAt) {
    const postings = (await readPostings(company))
      .filter((posting) => matchesQuery(company.query, posting.title, posting.job?.department?.name));
    const enriched = await withDetails(postings, (posting) => readPage(company, pageId(posting)), {
      ats: "pinpoint", board: company.board,
    });
    return mapEach(enriched, ({ item, detail }) => normalize(company, item, detail, capturedAt), {
      ats: "pinpoint", board: company.board,
    });
  },

  async verifyBoard(company) {
    const now = new Date().toISOString();
    return boardVerification((await readPostings(company)).filter((posting) => isLive(posting, now)).map((posting) => posting.title));
  },

  probeUrls(slug) {
    const label = slug.trim().toLowerCase();
    return isDnsLabel(label) ? [`https://${label}${HOST_SUFFIX}/postings.json`] : [];
  },

  parsePostingUrl(url) {
    const hostname = url.hostname.toLowerCase();
    const tenant = hostname.endsWith(HOST_SUFFIX) ? hostname.slice(0, -HOST_SUFFIX.length) : "";
    const parts = pathParts(url);
    const at = parts.indexOf("postings");
    const id = at >= 0 && at <= 1 ? parts[at + 1] ?? "" : "";
    return isDnsLabel(tenant) && !["www", "app"].includes(tenant) && UUID.test(id)
      ? { board: tenant, externalId: id.toLowerCase() } : null;
  },

  async fetchPosting(company, externalId, capturedAt) {
    const posting = (await readPostings(company)).find((candidate) => pageId(candidate) === externalId.toLowerCase());
    if (!posting) return null;
    const [entry] = await withDetails([posting], (item) => readPage(company, pageId(item)), { ats: "pinpoint", board: company.board });
    return normalize(company, posting, entry?.detail ?? null, capturedAt);
  },

  async checkPosting(job) {
    return safeCheck(async () => {
      if (!UUID.test(job.externalId)) return unknownCheck("Pinpoint posting has no page id to check", "page");
      const page = await readPage(companyFromJob(job), job.externalId);
      return page
        ? openCheck("Pinpoint posting page is live", "page")
        : unknownCheck("Pinpoint page carried no posting metadata", "page");
    }, "page");
  },
};
