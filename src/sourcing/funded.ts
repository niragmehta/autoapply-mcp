import type { Workspace } from "../config/load.js";
import { appendEvent } from "../db/repositories/events.js";
import { leadId, upsertLeads, type LeadInput } from "../db/repositories/leads.js";
import { fetchJson, fetchText } from "../sources/http.js";
import { AppError, toErrorMessage } from "../util/errors.js";
import { companyFromHeadline, companyKey, fundingDetails, parseFeedItems, type FeedItem } from "./fundedParse.js";

/**
 * Recently funded companies, from public news feeds.
 *
 * A company that has just raised money is usually about to hire, often before
 * its roles reach any job board. Only public, unauthenticated RSS feeds and
 * the Hacker News search API are read, each from a fixed allowlist of URLs
 * whose hosts are enforced on every redirect. Nothing behind a login and no
 * arbitrary page is ever fetched; article links are stored, not visited.
 */

export const FUNDED_SOURCE = "funded";

type FeedDefinition = { label: string; urls: readonly string[]; hosts: readonly string[]; byDefault: boolean };

/**
 * Checked live on 2026-11-06: each answered 200 with a well-formed feed. The
 * defaults carried funding headlines in that check; the rest are regional or
 * noisier and are opt-in.
 */
export const FUNDING_FEEDS = {
  techcrunch: {
    label: "TechCrunch",
    urls: ["https://techcrunch.com/feed/", "https://techcrunch.com/category/startups/feed/", "https://techcrunch.com/tag/funding/feed/"],
    hosts: ["techcrunch.com"],
    byDefault: true,
  },
  crunchbase: { label: "Crunchbase News", urls: ["https://news.crunchbase.com/feed/"], hosts: ["news.crunchbase.com"], byDefault: true },
  prnewswire: {
    label: "PR Newswire (venture capital)",
    urls: ["https://www.prnewswire.com/rss/venture-capital-list.rss"],
    hosts: ["www.prnewswire.com"],
    byDefault: false,
  },
  siliconangle: { label: "SiliconANGLE", urls: ["https://siliconangle.com/feed/"], hosts: ["siliconangle.com"], byDefault: true },
  guardian: { label: "The Guardian (technology)", urls: ["https://www.theguardian.com/technology/rss"], hosts: ["www.theguardian.com"], byDefault: false },
  betakit: { label: "BetaKit (Canada)", urls: ["https://betakit.com/feed/"], hosts: ["betakit.com"], byDefault: false },
  geekwire: { label: "GeekWire (Pacific Northwest)", urls: ["https://www.geekwire.com/feed/"], hosts: ["www.geekwire.com"], byDefault: false },
} as const satisfies Record<string, FeedDefinition>;

const HN_HOST = "hn.algolia.com";
const HN_QUERIES = ["raises series a", "raises series b", "raises seed round", "startup raises funding", "emerges from stealth"];

export const FUNDED_SOURCES = ["techcrunch", "crunchbase", "prnewswire", "siliconangle", "guardian", "betakit", "geekwire", "hn"] as const;
export type FundedSource = (typeof FUNDED_SOURCES)[number];

export function defaultFundedSources(): FundedSource[] {
  return [...(Object.entries(FUNDING_FEEDS) as Array<[FundedSource, FeedDefinition]>).filter(([, feed]) => feed.byDefault).map(([name]) => name), "hn"];
}

export type FeedDiagnostic = { source: FundedSource; url: string; status: "ok" | "error"; items: number; fundingItems: number; error?: string };

export type FundedCandidate = {
  company: string;
  round: string;
  amount: string;
  date: string | null;
  source: FundedSource;
  title: string;
  url: string;
  leadId: string;
  isNew: boolean;
};

export type FundedResult = {
  candidates: FundedCandidate[];
  feeds: FeedDiagnostic[];
  added: number;
  already: number;
  windowMonths: number;
};

export type FundedOptions = {
  sources?: readonly string[];
  months?: number;
  limit?: number;
  now?: Date;
};

type Sourced = FeedItem & { source: FundedSource };

const MAX_FEED_BYTES = 4 * 1024 * 1024;

async function readRss(source: Exclude<FundedSource, "hn">, diagnostics: FeedDiagnostic[]): Promise<Sourced[]> {
  const feed: FeedDefinition = FUNDING_FEEDS[source];
  const items: Sourced[] = [];
  for (const url of feed.urls) {
    try {
      const xml = await fetchText(url, {
        allowedHosts: feed.hosts,
        accept: "application/rss+xml, application/atom+xml, application/xml, text/xml",
        maxBytes: MAX_FEED_BYTES,
        retries: 1,
      });
      const parsed = parseFeedItems(xml).map((item) => ({ ...item, source }));
      diagnostics.push({ source, url, status: "ok", items: parsed.length, fundingItems: parsed.filter((item) => companyFromHeadline(item.title)).length });
      items.push(...parsed);
    } catch (error) {
      diagnostics.push({ source, url, status: "error", items: 0, fundingItems: 0, error: toErrorMessage(error) });
    }
  }
  return items;
}

type HnHit = { objectID?: string; title?: string | null; url?: string | null; created_at?: string | null };

