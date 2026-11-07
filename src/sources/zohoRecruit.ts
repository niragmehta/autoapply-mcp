import { z } from "zod";
import type { Company } from "../domain/campaign.js";
import type { Job } from "../domain/job.js";
import { decodeEntitiesOnce } from "../text/html.js";
import { AppError } from "../util/errors.js";
import { fetchText } from "./http.js";
import { companyFromJob, invalidBoard, isDnsLabel, pathParts, type BoardFormat } from "./smb/board.js";
import { listingCheck, safeCheck } from "./smb/checks.js";
import { absoluteDate } from "./smb/dates.js";
import { mapEach } from "./smb/details.js";
import { countryValues, publishedCountry } from "./smb/geo.js";
import { matchesQuery } from "./smb/query.js";
import { boardVerification, locationLabel, normalizePublicJob, optionalText } from "./sourceValidation.js";
import type { SourceAdapter } from "./types.js";

/**
 * Zoho Recruit career sites (`<tenant>.zohorecruit.<region>/jobs/Careers`).
 *
 * Board: the tenant subdomain, e.g. `acme` for acme.zohorecruit.com, or
 * `<tenant>.<region>` for another data centre, e.g. `acme.eu` or `acme.com.au`.
 * The career page is server-rendered: every published posting, with its
 * description, location and opening date, sits in one hidden `jobs` input as
 * entity-escaped JSON, so one request reads the whole board and no script is
 * executed. Postings the site marks as filled (`Is_Locked`) or unpublished
 * are skipped. A tenant without that input (an unknown tenant, or one on the
 * legacy career site) is reported as not found rather than empty. The host
 * serves HTML only, so board resolution cannot probe it.
 *
 * Endpoint behaviour adapted from career-ops (MIT).
 */

const FORMAT: BoardFormat = {
  ats: "Zoho Recruit", shape: "the tenant subdomain of <tenant>.zohorecruit.com, or \"<tenant>.<region>\" such as acme.eu", example: "acme",
};
const REGIONS = new Set(["com", "eu", "in", "com.au", "jp", "sa", "com.cn", "ca"]);
const BOARD_PATH = "/jobs/Careers";
const MAX_PAGE_BYTES = 16 * 1024 * 1024;
const INPUT_TAG = /<input\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;

const recordSchema = z.object({
  id: z.union([z.string().regex(/^\d{5,25}$/), z.number().int().positive()]).transform(String),
  Posting_Title: optionalText,
  Job_Opening_Name: optionalText,
  City: optionalText,
  State: optionalText,
  Country: optionalText,
  Remote_Job: z.boolean().nullish(),
  Job_Type: optionalText,
  Job_Description: optionalText,
  Date_Opened: optionalText,
  Industry: optionalText,
  Function: optionalText,
  Is_Locked: z.boolean().nullish(),
  Publish: z.boolean().nullish(),
});
type ZohoRecord = z.infer<typeof recordSchema>;

/** Splits `acme` or `acme.eu` into tenant and data-centre domain. */
function parseBoard(board: string): { tenant: string; region: string } {
  const [tenant = "", ...rest] = board.trim().toLowerCase().split(".");
  const region = rest.length ? rest.join(".") : "com";
  if (!isDnsLabel(tenant) || !REGIONS.has(region)) throw invalidBoard(FORMAT, board);
  return { tenant, region };
}

function host(company: Company): string {
  const { tenant, region } = parseBoard(company.board);
  return `${tenant}.zohorecruit.${region}`;
}

function listUrl(company: Company): string {
  return `https://${host(company)}${BOARD_PATH}`;
}

