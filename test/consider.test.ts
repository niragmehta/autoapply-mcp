import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchJson } from "../src/sources/http.js";
import { clearLeadCache } from "../src/sources/leads/common.js";
import { considerServerData, searchConsider } from "../src/sources/leads/consider.js";
import { CONSIDER_TOKEN, considerBoardPage, considerJob, considerPage } from "./fixtures/consider.js";

vi.mock("../src/sources/http.js", () => ({ fetchJson: vi.fn(), fetchText: vi.fn(), userAgent: () => "autoapply-test" }));
const jsonMock = vi.mocked(fetchJson);
const COOKIES = ["session=abc; Path=/; HttpOnly", "session.sig=def; Path=/; HttpOnly"];

function boardResponse(html: string, init: { status?: number; cookies?: string[]; location?: string } = {}): Response {
  const headers = new Headers({ "content-type": "text/html; charset=utf-8" });
  for (const cookie of init.cookies ?? COOKIES) headers.append("set-cookie", cookie);
  if (init.location) headers.set("location", init.location);
  return new Response(init.status && init.status >= 300 && init.status < 400 ? null : html, { status: init.status ?? 200, headers });
}

function stubBoard(make: () => Response = () => boardResponse(considerBoardPage())) {
  const stub = vi.fn(async (_url: string | URL, _init?: RequestInit) => make());
  vi.stubGlobal("fetch", stub);
  return stub;
}

function postBody(call = 0) {
  return (jsonMock.mock.calls[call]?.[1] as { body: Record<string, unknown> }).body;
}

beforeEach(() => {
  jsonMock.mockReset();
  clearLeadCache();
});
afterEach(() => vi.unstubAllGlobals());

