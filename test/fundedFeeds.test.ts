import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { openDatabase, type Db } from "../src/db/database.js";
import { listLeads } from "../src/db/repositories/leads.js";
import { defaultFundedSources, fetchFundedCompanies, fundedCandidates } from "../src/sourcing/funded.js";
import { companyFromHeadline, companyKey, fundingDetails, normalizeAmount, parseFeedItems } from "../src/sourcing/fundedParse.js";

/** Fictional headlines only; the fixtures mimic the shapes of the real feeds. */

const FIXTURES = join(import.meta.dirname, "fixtures", "sourcing");
const RSS = readFileSync(join(FIXTURES, "funding-feed.rss"), "utf8");
const ATOM = readFileSync(join(FIXTURES, "funding-feed.atom"), "utf8");
const NOW = new Date("2026-11-06T12:00:00Z");

const HN = {
  hits: [
    { objectID: "41000001", title: "Hooli XYZ raises $30M Series A for edge databases", url: "https://blog.hooli-xyz.test/series-a", created_at: "2026-11-01T10:00:00Z" },
    { objectID: "41000002", title: "Show HN: I built a funding tracker", url: null, created_at: "2026-11-01T11:00:00Z" },
    { objectID: "not-a-number", title: "Ignored Corp raises $1M", created_at: "2026-11-01T11:00:00Z" },
  ],
};

let db: Db;
beforeEach(() => {
  db = openDatabase(":memory:");
  process.env.AUTOAPPLY_MIN_INTERVAL_MS = "0";
});
afterEach(() => {
  db.close();
  vi.unstubAllGlobals();
});

describe("feed parsing", () => {
  it("reads RSS items and Atom entries, decoding CDATA and entities", () => {
    const items = parseFeedItems(RSS);
    expect(items).toHaveLength(10);
    expect(items[0]).toEqual({
      title: "Acme Robotics raises $40M Series B to build warehouse arms",
      link: "https://techcrunch.com/2026/11/04/acme-robotics-raises-40m/",
      publishedAt: "2026-11-04T15:00:00.000Z",
      summary: "The round was led by Example Ventures.",
    });
    expect(items[1]!.title).toBe("Paris-based AI startup Globex Analytics lands \u20ac12 million seed round");
    expect(parseFeedItems(ATOM)).toEqual([
      {
        title: "Tyrell Systems emerges from stealth with $15 million",
        link: "https://news.crunchbase.com/2026/11/tyrell-systems/",
        publishedAt: "2026-11-05T08:00:00.000Z",
        summary: "Tyrell Systems, a developer tools company, announced its debut.",
      },
    ]);
  });

  it("names the company only when a headline clearly announces its funding", () => {
    const names = parseFeedItems(RSS).map((item) => companyFromHeadline(item.title));
    expect(names).toEqual([
      "Acme Robotics",
      "Globex Analytics",
      "Initech Security",
      "", // acquisition
      "", // a venture fund, not a company
      "", // layoffs in the same headline
      "Pied Piper", // people raised money for the startup
      "", // advice column
      "Acme Robotics",
      "Old Corp",
    ]);
    expect(companyFromHeadline("Tyrell Systems emerges from stealth with $15 million")).toBe("Tyrell Systems");
    expect(companyFromHeadline("Fintech startup Kramerica hits $2B valuation after $300M round")).toBe("Kramerica");
    expect(companyFromHeadline("Exclusive: Toronto-based Wayne Biotech secures $9M Series A")).toBe("Wayne Biotech");
    expect(companyFromHeadline("Engineers from Initrode raise $3M")).toBe("");
  });

  it("extracts round and amount", () => {
    expect(fundingDetails("Acme raises $40M Series B")).toEqual({ amount: "$40M", round: "Series B" });
    expect(fundingDetails("lands \u20ac12 million seed round")).toEqual({ amount: "\u20ac12M", round: "seed" });
    expect(fundingDetails("Ocient raises $100 million as AI drives growth")).toEqual({ amount: "$100M", round: "" });
    expect(normalizeAmount("$5.2-million")).toBe("$5.2M");
    expect(normalizeAmount("US$1.5 billion")).toBe("US$1.5B");
    expect(normalizeAmount("no money here")).toBe("");
    expect(companyKey("Acme Robotics, Inc.")).toBe(companyKey("acme robotics"));
  });

  it("groups announcements per company within the window, newest first", () => {
    const items = parseFeedItems(RSS).map((item) => ({ ...item, source: "techcrunch" as const }));
    const candidates = fundedCandidates(items, 3, NOW);
    expect(candidates.map((candidate) => candidate.company)).toEqual(["Acme Robotics", "Globex Analytics", "Initech Security", "Pied Piper"]);
    expect(candidates[0]).toMatchObject({ round: "Series B", amount: "$40M", date: "2026-11-04T15:00:00.000Z", url: "https://techcrunch.com/2026/11/04/acme-robotics-raises-40m/" });
  });
});

