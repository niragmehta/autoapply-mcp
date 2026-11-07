import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { listSourceCatalog } from "../src/sources/catalog.js";
import { fetchJson, fetchText } from "../src/sources/http.js";
import { clearLeadCache } from "../src/sources/leads/common.js";
import { SEARCH_SOURCE_IDS, SourceSearchInputSchema } from "../src/sources/leadTypes.js";
import type { SearchSourceId } from "../src/sources/leadTypes.js";
import { searchJobSources, supportedFilters } from "../src/sources/search.js";
import { jobBankFeed } from "./fixtures/jobbankca.js";
import { wwrFeed } from "./fixtures/weworkremotely.js";

vi.mock("../src/sources/http.js", () => ({ fetchJson: vi.fn(), fetchText: vi.fn(), userAgent: () => "autoapply-test" }));
const jsonMock = vi.mocked(fetchJson);
const textMock = vi.mocked(fetchText);

beforeEach(() => {
  jsonMock.mockReset();
  textMock.mockReset();
  clearLeadCache();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("lead source registry", () => {
  it("offers the aggregator and VC-network lead sources", () => {
    expect(SEARCH_SOURCE_IDS).toEqual([
      "himalayas", "foorilla", "builtin", "remoteok", "remotive", "weworkremotely", "jobicy", "themuse",
      "jobbankca", "getro", "consider", "workingnomads",
    ]);
    expect(supportedFilters("jobbankca")).toEqual(["country", "location"]);
    expect(supportedFilters("builtin")).toEqual(["location", "company", "category", "site"]);
  });

  it("bounds the category and site filters", () => {
    expect(SourceSearchInputSchema.safeParse({ query: "x", limit: 1, category: "a".repeat(101) }).success).toBe(false);
    expect(SourceSearchInputSchema.safeParse({ query: "x", limit: 1, site: "a".repeat(201) }).success).toBe(false);
    expect(SourceSearchInputSchema.parse({ query: "x", limit: 1, category: " dev ", site: "jobs.accel.com" }))
      .toMatchObject({ category: "dev", site: "jobs.accel.com" });
  });

  it.each([
    ["themuse", { country: "US" }, ["country"]],
    ["jobbankca", { company: "Acme" }, ["company"]],
    ["getro", { company: "Acme", category: "eng" }, ["company", "category"]],
    ["consider", { company: "Acme" }, ["company"]],
    ["builtin", { country: "US" }, ["country"]],
    ["remoteok", { category: "dev" }, ["category"]],
    ["jobicy", { location: "Austin" }, ["location"]],
    ["workingnomads", { site: "x" }, ["site"]],
    ["himalayas", { site: "x" }, ["site"]],
    ["foorilla", { category: "x" }, ["category"]],
  ] as const)("rejects filters %s cannot apply before any request", async (source, filters, unsupported) => {
    await expect(searchJobSources(source, { query: "Software Engineering", limit: 5, ...filters }))
      .rejects.toMatchObject({ code: "source_filter_unsupported", details: { source, unsupported } });
    expect(jsonMock).not.toHaveBeenCalled();
    expect(textMock).not.toHaveBeenCalled();
  });

  it("validates the search before checking filters", async () => {
    await expect(searchJobSources("themuse", { query: " ", limit: 5, country: "US" })).rejects.toMatchObject({ code: "invalid_source_search" });
  });

  it.each([
    ["remoteok", {}, "json", [], "https://remoteok.com/api"],
    ["remotive", {}, "json", { jobs: [] }, "https://remotive.com/api/remote-jobs?search=engineer"],
    ["jobicy", {}, "json", { jobs: [] }, "https://jobicy.com/api/jobs?count=50&tag=engineer"],
    ["themuse", { query: "Software Engineering" }, "json", { page: 0, page_count: 0, results: [] }, "https://www.themuse.com/api/public/jobs?page=0&category=Software+Engineering"],
    ["workingnomads", {}, "json", [], "https://www.workingnomads.com/api/exposed_jobs/"],
    ["getro", { site: "jobs.accel.com" }, "json", { results: { jobs: [], count: 0 } }, "https://api.getro.com/api/v2/collections/8672/search/jobs"],
    ["weworkremotely", {}, "text", wwrFeed([]), "https://weworkremotely.com/remote-jobs.rss"],
    ["jobbankca", {}, "text", jobBankFeed([]), "https://www.jobbank.gc.ca/jobsearch/feed/jobSearchRSSfeed?searchstring=engineer&locationstring=&page=1"],
    ["builtin", { category: "dev-engineering" }, "text", "<html></html>", "https://builtin.com/jobs/dev-engineering/search/engineer"],
  ] as const)("routes %s to its own endpoint", async (source, input, kind, payload, url) => {
    vi.stubEnv("AUTOAPPLY_ENABLE_RESTRICTED_SOURCES", "builtin, JobBankCA");
    (kind === "json" ? jsonMock : textMock).mockResolvedValue(payload as never);
    const result = await searchJobSources(source as SearchSourceId, { query: "engineer", limit: 5, ...input });
    expect(result).toMatchObject({ source, readiness: "ready", leads: [] });
    expect((kind === "json" ? jsonMock : textMock).mock.calls[0]?.[0]).toBe(url);
    expect(result.attribution.requirements.length).toBeGreaterThan(0);
    expect(result.limitations.join(" ")).toMatch(/verify|employer/i);
  });

  it.each(["builtin", "jobbankca"] as const)("keeps %s off until named, since its terms prohibit automated access", async (source) => {
    const input = { query: "engineer", limit: 5, ...(source === "builtin" ? { category: "dev-engineering" } : {}) };

    await expect(searchJobSources(source, input)).rejects.toMatchObject({ code: "source_restricted", details: { source } });
    expect(listSourceCatalog().find((entry) => entry.id === source)?.readiness).toBe("opt-in-required");
    expect(jsonMock).not.toHaveBeenCalled();
    expect(textMock).not.toHaveBeenCalled();

    vi.stubEnv("AUTOAPPLY_ENABLE_RESTRICTED_SOURCES", source);
    expect(listSourceCatalog().find((entry) => entry.id === source)?.readiness).toBe("opted-in");
  });
});
