import { decodeEntitiesOnce, htmlToText } from "../../text/html.js";
import { fetchText } from "../http.js";
import { leadSalary, parseSourceSearchInput } from "../leadTypes.js";
import type { JobLead, SourceAttribution, SourceSearchInput, SourceSearchResult } from "../leadTypes.js";
import { absoluteDate } from "../smb/dates.js";
import { countryCode } from "../smb/geo.js";
import { parseFeedXml, xmlText } from "../smb/xml.js";
import {
  buildLead, cachedFetch, httpsUrl, openEndedPagination, parseRows, skippedNotice, unsupportedFilter,
} from "./common.js";

/**
 * Job Bank (Government of Canada) public job-search feed.
 *
 * Job Bank publishes each search as an Atom feed for feed readers. This
 * connector reads exactly one feed page per explicit request: no crawling,
 * no account, no Job Match. robots.txt asks for a 5-second crawl delay, which
 * is the minimum spacing between requests here, and each search is cached for
 * 30 minutes. Job Bank's job-seeker terms forbid automated access to its
 * services, so this stays a manual-assist lead source: every lead must be
 * opened and verified by the person, and nothing is republished.
 *
 * Endpoint behaviour adapted from career-ops (MIT).
 */

const HOST = "www.jobbank.gc.ca";
const FEED = `https://${HOST}/jobsearch/feed/jobSearchRSSfeed`;
const MIN_INTERVAL_MS = 5_000;
const CACHE_TTL_MS = 30 * 60_000;
const PAGE_SIZE = 100;

type Entry = {
  id: string;
  title: string;
  link: string;
  updated: string;
  jobNumber: string;
  location: string;
  employer: string;
  salary: string;
};

const ATTRIBUTION: SourceAttribution = {
  label: "Job Bank, Government of Canada",
  url: "https://www.jobbank.gc.ca",
  changes: "Atom entries normalized into unverified job leads; labelled summary fields split out.",
  requirements: [
    "Attribute listings to Job Bank, Government of Canada, and link to the original Job Bank posting.",
    "Do not imply endorsement by Job Bank or the Government of Canada.",
    "Do not republish Job Bank postings; Job Bank licenses redistribution only through its own network programs.",
  ],
};
const LIMITATIONS = [
  "Job Bank's job-seeker terms prohibit automated access to its services. This reads only the anonymous public Atom feed for one explicit search; open and verify every posting yourself, and never automate sign-in, Job Match or applications.",
  "Requests are spaced at least 5 seconds apart (robots.txt crawl delay) and each search is cached for 30 minutes.",
  "Canada only. Location is passed to Job Bank's location filter, which is approximate.",
  "The feed reports no total; pagination.total is a lower bound. Salary amounts are Job Bank's text with its stated unit.",
] as const;

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** One labelled field from the entry summary, e.g. "<strong>Employer:</strong> Example Co<br />". */
function field(summary: string, label: string): string {
  const match = new RegExp(`<strong>\\s*${label}\\s*:\\s*</strong>([\\s\\S]*?)(?:<br\\s*/?>|$)`, "i").exec(summary);
  return match?.[1] ? htmlToText(match[1]).replace(/\s+/g, " ").trim() : "";
}

function alternateLink(links: unknown): string {
  const all = (Array.isArray(links) ? links : [links]).map(record);
  const chosen = all.find((link) => xmlText(link["@_rel"]).toLowerCase() === "alternate") ?? all[0];
  return decodeEntitiesOnce(xmlText(chosen?.["@_href"]));
}

export function parseJobBankFeed(xml: string): unknown[] {
  const feed = record(record(parseFeedXml(xml, "Job Bank", (path) => path === "feed.entry" || path === "feed.entry.link")).feed);
  return Array.isArray(feed.entry) ? feed.entry : [];
}

function readEntry(raw: unknown): Entry | null {
  const entry = record(raw);
  const link = httpsUrl(alternateLink(entry.link), [HOST]);
  const title = xmlText(entry.title);
  if (!link || !title) return null;
  const summary = xmlText(entry.summary);
  return {
    id: /\/jobposting\/(\d+)/.exec(link)?.[1] ?? link,
    title, link,
    updated: xmlText(entry.updated),
    jobNumber: field(summary, "Job number"),
    location: field(summary, "Location"),
    employer: field(summary, "Employer"),
    salary: field(summary, "Salary"),
  };
}

const AMOUNT = /\$\s*([\d,]+(?:\.\d+)?)/g;

/** "$55,000.00 to $65,000.00 annually" keeps its stated unit; Job Bank amounts are Canadian dollars. */
function salary(text: string) {
  const amounts = [...text.matchAll(AMOUNT)].map((match) => Number((match[1] ?? "").replace(/,/g, ""))).filter((value) => value > 0);
  const unit = /\b(annually|yearly|monthly|weekly|bi-weekly|daily|hourly)\b/i.exec(text)?.[1]?.toLowerCase();
  if (amounts.length === 0 || amounts.length > 2) return undefined;
  return leadSalary(amounts[0], amounts[1] ?? amounts[0], "CAD", unit);
}

function toLead(entry: Entry, endpoint: string, retrievedAt: string): JobLead {
  return buildLead("jobbankca", endpoint, retrievedAt, {
    sourceId: entry.id,
    sourceUrl: entry.link,
    title: entry.title,
    company: entry.employer,
    locations: entry.location ? [`${entry.location}, Canada`] : ["Canada"],
    locationRestrictions: ["Canada"],
    timezoneRestrictions: [],
    description: [entry.jobNumber && `Job number: ${entry.jobNumber}`, entry.salary && `Salary: ${entry.salary}`]
      .filter(Boolean).join("\n"),
    salary: salary(entry.salary),
    publishedAt: absoluteDate(entry.updated) ?? undefined,
    publishedAtRaw: entry.updated || undefined,
  });
}

export async function searchJobBankCa(input: SourceSearchInput): Promise<SourceSearchResult> {
  const search = parseSourceSearchInput(input);
  if (search.country && countryCode(search.country) !== "CA") {
    throw unsupportedFilter("Job Bank", "country", "Job Bank lists Canadian jobs only; omit country or use CA.");
  }
  const page = search.page ?? 1;
  const url = new URL(FEED);
  url.search = new URLSearchParams({
    searchstring: search.query === "*" ? "" : search.query,
    locationstring: search.location ?? "",
    page: String(page),
  }).toString();
  const { value: xml, retrievedAt } = await cachedFetch(url.href, CACHE_TTL_MS, () =>
    fetchText(url.href, { allowedHosts: [HOST], accept: "application/atom+xml, application/xml", minIntervalMs: MIN_INTERVAL_MS }));
  const rows = parseJobBankFeed(xml);
  const { items, skipped } = parseRows(rows, readEntry, "jobbankca");
  const all = items.map((entry) => toLead(entry, url.href, retrievedAt));
  const leads = all.slice(0, search.limit);
  return {
    source: "jobbankca", readiness: "ready", leads,
    pagination: openEndedPagination(page, PAGE_SIZE, all.length, leads.length, rows.length >= PAGE_SIZE),
    attribution: ATTRIBUTION,
    limitations: [...LIMITATIONS, ...skippedNotice(skipped)],
  };
}