describe("fetchFundedCompanies", () => {
  function stubFeeds(): string[] {
    const requested: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: string | URL) => {
        const url = String(input);
        requested.push(url);
        if (url.startsWith("https://techcrunch.com/feed/")) return new Response(RSS, { status: 200, headers: { "content-type": "application/rss+xml" } });
        if (url.startsWith("https://techcrunch.com/")) return new Response("<rss><channel></channel></rss>", { status: 200 });
        if (url.startsWith("https://news.crunchbase.com/")) return new Response(ATOM, { status: 200 });
        if (url.startsWith("https://siliconangle.com/")) return new Response(null, { status: 302, headers: { location: "https://feeds.elsewhere.test/rss" } });
        if (url.startsWith("https://hn.algolia.com/")) return new Response(JSON.stringify(HN), { status: 200, headers: { "content-type": "application/json" } });
        return new Response("not found", { status: 404 });
      }),
    );
    return requested;
  }

  it("reads only allowlisted feeds and stores each funded company as a lead", async () => {
    const requested = stubFeeds();
    const result = await fetchFundedCompanies({ db }, { now: NOW });

    expect(defaultFundedSources()).toEqual(["techcrunch", "crunchbase", "siliconangle", "hn"]);
    expect(requested.some((url) => url.includes("elsewhere.test"))).toBe(false);
    const silicon = result.feeds.find((feed) => feed.source === "siliconangle");
    expect(silicon).toMatchObject({ status: "error" });
    expect(silicon?.error).toContain("source_host_not_allowed");

    expect(result.candidates.map((candidate) => candidate.company)).toEqual([
      "Tyrell Systems",
      "Acme Robotics",
      "Globex Analytics",
      "Initech Security",
      "Hooli XYZ",
      "Pied Piper",
    ]);
    const hooli = result.candidates.find((candidate) => candidate.company === "Hooli XYZ");
    // The discussion page is stored, never the arbitrary article URL.
    expect(hooli).toMatchObject({ source: "hn", url: "https://news.ycombinator.com/item?id=41000001", round: "Series A", amount: "$30M", isNew: true });
    expect(result).toMatchObject({ added: 6, already: 0, windowMonths: 3 });

    const leads = listLeads(db, { source: "funded" });
    expect(leads).toHaveLength(6);
    const acme = leads.find((lead) => lead.company === "Acme Robotics");
    expect(acme).toMatchObject({ sourceId: "acmerobotics", status: "new", details: { round: "Series B", amount: "$40M", feed: "techcrunch" } });

    const again = await fetchFundedCompanies({ db }, { now: NOW });
    expect(again).toMatchObject({ added: 0, already: 6 });
    expect(again.candidates.every((candidate) => !candidate.isNew)).toBe(true);
  });

  it("rejects unknown sources", async () => {
    await expect(fetchFundedCompanies({ db }, { sources: ["somewhere"] })).rejects.toMatchObject({ code: "unknown_funding_source" });
  });
});
