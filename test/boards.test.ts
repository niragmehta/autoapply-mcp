import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readCompanyFile, upsertCompany } from "../src/config/companies.js";
import { verifyBoard } from "../src/sources/registry.js";
import { CompanySchema } from "../src/domain/campaign.js";

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
}

function company(overrides: Record<string, unknown> = {}) {
  return CompanySchema.parse({ name: "Acme", ats: "greenhouse", board: "acme", ...overrides });
}

function tempFile(): string {
  return join(mkdtempSync(join(tmpdir(), "autoapply-boards-")), "companies.json");
}

beforeEach(() => {
  process.env.AUTOAPPLY_MIN_INTERVAL_MS = "0";
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("board verification", () => {
  it("accepts a board that serves postings", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          jobs: [
            { id: 1, title: "Security Engineer", absolute_url: "https://x/1", location: { name: "San Francisco, CA" } },
          ],
        }),
      ),
    );

    const result = await verifyBoard(company());

    expect(result.ok).toBe(true);
    expect(result.postings).toBe(1);
    expect(result.sampleTitles).toEqual(["Security Engineer"]);
  });

  it("rejects a board that responds but publishes nothing", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ jobs: [] })));

    const result = await verifyBoard(company());

    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/no postings/i);
  });

  it("reports the failure instead of throwing when a board 404s", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "not found" }, 404)));

    const result = await verifyBoard(company({ board: "does-not-exist" }));

    expect(result.ok).toBe(false);
    expect(result.postings).toBe(0);
  });

  it("rejects a wrong workday slug that answers 200 with a generic page", async () => {
    // The trap this whole check exists for: a wrong Workday site slug does not
    // 404, it serves an unrelated page. Trusting the status code would record a
    // board that can never return a job.
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ body: { children: [] } })));

    const result = await verifyBoard(company({ ats: "workday", board: "cisco/wd1/Wrong_Site" }));

    expect(result.ok).toBe(false);
    expect(result.detail).toMatch(/site slug is wrong/i);
  });

  it("verifies a workday board with one request, not a full crawl", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ total: 877, jobPostings: [{ title: "Security Engineer", externalPath: "/job/a/1" }] }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await verifyBoard(company({ ats: "workday", board: "cisco/wd5/Cisco_Careers" }));

    expect(result.ok).toBe(true);
    expect(result.postings).toBe(877);
    // A full listJobs would fetch every posting's detail page; verification must not.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects a malformed workday board without making a request", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}));
    vi.stubGlobal("fetch", fetchMock);

    const result = await verifyBoard(company({ ats: "workday", board: "cisco" }));

    expect(result.ok).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("companies file", () => {
  it("adds a company and reads it back", () => {
    const path = tempFile();
    writeFileSync(path, JSON.stringify({ version: 1, companies: [] }), "utf8");

    const result = upsertCompany(path, { name: "Cisco", ats: "workday", board: "cisco/wd5/Cisco_Careers" });

    expect(result.action).toBe("added");
    expect(readCompanyFile(path)).toHaveLength(1);
    expect(readCompanyFile(path)[0]!.board).toBe("cisco/wd5/Cisco_Careers");
  });

  it("updates an existing company instead of duplicating it", () => {
    const path = tempFile();
    writeFileSync(
      path,
      JSON.stringify({ version: 1, companies: [{ name: "Cisco", ats: "workday", board: "cisco/wd1/Old_Site" }] }),
      "utf8",
    );

    // Case differs deliberately: a duplicate entry would fetch the board twice
    // and surface every posting twice in the queue.
    const result = upsertCompany(path, { name: "cisco", ats: "workday", board: "cisco/wd5/Cisco_Careers" });

    expect(result.action).toBe("updated");
    const companies = readCompanyFile(path);
    expect(companies).toHaveLength(1);
    expect(companies[0]!.board).toBe("cisco/wd5/Cisco_Careers");
  });

  it("preserves existing entries when adding a new one", () => {
    const path = tempFile();
    writeFileSync(
      path,
      JSON.stringify({ version: 1, companies: [{ name: "1Password", ats: "ashby", board: "1password", tier: "A" }] }),
      "utf8",
    );

    upsertCompany(path, { name: "Cisco", ats: "workday", board: "cisco/wd5/Cisco_Careers" });

    const companies = readCompanyFile(path);
    expect(companies.map((entry) => entry.name)).toEqual(["1Password", "Cisco"]);
    expect(companies[0]!.tier).toBe("A");
  });

  it("reads a file that carries a byte-order mark", () => {
    const path = tempFile();
    writeFileSync(path, `\uFEFF${JSON.stringify({ version: 1, companies: [] })}`, "utf8");

    expect(readCompanyFile(path)).toEqual([]);
  });

  it("rejects an invalid company rather than writing a broken board list", () => {
    const path = tempFile();
    writeFileSync(path, JSON.stringify({ version: 1, companies: [] }), "utf8");

    expect(() => upsertCompany(path, { name: "Nope", ats: "taleo", board: "nope" })).toThrow();
    expect(readCompanyFile(path)).toEqual([]);
  });

  it("leaves no staging file behind", () => {
    const path = tempFile();
    writeFileSync(path, JSON.stringify({ version: 1, companies: [] }), "utf8");

    upsertCompany(path, { name: "Cisco", ats: "workday", board: "cisco/wd5/Cisco_Careers" });

    expect(existsSync(`${path}.tmp`)).toBe(false);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ version: 1 });
  });
});
