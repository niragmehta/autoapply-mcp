import type { Company } from "../domain/campaign.js";
import type { Job } from "../domain/job.js";
import { htmlToText } from "../text/html.js";
import { AppError } from "../util/errors.js";
import { fetchText } from "./http.js";
import { companyFromJob, isDnsLabel, pathParts, tenantBoard, type BoardFormat } from "./smb/board.js";
import { closedCheck, isGone, openCheck, safeCheck, unknownCheck } from "./smb/checks.js";
import { mapEach, withDetails } from "./smb/details.js";
import { missingBoard } from "./smb/errors.js";
import { countryValues, publishedCountry } from "./smb/geo.js";
import { isExpired, readJobPostingLd, type JobPostingLd } from "./smb/jsonLd.js";
import { matchesQuery } from "./smb/query.js";
import { boardVerification, locationLabel, normalizePublicJob } from "./sourceValidation.js";
import type { SourceAdapter } from "./types.js";

/**
 * JazzHR career pages on ApplyToJob (`<tenant>.applytojob.com/apply`).
 *
 * Board: the tenant subdomain of `<tenant>.applytojob.com`, e.g. `acme`.
 * JazzHR's API needs an employer key, so discovery reads the server-rendered
 * public board: one page lists every posting (no pagination), and each
 * posting's own page carries schema.org JobPosting metadata with the
 * description, dates, location and any published pay. Detail pages are read
 * one at a time and capped per board; `company.query` filters titles first.
 * The host serves HTML only, so board resolution cannot probe it.
 *
 * Endpoint behaviour adapted from career-ops (MIT).
 */

const FORMAT: BoardFormat = { ats: "JazzHR", shape: "the tenant subdomain of <tenant>.applytojob.com", example: "acme" };
const HOST_SUFFIX = ".applytojob.com";
// Board ids are short mixed-case tokens ("gdWcbFq2mr"); requiring a digit or
// capital keeps navigation paths such as /apply/resume from reading as postings.
const POSTING_ID = /^(?=[A-Za-z0-9]*[0-9A-Z])[A-Za-z0-9]{8,16}$/;
const MAX_BOARD_BYTES = 8 * 1024 * 1024;

type Card = { id: string; title: string; location: string; department: string };

function host(company: Company): string {
  return `${tenantBoard(company.board, FORMAT)}${HOST_SUFFIX}`;
}

function boardUrl(company: Company): string {
  return `https://${host(company)}/apply`;
}

function postingUrl(company: Company, id: string): string {
  if (!POSTING_ID.test(id)) throw new AppError("invalid_posting_id", `JazzHR posting id must be alphanumeric, got "${id}"`);
  return `https://${host(company)}/apply/${id}`;
}

/** The posting id of an `/apply/<id>/<slug>` link on the board's own host. */
function linkedId(href: string, boardHost: string): string | null {
  try {
    const url = new URL(href, `https://${boardHost}/apply`);
    if (url.hostname.toLowerCase() !== boardHost) return null;
    const parts = pathParts(url);
    return parts[0] === "apply" && parts[1] && POSTING_ID.test(parts[1]) ? parts[1] : null;
  } catch {
    return null;
  }
}

function iconText(block: string, icon: string): string {
  const match = new RegExp(`${icon}[^>]*>\\s*</i>([^<]*)<`, "i").exec(block);
  return match?.[1] ? htmlToText(match[1]) : "";
}

