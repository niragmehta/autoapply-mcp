import { afterEach, describe, expect, it, vi } from "vitest";
import { boardFromUrl, extractBoardLinks } from "../src/sources/boardLinks.js";
import { scanSourcePage } from "../src/sources/pages.js";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("employer board links", () => {
  it.each([
    ["https://job-boards.greenhouse.io/acme/jobs/123", "greenhouse", "acme"],
    ["https://boards.greenhouse.io/embed/job_board?for=acme", "greenhouse", "acme"],
    ["https://jobs.lever.co/acme/123", "lever", "acme"],
    ["https://jobs.ashbyhq.com/acme/123", "ashby", "acme"],
    ["https://acme.wd5.myworkdayjobs.com/en-US/External/job/A/Role", "workday", "acme/wd5/External"],
    ["https://jobs.smartrecruiters.com/Acme/123-role", "smartrecruiters", "Acme"],
    ["https://careers.smartrecruiters.com/Acme", "smartrecruiters", "Acme"],
    ["https://apply.workable.com/acme/j/ABC", "workable", "acme"],
    ["https://acme.recruitee.com/o/role", "recruitee", "acme"],
  ])("recognizes %s without fetching it", (url, ats, board) => {
    expect(boardFromUrl(url)).toMatchObject({ ats, board });
  });

  it.each([
    "http://jobs.ashbyhq.com/acme/1",
    "https://jobs.ashbyhq.com.evil.example/acme/1",
    "https://eviljobs.ashbyhq.com/acme/1",
    "https://user:pass@jobs.ashbyhq.com/acme/1",
    "https://apply.workable.com/j/ABC",
    "https://acme.recruitee.com:8443/o/role",
    "https://jobs.ashbyhq.com/../private",
    "not a URL",
  ])("does not turn %s into a board", (url) => {
    expect(boardFromUrl(url)).toBeNull();
  });

  it("decodes embedded links, retains EU region, and deduplicates boards", () => {
    const links = extractBoardLinks(String.raw`
      <a href="https://jobs.eu.lever.co/acme/1?x=1&amp;y=2">role</a>
      {"url":"https:\/\/jobs.eu.lever.co\/acme\/2"}
      https://jobs.ashbyhq.com/example/3
    `);
    expect(links).toHaveLength(2);
    expect(links[0]).toMatchObject({ ats: "lever", board: "acme", region: "eu" });
  });
});

describe("bounded source page scanning", () => {
  it("returns read-only leads and source provenance without visiting employers", async () => {
    vi.stubEnv("AUTOAPPLY_MIN_INTERVAL_MS", "0");
    const fetch = vi.fn(async () => new Response(`
      <a href="https://jobs.ashbyhq.com/acme/role1">Security Engineer</a>
      <a href="/jobs/acme">Company jobs</a>
    `));
    vi.stubGlobal("fetch", fetch);
    const result = await scanSourcePage("a16z", { limit: 10 });
    expect(result.sourceId).toBe("a16z");
    expect(result.boards).toHaveLength(1);
    expect(result.boards[0]).toMatchObject({ ats: "ashby", board: "acme" });
    expect(result.requiresEmployerVerification).toBe(true);
    expect(result.scannedPages).toBe(1);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("reports a rendered-only page as lacking extractable boards, not an exhaustive empty inventory", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("<html><div id='root'></div></html>")));
    const result = await scanSourcePage("yc", {});
    expect(result.boards).toEqual([]);
    expect(result.warning).toMatch(/rendered|browser|complete/i);
  });

  it("rejects cross-source URLs before making a request", async () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(scanSourcePage("sequoia", { url: "https://evil.example/jobs" })).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("returns a truncation indicator when more boards exist than the limit", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response(
      "https://jobs.ashbyhq.com/acme/1 https://jobs.lever.co/second/2",
    )));
    const result = await scanSourcePage("a16z", { limit: 1 });
    expect(result.boards).toHaveLength(1);
    expect(result.truncated).toBe(true);
  });
});