describe("Consider lead source", () => {
  it("opens the board's anonymous session once and searches with its token and cookies", async () => {
    const board = stubBoard();
    jsonMock.mockResolvedValue(considerPage([
      considerJob(),
      considerJob({ jobId: "2", applicationWindow: { status: "closed" } }),
      considerJob({
        jobId: "3", locations: [], normalizedLocations: [{ label: "New York, NY", value: "new-york" }], remote: false, hybrid: true,
        salary: { minValue: "lots" }, applyUrl: null, url: "https://jobs.lever.co/exampleco/3",
      }),
    ], 3));
    const result = await searchConsider({ query: "security", site: "jobs.lsvp.com", limit: 20 });
    expect(board).toHaveBeenCalledTimes(1);
    expect(board.mock.calls[0]?.[0]).toBe("https://jobs.lsvp.com/jobs");
    expect(board.mock.calls[0]?.[1]).toMatchObject({ method: "GET", redirect: "manual", headers: { "user-agent": "autoapply-test" } });
    expect(jsonMock).toHaveBeenCalledWith("https://jobs.lsvp.com/api-boards/search-jobs", {
      body: { meta: { size: 50 }, board: { id: "lightspeed", isParent: true }, query: { promoteFeatured: true, titlePrefix: "security" } },
      headers: { "x-csrf-token": CONSIDER_TOKEN, cookie: "session=abc; session.sig=def", referer: "https://jobs.lsvp.com/jobs" },
      allowedHosts: ["jobs.lsvp.com"], minIntervalMs: 700,
    });
    expect(result.leads.map((lead) => lead.sourceId)).toEqual(["4751411005", "3"]);
    expect(result.leads[0]).toMatchObject({
      source: "consider", sourceUrl: "https://jobs.lsvp.com/jobs",
      applyUrl: "https://job-boards.greenhouse.io/exampleco/jobs/4751411005",
      title: "Senior Security Engineer", company: "Example Co", locations: ["Remote - Global"], description: "",
      salary: { min: 200000, max: 300000, currency: "USD", period: "year", provenance: "aggregator" },
      publishedAt: "2026-11-06T11:18:07.000Z",
      provenance: { kind: "aggregator", endpoint: "https://jobs.lsvp.com/api-boards/search-jobs", publishedAtRaw: "2026-11-06T11:18:07Z" },
      mustVerifyEmployer: true,
    });
    expect(result.leads[1]).toMatchObject({ locations: ["New York, NY", "Hybrid"], applyUrl: "https://jobs.lever.co/exampleco/3" });
    expect(result.leads[1]?.salary).toBeUndefined();
    expect(result.pagination).toMatchObject({ page: 1, pageSize: 50, total: 3, totalPages: 1, hasMore: false });
    expect(result.attribution).toMatchObject({ label: "Lightspeed Venture Partners job board (Consider)", url: "https://jobs.lsvp.com/jobs" });
  });

  it("maps remote, location and country filters onto Consider's query", async () => {
    stubBoard();
    jsonMock.mockResolvedValue(considerPage([]));
    await searchConsider({ query: "*", location: "remote", site: "jobs.sequoiacap.com", limit: 5 });
    await searchConsider({ query: "engineer", country: "US", site: "https://jobs.kleinerperkins.com/jobs", limit: 5 });
    await searchConsider({ query: "engineer", location: "London", country: "US", site: "jobs.bvp.com", limit: 5 });
    expect([0, 1, 2].map((call) => postBody(call).query)).toEqual([
      { promoteFeatured: true, remoteOnly: true },
      { promoteFeatured: true, titlePrefix: "engineer", locations: ["United States"] },
      { promoteFeatured: true, titlePrefix: "engineer", locations: ["London"] },
    ]);
    expect(jsonMock.mock.calls[1]?.[0]).toBe("https://jobs.kleinerperkins.com/api-boards/search-jobs");
  });

  it("follows the opaque cursor for later pages and stops when it runs out", async () => {
    const board = stubBoard();
    const fifty = Array.from({ length: 50 }, (_, index) => considerJob({ jobId: `p1-${index}` }));
    jsonMock.mockResolvedValueOnce(considerPage(fifty, 120, "seq-1")).mockResolvedValueOnce(considerPage([considerJob({ jobId: "p2" })], 120, "seq-2"));
    const second = await searchConsider({ query: "engineer", site: "jobs.felicis.com", limit: 20, page: 2 });
    expect(board).toHaveBeenCalledTimes(1);
    expect(postBody(1).meta).toEqual({ size: 50, sequence: "seq-1" });
    expect(second.leads.map((lead) => lead.sourceId)).toEqual(["p2"]);
    expect(second.pagination).toMatchObject({ page: 2, total: 120, totalPages: 3, hasMore: true, nextPage: 3 });
    jsonMock.mockReset();
    jsonMock.mockResolvedValueOnce(considerPage([considerJob()], 1));
    const beyond = await searchConsider({ query: "engineer", site: "jobs.founderful.com", limit: 20, page: 2 });
    expect(beyond.leads).toEqual([]);
    expect(jsonMock).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ site: "jobs.example.com" }],
    [{}],
    [{ site: "http://jobs.lsvp.com" }],
    [{ site: "jobs.lsvp.com", page: 6 }],
  ])("rejects %j without any request", async (input) => {
    const board = stubBoard();
    await expect(searchConsider({ query: "engineer", limit: 5, ...input })).rejects.toMatchObject({ code: "source_filter_unsupported" });
    expect(board).not.toHaveBeenCalled();
    expect(jsonMock).not.toHaveBeenCalled();
  });

  it("fails clearly when the session handshake cannot be completed", async () => {
    stubBoard(() => boardResponse("<html>maintenance</html>"));
    await expect(searchConsider({ query: "a", site: "jobs.lsvp.com", limit: 5 })).rejects.toMatchObject({ code: "invalid_source_response" });
    stubBoard(() => boardResponse("", { status: 404 }));
    await expect(searchConsider({ query: "b", site: "jobs.sequoiacap.com", limit: 5 })).rejects.toMatchObject({ code: "not_found" });
    stubBoard(() => boardResponse("", { status: 302, location: "https://login.example.com/" }));
    await expect(searchConsider({ query: "c", site: "jobs.bvp.com", limit: 5 })).rejects.toMatchObject({ code: "source_host_not_allowed" });
    stubBoard(() => { throw new TypeError("fetch failed"); });
    await expect(searchConsider({ query: "d", site: "jobs.felicis.com", limit: 5 })).rejects.toMatchObject({ code: "network_error" });
    expect(jsonMock).not.toHaveBeenCalled();
  });

  it("reads the board state as data and validates it", () => {
    expect(considerServerData(considerBoardPage("sequoia"))).toEqual({ csrfToken: CONSIDER_TOKEN, board: { id: "sequoia", isParent: true } });
    expect(() => considerServerData(considerBoardPage("sequoia", "short"))).toThrow(expect.objectContaining({ code: "invalid_source_response" }));
    expect(() => considerServerData("<script>window.serverInitialData = {oops};</script>")).toThrow(/session data/);
  });
});