const ANCHOR = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
const CARD_START = /<li\b[^>]*\bclass\s*=\s*["'][^"']*\blist-group-item\b[^"']*["'][^>]*>/gi;
const CARD_SPAN = 4000;

/** Splits the board into card-sized segments, each ending where the next card starts. */
function cardBlocks(html: string): string[] {
  const starts = [...html.matchAll(CARD_START)].map((match) => match.index ?? 0);
  return starts.map((start, index) => html.slice(start, Math.min(starts[index + 1] ?? html.length, start + CARD_SPAN)));
}

/** Reads posting cards; any posting link outside a card still counts, title only. */
export function parseJazzHrBoard(html: string, boardHost: string): Card[] {
  let cards: Card[] = [];
  const seen = new Set<string>();
  const add = (card: Card): void => {
    if (!card.title || seen.has(card.id)) return;
    seen.add(card.id);
    cards = [...cards, card];
  };
  for (const block of cardBlocks(html)) {
    const link = [...block.matchAll(ANCHOR)].find((anchor) => linkedId(anchor[1] ?? "", boardHost));
    if (!link) continue;
    add({
      id: linkedId(link[1] ?? "", boardHost) ?? "",
      title: htmlToText(link[2] ?? ""),
      location: iconText(block, "fa-map-marker"),
      department: iconText(block, "fa-sitemap"),
    });
  }
  for (const anchor of html.matchAll(ANCHOR)) {
    const id = linkedId(anchor[1] ?? "", boardHost);
    if (id) add({ id, title: htmlToText(anchor[2] ?? ""), location: "", department: "" });
  }
  return cards;
}

async function readBoard(company: Company): Promise<Card[]> {
  let html: string;
  try {
    html = await fetchText(boardUrl(company), { allowedHosts: [host(company)], maxBytes: MAX_BOARD_BYTES });
  } catch (error) {
    throw missingBoard(error, FORMAT.ats, company.board);
  }
  if (!/applytojob|jazzhr|resumator/i.test(html)) {
    throw new AppError("invalid_source_payload", "JazzHR board page did not look like an ApplyToJob career page");
  }
  return parseJazzHrBoard(html, host(company));
}

async function readPosting(company: Company, id: string): Promise<JobPostingLd | null> {
  const html = await fetchText(postingUrl(company, id), { allowedHosts: [host(company)], maxBytes: MAX_BOARD_BYTES });
  return readJobPostingLd(html);
}

function normalize(company: Company, card: Card, posting: JobPostingLd | null, capturedAt: string): Job | null {
  if (posting && isExpired(posting, new Date(capturedAt))) return null;
  const places = (posting?.places ?? []).map((place) => locationLabel({
    city: place.city, region: place.region, country: place.country,
  })).filter(Boolean);
  const countries = countryValues([...(posting?.places ?? []).map((place) => place.country), ...(posting?.applicantCountries ?? [])]);
  const remote = posting?.remote === true || /\bremote\b/i.test(card.location);
  const url = postingUrl(company, card.id);
  return normalizePublicJob({
    company,
    externalId: card.id,
    title: card.title || posting?.title || "",
    locations: [...new Set([card.location, ...places].filter(Boolean))],
    url,
    applyUrl: url,
    descriptionHtml: posting?.description ?? "",
    postedAt: posting?.datePosted ?? null,
    workplaceType: remote ? "remote" : "unknown",
    isRemote: remote,
    employmentType: posting?.employmentType || undefined,
    structuredCompensation: posting?.pay ?? null,
    country: publishedCountry(countries),
  }, capturedAt, countries);
}

export const jazzHrAdapter: SourceAdapter = {
  kind: "jazzhr",
  listUrl: boardUrl,
  boardUrl,

  async listJobs(company, capturedAt) {
    const cards = (await readBoard(company)).filter((card) => matchesQuery(company.query, card.title, card.department));
    const enriched = await withDetails(cards, (card) => readPosting(company, card.id), { ats: "jazzhr", board: company.board });
    return mapEach(enriched, ({ item, detail }) => normalize(company, item, detail, capturedAt), {
      ats: "jazzhr", board: company.board,
    });
  },

  async verifyBoard(company) {
    return boardVerification((await readBoard(company)).map((card) => card.title));
  },

  /** ApplyToJob serves HTML only; `verifyBoard` confirms a tenant instead. */
  probeUrls: () => [],

  parsePostingUrl(url) {
    const hostname = url.hostname.toLowerCase();
    const tenant = hostname.endsWith(HOST_SUFFIX) ? hostname.slice(0, -HOST_SUFFIX.length) : "";
    if (!isDnsLabel(tenant) || tenant === "www") return null;
    const id = linkedId(url.href, hostname);
    return id ? { board: tenant, externalId: id } : null;
  },

  async fetchPosting(company, externalId, capturedAt) {
    try {
      const posting = await readPosting(company, externalId);
      if (!posting) return null;
      return normalize(company, { id: externalId, title: posting.title, location: "", department: "" }, posting, capturedAt);
    } catch (error) {
      if (isGone(error)) return null;
      throw error;
    }
  },

  async checkPosting(job) {
    return safeCheck(async () => {
      const posting = await readPosting(companyFromJob(job), job.externalId);
      if (!posting) return unknownCheck("JazzHR page carried no posting metadata", "page");
      return isExpired(posting)
        ? closedCheck("JazzHR posting is past its validThrough date", "page")
        : openCheck("JazzHR posting page is live", "page");
    }, "page");
  },
};
