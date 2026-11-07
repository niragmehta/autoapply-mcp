import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchJson } from "../src/sources/http.js";
import { clearLeadCache } from "../src/sources/leads/common.js";
import { searchTheMuse } from "../src/sources/leads/themuse.js";
import { AppError } from "../src/util/errors.js";
import { museJob, musePage } from "./fixtures/themuse.js";

vi.mock("../src/sources/http.js", () => ({ fetchJson: vi.fn(), fetchText: vi.fn(), userAgent: () => "autoapply-test" }));
const fetchMock = vi.mocked(fetchJson);
const KEY = "muse-test-key-123";

beforeEach(() => {
  fetchMock.mockReset();
  clearLeadCache();
  vi.stubEnv("AUTOAPPLY_THEMUSE_API_KEY", undefined);
});
afterEach(() => vi.unstubAllEnvs());

describe("The Muse lead source", () => {
  it("requires the query to be a Muse category instead of returning unrelated jobs", async () => {
    const error = await searchTheMuse({ query: "security engineer", limit: 5 }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "source_filter_unsupported" });
    expect(String((error as Error).message)).toMatch(/Software Engineering/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requests one 0-based page by category, location and company", async () => {
    fetchMock.mockResolvedValue(musePage([museJob()], 1));
    const result = await searchTheMuse({ query: "software engineering", location: "New York, NY", company: "Example Co", page: 2, limit: 20 });
    const endpoint = "https://www.themuse.com/api/public/jobs?page=1&category=Software+Engineering&location=New+York%2C+NY&company=Example+Co";
    expect(fetchMock).toHaveBeenCalledWith(endpoint, { allowedHosts: ["www.themuse.com"], minIntervalMs: 700 });
    expect(result.leads[0]).toMatchObject({
      source: "themuse", sourceId: "22328908",
      sourceUrl: "https://www.themuse.com/jobs/exampleco/lead-deployment-engineer-a54dc0",
      title: "Lead Deployment Engineer", company: "Example Co", locations: ["New York, NY"],
      publishedAt: "2026-11-04T18:38:32.000Z",
      provenance: { kind: "aggregator", endpoint, publishedAtRaw: "2026-11-04T18:38:32Z" },
      mustVerifyEmployer: true,
    });
    expect(result.leads[0]).not.toHaveProperty("applyUrl");
    expect(result.pagination).toMatchObject({ page: 2, pageSize: 20, total: 95413, totalPages: 4771, hasMore: true, nextPage: 3 });
    expect(result.attribution.requirements.join(" ")).toMatch(/register an app/);
  });

  it("sends a configured API key without echoing it in results or errors", async () => {
    vi.stubEnv("AUTOAPPLY_THEMUSE_API_KEY", KEY);
    fetchMock.mockResolvedValueOnce(musePage([museJob()]));
    const result = await searchTheMuse({ query: "Data Science", limit: 5 });
    expect(new URL(fetchMock.mock.calls[0]![0]).searchParams.get("api_key")).toBe(KEY);
    expect(JSON.stringify(result)).not.toContain(KEY);
    expect(result.leads[0]?.provenance.endpoint).toBe("https://www.themuse.com/api/public/jobs?page=0&category=Data+Science");
    fetchMock.mockRejectedValueOnce(new AppError("http_error", `HTTP 403 from https://www.themuse.com/api/public/jobs?api_key=${KEY}`, { status: 403 }));
    const error = await searchTheMuse({ query: "Data Science", limit: 5, page: 2 }).catch((caught: unknown) => caught);
    expect(error).toMatchObject({ code: "http_error", message: "The Muse request failed.", details: { status: 403 } });
    expect(JSON.stringify(error) + String(error)).not.toContain(KEY);
  });

  it("skips malformed results and rejects malformed pages", async () => {
    fetchMock.mockResolvedValueOnce(musePage([museJob(), { id: 1 }], 0, 1, 2));
    const result = await searchTheMuse({ query: "Data Science", limit: 5 });
    expect(result.leads).toHaveLength(1);
    expect(result.pagination).toMatchObject({ total: 2, totalPages: 1, hasMore: false });
    expect(result.limitations).toContain("1 malformed listing(s) in this response were skipped.");
    fetchMock.mockResolvedValueOnce({ results: "nope" });
    await expect(searchTheMuse({ query: "Data Science", limit: 5, page: 3 })).rejects.toMatchObject({ code: "invalid_source_response" });
  });
});