/** The raw records in the page's hidden `jobs` input. */
export function zohoRecords(html: string): unknown[] {
  const tag = [...html.matchAll(INPUT_TAG)].map((match) => match[0]).find((input) => /\sid\s*=\s*["']?jobs["'\s/>]/i.test(input));
  if (!tag) {
    // Zoho answers 200 with this page for an unknown tenant; any other page
    // without the list is a markup change, which must not read as "closed".
    if (/<title[^>]*>\s*Page does not exist/i.test(html)) {
      throw new AppError("not_found", "Zoho Recruit tenant has no career site (unknown tenant or legacy career site)");
    }
    throw new AppError("invalid_source_payload", "Zoho Recruit career page has no job list input");
  }
  const attribute = /\svalue\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag);
  let records: unknown;
  try {
    records = JSON.parse(decodeEntitiesOnce(attribute?.[1] ?? attribute?.[2] ?? ""));
  } catch {
    throw new AppError("invalid_source_payload", "Zoho Recruit job list is not valid JSON");
  }
  if (!Array.isArray(records)) throw new AppError("invalid_source_payload", "Zoho Recruit job list is not an array");
  return records;
}

async function readRecords(company: Company): Promise<ZohoRecord[]> {
  const html = await fetchText(listUrl(company), { allowedHosts: [host(company)], maxBytes: MAX_PAGE_BYTES });
  return mapEach(zohoRecords(html), (row) => {
    const parsed = recordSchema.safeParse(row);
    return parsed.success && parsed.data.Is_Locked !== true && parsed.data.Publish !== false
      && (parsed.data.Posting_Title || parsed.data.Job_Opening_Name) ? parsed.data : null;
  }, { ats: "zohorecruit", board: company.board });
}

function title(record: ZohoRecord): string {
  return (record.Posting_Title || record.Job_Opening_Name || "").trim();
}

function normalize(company: Company, record: ZohoRecord, capturedAt: string): Job {
  const countries = countryValues([record.Country]);
  const remote = record.Remote_Job === true;
  const place = locationLabel({ city: record.City, region: record.State, country: record.Country });
  const url = `https://${host(company)}${BOARD_PATH}/${record.id}`;
  return normalizePublicJob({
    company,
    externalId: record.id,
    title: title(record),
    locations: [place, remote ? "Remote" : ""].filter(Boolean),
    url,
    applyUrl: url,
    descriptionHtml: record.Job_Description ?? "",
    postedAt: absoluteDate(record.Date_Opened),
    workplaceType: remote ? "remote" : "unknown",
    isRemote: remote,
    employmentType: record.Job_Type ?? undefined,
    country: publishedCountry(countries),
  }, capturedAt, countries);
}

export const zohoRecruitAdapter: SourceAdapter = {
  kind: "zohorecruit",
  listUrl,
  boardUrl: listUrl,

  async listJobs(company, capturedAt) {
    const records = (await readRecords(company)).filter((record) => matchesQuery(company.query, title(record), record.Function));
    return mapEach(records, (record) => normalize(company, record, capturedAt), { ats: "zohorecruit", board: company.board });
  },

  async verifyBoard(company) {
    return boardVerification((await readRecords(company)).map(title));
  },

  /** The career site serves HTML only; `verifyBoard` confirms a tenant instead. */
  probeUrls: () => [],

  parsePostingUrl(url) {
    const match = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.zohorecruit\.([a-z.]+)$/.exec(url.hostname.toLowerCase());
    if (!match?.[1] || !match[2] || !REGIONS.has(match[2])) return null;
    const [marker, , id] = pathParts(url);
    if (marker !== "jobs" || !id || !/^\d{5,25}$/.test(id)) return null;
    return { board: match[2] === "com" ? match[1] : `${match[1]}.${match[2]}`, externalId: id };
  },

  async fetchPosting(company, externalId, capturedAt) {
    const record = (await readRecords(company)).find((candidate) => candidate.id === externalId);
    return record ? normalize(company, record, capturedAt) : null;
  },

  /** The career page lists every open posting, so absence (or a filled flag) means closed. */
  async checkPosting(job) {
    return safeCheck(async () => listingCheck(
      (await readRecords(companyFromJob(job))).some((record) => record.id === job.externalId), "Zoho Recruit"));
  },
};