async function readHackerNews(months: number, now: Date, diagnostics: FeedDiagnostic[]): Promise<Sourced[]> {
  const cutoff = Math.floor(now.getTime() / 1000) - months * 31 * 86_400;
  const items: Sourced[] = [];
  for (const query of HN_QUERIES) {
    const url = `https://${HN_HOST}/api/v1/search?query=${encodeURIComponent(query)}&tags=story&hitsPerPage=50&numericFilters=${encodeURIComponent(`created_at_i>${cutoff}`)}`;
    try {
      const payload = await fetchJson<{ hits?: HnHit[] }>(url, { allowedHosts: [HN_HOST], retries: 1 });
      const hits = Array.isArray(payload.hits) ? payload.hits : [];
      const parsed = hits
        .filter((hit) => typeof hit.title === "string" && typeof hit.objectID === "string" && /^\d+$/.test(hit.objectID))
        .map((hit) => ({
          title: hit.title!.trim(),
          // The discussion page, not the article: an arbitrary third-party URL is never stored as the lead's link.
          link: `https://news.ycombinator.com/item?id=${hit.objectID}`,
          publishedAt: hit.created_at && Number.isFinite(Date.parse(hit.created_at)) ? new Date(hit.created_at).toISOString() : null,
          summary: "",
          source: "hn" as const,
        }));
      diagnostics.push({ source: "hn", url, status: "ok", items: parsed.length, fundingItems: parsed.filter((item) => companyFromHeadline(item.title)).length });
      items.push(...parsed);
    } catch (error) {
      diagnostics.push({ source: "hn", url, status: "error", items: 0, fundingItems: 0, error: toErrorMessage(error) });
    }
  }
  return items;
}

function requestedSources(sources: readonly string[] | undefined): FundedSource[] {
  if (!sources || sources.length === 0) return defaultFundedSources();
  const known = new Set<string>(FUNDED_SOURCES);
  const unknown = sources.filter((source) => !known.has(source));
  if (unknown.length > 0) {
    throw new AppError("unknown_funding_source", `unknown funding source(s): ${unknown.join(", ")}; choose from ${FUNDED_SOURCES.join(", ")}`);
  }
  return [...new Set(sources)] as FundedSource[];
}

/** Groups announcements by company, newest first, within the window. */
export function fundedCandidates(items: readonly Sourced[], months: number, now: Date): Array<Omit<FundedCandidate, "leadId" | "isNew">> {
  const cutoff = new Date(now.getTime());
  cutoff.setUTCMonth(cutoff.getUTCMonth() - months);
  const byCompany = new Map<string, Omit<FundedCandidate, "leadId" | "isNew">>();
  const sorted = [...items].sort((a, b) => (b.publishedAt ?? "").localeCompare(a.publishedAt ?? ""));
  for (const item of sorted) {
    if (item.publishedAt && (Date.parse(item.publishedAt) < cutoff.getTime() || Date.parse(item.publishedAt) > now.getTime() + 86_400_000)) continue;
    const company = companyFromHeadline(item.title);
    const key = company ? companyKey(company) : "";
    if (!key) continue;
    const details = fundingDetails(`${item.title} ${item.summary}`);
    const current = byCompany.get(key);
    if (current) {
      byCompany.set(key, { ...current, amount: current.amount || details.amount, round: current.round || details.round });
      continue;
    }
    byCompany.set(key, { company, ...details, date: item.publishedAt, source: item.source, title: item.title.slice(0, 200), url: item.link });
  }
  return [...byCompany.values()];
}

/** Fetches the allowlisted feeds and stores each recently funded company as a lead. */
export async function fetchFundedCompanies(workspace: Pick<Workspace, "db">, options: FundedOptions = {}): Promise<FundedResult> {
  const sources = requestedSources(options.sources);
  const months = Math.min(Math.max(Math.trunc(options.months ?? 3), 1), 24);
  const limit = Math.min(Math.max(Math.trunc(options.limit ?? 50), 1), 200);
  const now = options.now ?? new Date();
  const diagnostics: FeedDiagnostic[] = [];
  const items: Sourced[] = [];
  for (const source of sources) {
    items.push(...(source === "hn" ? await readHackerNews(months, now, diagnostics) : await readRss(source, diagnostics)));
  }
  const candidates = fundedCandidates(items, months, now).slice(0, limit);
  const leads: LeadInput[] = candidates.map((candidate) => ({
    source: FUNDED_SOURCE,
    sourceId: companyKey(candidate.company),
    title: candidate.title,
    company: candidate.company,
    url: candidate.url,
    publishedAt: candidate.date,
    details: { round: candidate.round, amount: candidate.amount, feed: candidate.source },
  }));
  const { added, existing } = upsertLeads(workspace.db, leads);
  const addedIds = new Set(added.map((lead) => lead.id));
  appendEvent(workspace.db, "leads.imported", FUNDED_SOURCE, { sources, found: candidates.length, added: added.length });
  return {
    candidates: candidates.map((candidate) => {
      const id = leadId(FUNDED_SOURCE, companyKey(candidate.company));
      return { ...candidate, leadId: id, isNew: addedIds.has(id) };
    }),
    feeds: diagnostics,
    added: added.length,
    already: existing.length,
    windowMonths: months,
  };
}
