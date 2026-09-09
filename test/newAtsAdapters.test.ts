import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CompanySchema } from "../src/domain/campaign.js";
import { JobSchema } from "../src/domain/job.js";
import { fetchJson, fetchText } from "../src/sources/http.js";
import { smartrecruitersAdapter } from "../src/sources/smartrecruiters.js";
import { workableAdapter } from "../src/sources/workable.js";
import { recruiteeAdapter } from "../src/sources/recruitee.js";

vi.mock("../src/sources/http.js", () => ({ fetchJson: vi.fn(), fetchText: vi.fn() }));

const capturedAt = "2026-09-08T12:00:00Z";
const json = vi.mocked(fetchJson);
const text = vi.mocked(fetchText);

function company(ats: string, overrides: Record<string, unknown> = {}) {
  return CompanySchema.parse({ name: "Example Employer", ats, board: "example", ...overrides });
}

function smartPosting(id = "123", overrides: Record<string, unknown> = {}) {
  return {
    id, name: "Platform Engineer", active: true,
    location: { city: "San Jose", region: "CA", country: "us", remote: false, hybrid: true },
    releasedDate: "2026-09-01T09:30:00Z",
    typeOfEmployment: { label: "Full-time" },
    jobAd: { sections: {
      companyDescription: { text: "<p>Employer background.</p>" },
      jobDescription: { text: "<p>Build dependable infrastructure.</p>" },
      qualifications: { text: "<p>Operate distributed systems.</p>" },
    } },
    ...overrides,
  };
}

function smartPage(content: unknown[], totalFound = content.length, offset = 0) {
  return { content, totalFound, offset, limit: 100 };
}

function workablePosting(overrides: Record<string, unknown> = {}) {
  return {
    shortcode: "ABC123", title: "Platform Engineer", employment_type: "Full-time",
    telecommuting: false, published_on: "2026-09-01", created_at: "2026-08-01",
    locations: [{ city: "Toronto", region: "Ontario", country: "Canada", countryCode: "CA" }],
    description: "<p>Build dependable infrastructure.</p>",
    ...overrides,
  };
}

function offer(extra = "", id = "123") {
  return `<offer><id>${id}</id><slug>platform-engineer-${id}</slug>
    <title><![CDATA[Platform & Infrastructure Engineer]]></title>
    <description><![CDATA[<p>Build reliable &amp; secure systems.</p>]]></description>
    <requirements><![CDATA[<p>Operate distributed systems.</p>]]></requirements>
    <published_at>2026-09-01 09:30:00 UTC</published_at>
    <employment_type_code>fulltime_permanent</employment_type_code>${extra}</offer>`;
}

beforeEach(() => vi.resetAllMocks());
afterEach(() => vi.unstubAllGlobals());

describe("SmartRecruiters public adapter", () => {
  it("normalizes full detail, published base pay, geography and all ad sections", async () => {
    json.mockResolvedValueOnce(smartPage([smartPosting()])).mockResolvedValueOnce(smartPosting("123", {
      compensation: { min: 210000, max: 260000, currency: "USD", period: "YEARLY" },
      postingUrl: "https://attacker.invalid/posting", applyUrl: "http://127.0.0.1/apply",
    }));
    const [job] = await smartrecruitersAdapter.listJobs(company("smartrecruiters"), capturedAt);
    expect(job).toMatchObject({
      ats: "smartrecruiters", externalId: "123", locationClass: "bay-area", country: "US",
      workplaceType: "hybrid", postedAt: "2026-09-01T09:30:00Z", employmentType: "full-time",
      compensation: { min: 210000, max: 260000, currency: "USD", period: "year", source: "ats-structured" },
    });
    expect(job?.descriptionText).toContain("Employer background.");
    expect(job?.descriptionText).toContain("Operate distributed systems.");
    expect(job?.url).toBe("https://jobs.smartrecruiters.com/example/123");
    expect(job?.applyUrl).toBe("https://jobs.smartrecruiters.com/example/123?oga=true");
    for (const [, options] of json.mock.calls) expect(options?.allowedHosts).toEqual(["api.smartrecruiters.com"]);
  });

  it("pages through a short page using actual progress and preserves the query", async () => {
    json.mockResolvedValueOnce(smartPage([{ id: "1", name: "First", ref: "https://evil.invalid/detail" }], 2))
      .mockResolvedValueOnce(smartPage([{ id: "2", name: "Second" }], 2, 1))
      .mockResolvedValueOnce(smartPosting("1")).mockResolvedValueOnce(smartPosting("2"));
    expect(await smartrecruitersAdapter.listJobs(company("smartrecruiters", { query: "security & platform" }), capturedAt))
      .toHaveLength(2);
    const urls = json.mock.calls.map(([url]) => new URL(url));
    expect(urls.slice(0, 2).map((url) => url.searchParams.get("offset"))).toEqual(["0", "1"]);
    expect(urls[0]?.searchParams.get("q")).toBe("security & platform");
    expect(urls[2]?.href).toBe("https://api.smartrecruiters.com/v1/companies/example/postings/1");
  });

  it("verifies a board with one inexpensive listing request", async () => {
    json.mockResolvedValue(smartPage([{ id: "1", name: "Engineer" }], 600));
    expect(await smartrecruitersAdapter.verifyBoard!(company("smartrecruiters")))
      .toMatchObject({ ok: true, postings: 600, sampleTitles: ["Engineer"] });
    expect(json).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{}, /schema|payload/i],
    [{ content: {}, totalFound: 0 }, /schema|payload/i],
    [smartPage([{ id: "1" }]), /schema|payload/i],
    [smartPage([], 1), /pagination|progress/i],
    [smartPage([{ id: "1", name: "Engineer" }], 10001), /limit|ceiling/i],
    [smartPage([{ id: "../../bad", name: "Engineer" }]), /schema|identifier/i],
  ])("rejects malformed or incomplete listings: %j", async (payload, message) => {
    json.mockResolvedValue(payload);
    await expect(smartrecruitersAdapter.listJobs(company("smartrecruiters"), capturedAt)).rejects.toThrow(message);
  });

  it.each(["repeated", "nonadvancing", "total-changed"])("rejects %s pagination", async (mode) => {
    json.mockResolvedValueOnce(smartPage([{ id: "1", name: "First" }], 2))
      .mockResolvedValueOnce(smartPage([{ id: mode === "repeated" ? "1" : "2", name: "Next" }],
        mode === "total-changed" ? 3 : 2, mode === "nonadvancing" ? 0 : 1));
    await expect(smartrecruitersAdapter.listJobs(company("smartrecruiters"), capturedAt))
      .rejects.toThrow(/pagination|repeated|progress|changed/i);
  });

  it("returns a legitimate empty board and does not verify it as serving jobs", async () => {
    json.mockResolvedValue(smartPage([]));
    expect(await smartrecruitersAdapter.listJobs(company("smartrecruiters"), capturedAt)).toEqual([]);
    expect(await smartrecruitersAdapter.verifyBoard!(company("smartrecruiters"))).toMatchObject({ ok: false, postings: 0 });
  });

  it("excludes closed details and private listings", async () => {
    json.mockResolvedValueOnce(smartPage([
      { id: "1", name: "Closed" }, { id: "2", name: "Internal", visibility: "PRIVATE" },
    ])).mockResolvedValueOnce({ id: "1", name: "Closed", active: false });
    expect(await smartrecruitersAdapter.listJobs(company("smartrecruiters"), capturedAt)).toEqual([]);
    expect(json).toHaveBeenCalledTimes(2);
  });

  it.each(["mismatched", "missing-ad", "network"])("fails explicitly on %s details", async (mode) => {
    json.mockResolvedValueOnce(smartPage([{ id: "1", name: "Engineer" }]));
    if (mode === "network") json.mockRejectedValueOnce(new Error("detail network failure"));
    else json.mockResolvedValueOnce(mode === "mismatched" ? smartPosting("2") : { id: "1", name: "Engineer" });
    await expect(smartrecruitersAdapter.listJobs(company("smartrecruiters"), capturedAt)).rejects.toThrow();
  });

  it("preserves remote country restrictions and unknown compensation periods", async () => {
    json.mockResolvedValueOnce(smartPage([{ id: "123", name: "Engineer" }])).mockResolvedValueOnce(smartPosting("123", {
      location: { country: "de", city: "Berlin", remote: true },
      company: { location: "San Francisco, United States" },
      compensation: { min: 75000, max: 95000, currency: "EUR", period: "FORTNIGHTLY" },
      releasedDate: undefined,
    }));
    const [job] = await smartrecruitersAdapter.listJobs(company("smartrecruiters"), capturedAt);
    expect(job).toMatchObject({ locationClass: "other", country: "DE", workplaceType: "remote", postedAt: null });
    expect(job?.compensation?.period).toBe("unknown");
    expect(job?.locationsRaw.join(" ")).not.toContain("San Francisco");
  });
});

describe("Workable public adapter", () => {
  it("uses the official widget feed with full details and preserves multiple job locations", async () => {
    json.mockResolvedValue({ name: "Employer", location: "San Francisco, CA", jobs: [workablePosting({
      requirements: "<p>Systems experience.</p>", benefits: "<p>Paid leave.</p>",
      locations: [
        { country: "Canada", countryCode: "CA", city: "Toronto", region: "Ontario" },
        { country: "United States", countryCode: "US", city: "Boston", region: "Massachusetts" },
      ],
      url: "https://evil.invalid/a", application_url: "http://127.0.0.1",
    })] });
    const [job] = await workableAdapter.listJobs(company("workable"), capturedAt);
    expect(job).toMatchObject({ country: "CA", locationClass: "canada", postedAt: "2026-09-01", employmentType: "full-time" });
    expect(job?.locationsRaw).toHaveLength(2);
    expect(job?.descriptionText).toContain("Systems experience.");
    expect(job?.descriptionText).toContain("Paid leave.");
    expect(job?.url).toBe("https://apply.workable.com/j/ABC123");
    expect(job?.applyUrl).toBe("https://apply.workable.com/j/ABC123/apply");
    expect(json).toHaveBeenCalledWith("https://www.workable.com/api/accounts/example?details=true",
      expect.objectContaining({ allowedHosts: ["www.workable.com", "apply.workable.com"] }));
  });

  it("prefers explicit published base salary to a larger total compensation range", async () => {
    json.mockResolvedValue({ jobs: [workablePosting({
      description: "<p>Target total compensation is $300,000 - $400,000, including a fixed annual salary of $200,000 - $250,000, variable compensation and equity.</p>",
    })] });
    const [job] = await workableAdapter.listJobs(company("workable"), capturedAt);
    expect(job?.compensation).toMatchObject({ min: 200000, max: 250000, period: "year", source: "description-text" });
  });

  it("does not invent a salary period, posting date, or base from OTE", async () => {
    json.mockResolvedValue({ jobs: [
      workablePosting({ published_on: undefined, description: "<p>Base salary: $200,000 - $250,000.</p>" }),
      workablePosting({ shortcode: "DEF456", description: "<p>On-target earnings: $300,000 - $400,000 including commission.</p>" }),
    ] });
    const jobs = await workableAdapter.listJobs(company("workable"), capturedAt);
    expect(jobs[0]).toMatchObject({ postedAt: null, compensation: { period: "unknown" } });
    expect(jobs[1]?.compensation).toBeNull();
  });

  it.each([
    "<p>Base salary: $200,000 - $250,000 plus a $300 per month commuter allowance.</p>",
    "<p>Base salary: $200,000 - $250,000. This role has an annual review.</p>",
  ])("does not attach an unrelated pay period to the base salary range", async (description) => {
    json.mockResolvedValue({ jobs: [workablePosting({ description })] });
    expect((await workableAdapter.listJobs(company("workable"), capturedAt))[0]?.compensation?.period).toBe("unknown");
  });

  it.each([
    [{ country: "Canada", countryCode: "CA" }, "remote-canada", "CA"],
    [{ country: "United States", countryCode: "US" }, "remote-us", "US"],
    [{ country: "Singapore", countryCode: "SG" }, "other", "SG"],
  ])("keeps a telecommuting role restricted to %j", async (location, locationClass, countryCode) => {
    json.mockResolvedValue({ jobs: [workablePosting({ locations: [location], telecommuting: true })] });
    const [job] = await workableAdapter.listJobs(company("workable"), capturedAt);
    expect(job).toMatchObject({ locationClass, country: countryCode, workplaceType: "remote" });
  });

  it("supports the job's top-level location fields without using employer headquarters", async () => {
    json.mockResolvedValue({ city: "San Francisco", jobs: [workablePosting({
      locations: undefined, city: "Boston", state: "Massachusetts", country: "United States",
    })] });
    expect((await workableAdapter.listJobs(company("workable"), capturedAt))[0]?.locationClass).toBe("us-other");
  });

  it("accepts empty boards and excludes explicitly unpublished or closed jobs", async () => {
    json.mockResolvedValueOnce({ jobs: [] }).mockResolvedValueOnce({ jobs: [
      workablePosting({ state: "closed" }), workablePosting({ shortcode: "X2", published: false }),
    ] });
    expect(await workableAdapter.listJobs(company("workable"), capturedAt)).toEqual([]);
    expect(await workableAdapter.listJobs(company("workable"), capturedAt)).toEqual([]);
  });

  it("honors closed status even when the job also publishes a geographic state", async () => {
    json.mockResolvedValue({ jobs: [workablePosting({ state: "California", status: "closed" })] });
    expect(await workableAdapter.listJobs(company("workable"), capturedAt)).toEqual([]);
  });

  it.each(["hybrid", "onsite", "remote"])("preserves explicit %s workplace type with object location", async (type) => {
    json.mockResolvedValue({ jobs: [workablePosting({
      locations: undefined, location: { country: "United States", city: "Boston" }, workplace_type: type,
    })] });
    expect((await workableAdapter.listJobs(company("workable"), capturedAt))[0]?.workplaceType).toBe(type);
  });

  it("handles string location and verifies a board without additional requests", async () => {
    json.mockResolvedValue({ jobs: [workablePosting({ locations: undefined, location: "Boston, United States" })] });
    expect((await workableAdapter.listJobs(company("workable"), capturedAt))[0]?.locationClass).toBe("us-other");
    expect(await workableAdapter.verifyBoard!(company("workable"))).toMatchObject({ ok: true, postings: 1 });
    expect(json).toHaveBeenCalledTimes(2);
  });

  it.each(["Remote - Germany", "Remote - EMEA"])("does not widen a restricted text location: %s", async (location) => {
    json.mockResolvedValue({ jobs: [workablePosting({ locations: undefined, location, telecommuting: true })] });
    const [job] = await workableAdapter.listJobs(company("workable"), capturedAt);
    expect(job?.locationClass).toBe("other");
    expect(job?.locationsRaw).toEqual([location]);
  });

  it("rejects repeated shortcode identities with conflicting content", async () => {
    json.mockResolvedValue({ jobs: [workablePosting(), workablePosting({ title: "Different role" })] });
    await expect(workableAdapter.listJobs(company("workable"), capturedAt)).rejects.toThrow(/conflicting/i);
  });

  it("merges identical Workable posting variants with distinct job locations", async () => {
    const rows = [
      workablePosting({ locations: [{ city: "New York", country: "United States", countryCode: "US" }] }),
      workablePosting({ locations: [{ city: "San Francisco", country: "United States", countryCode: "US" }] }),
      workablePosting({ locations: [{ city: "London", country: "United Kingdom", countryCode: "GB" }] }),
    ];
    json.mockResolvedValue({ jobs: [...rows, rows[0]] });
    const jobs = await workableAdapter.listJobs(company("workable"), capturedAt);
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ externalId: "ABC123", locationClass: "bay-area", country: "US", postedAt: "2026-09-01" });
    expect(jobs[0]?.locationsRaw).toEqual(["New York, United States", "San Francisco, United States", "London, United Kingdom"]);
    expect(await workableAdapter.verifyBoard!(company("workable"))).toMatchObject({ ok: true, postings: 1 });
  });

  it("does not merge different salary descriptions across Workable location variants", async () => {
    json.mockResolvedValue({ jobs: [
      workablePosting({ description: "Annual base salary $200000-$300000." }),
      workablePosting({ description: "Annual base salary $100000-$150000." }),
    ] });
    await expect(workableAdapter.listJobs(company("workable"), capturedAt)).rejects.toThrow(/conflicting/i);
  });

  it.each([{}, { jobs: null }, { jobs: [{ title: "Missing shortcode" }] }, { jobs: [workablePosting({ shortcode: "../x" })] }])
    ("rejects unexpected Workable payloads: %j", async (payload) => {
      json.mockResolvedValue(payload);
      await expect(workableAdapter.listJobs(company("workable"), capturedAt)).rejects.toThrow(/schema|payload/i);
    });
});

describe("Recruitee company offers XML adapter", () => {
  it("preserves CDATA, all job locations, publication date, and published salary", async () => {
    text.mockResolvedValue(`<offers>${offer(`
      <hybrid>true</hybrid><remote>false</remote><country_code>CA</country_code>
      <salary><min>180000</min><max>230000</max><currency>CAD</currency><period>year</period></salary>
      <locations>
        <location><city>Toronto</city><state>Ontario</state><country>Canada</country><country_code>CA</country_code></location>
        <location><city>Boston</city><state>Massachusetts</state><country>United States</country><country_code>US</country_code></location>
      </locations><careers_url>https://evil.invalid/job</careers_url><apply_url>file:///private</apply_url>
    `)}</offers>`);
    const [job] = await recruiteeAdapter.listJobs(company("recruitee"), capturedAt);
    expect(job).toMatchObject({ externalId: "123", title: "Platform & Infrastructure Engineer",
      country: "CA", workplaceType: "hybrid", postedAt: "2026-09-01T09:30:00Z",
      compensation: { min: 180000, max: 230000, currency: "CAD", period: "year", source: "ats-structured" } });
    expect(job?.locationsRaw).toHaveLength(2);
    expect(job?.descriptionText).toContain("reliable & secure");
    expect(job?.descriptionText).toContain("Operate distributed systems.");
    expect(job?.url).toBe("https://example.recruitee.com/o/platform-engineer-123");
    expect(job?.applyUrl).toBe("https://example.recruitee.com/o/platform-engineer-123/c/new");
    expect(text).toHaveBeenCalledWith("https://example.recruitee.com/api/feeds/offers.xml",
      expect.objectContaining({ allowedHosts: ["example.recruitee.com"] }));
  });

  it("does not mistake remote foreign restrictions or company office metadata for worldwide work", async () => {
    text.mockResolvedValue(`<offers>${offer(`
      <remote>true</remote><location>Remote job</location><country>Singapore</country><country_code>SG</country_code>
      <city>Singapore</city><company_location>San Francisco, United States</company_location>
      <salary><min>90000</min><max>120000</max><currency>SGD</currency><period></period></salary>
    `)}</offers>`);
    expect((await recruiteeAdapter.listJobs(company("recruitee"), capturedAt))[0])
      .toMatchObject({ locationClass: "other", country: "SG", workplaceType: "remote", compensation: { period: "unknown" } });
  });

  it("accepts genuinely empty feeds and empty salary elements", async () => {
    text.mockResolvedValueOnce('<?xml version="1.0"?><offers/>')
      .mockResolvedValueOnce(`<offers>${offer("<salary><min/><max/><currency/><period/></salary>")}</offers>`);
    expect(await recruiteeAdapter.listJobs(company("recruitee"), capturedAt)).toEqual([]);
    expect((await recruiteeAdapter.listJobs(company("recruitee"), capturedAt))[0]?.compensation).toBeNull();
  });

  it("decodes predefined XML entities without treating CDATA examples as declarations", async () => {
    text.mockResolvedValue(`<offers>${offer().replace(
      "<title><![CDATA[Platform & Infrastructure Engineer]]></title>",
      "<title>Platform &amp; Infrastructure Engineer</title>",
    ).replace("Build reliable &amp; secure systems.", "Explain &lt;!DOCTYPE html&gt; and XML.")
      }</offers>`);
    expect((await recruiteeAdapter.listJobs(company("recruitee"), capturedAt))[0]?.title)
      .toBe("Platform & Infrastructure Engineer");
  });

  it("rejects undeclared XML entities outside CDATA", async () => {
    text.mockResolvedValue(`<offers>${offer("<benefits>&xxe;</benefits>")}</offers>`);
    await expect(recruiteeAdapter.listJobs(company("recruitee"), capturedAt)).rejects.toThrow(/undeclared entity/i);
  });

  it.each([
    "<salary><min>-100</min><max>200</max><currency>USD</currency></salary>",
    "<salary><min>200000</min><max>100000</max><currency>USD</currency></salary>",
    "<salary><min>100000</min><max>200000</max><currency></currency></salary>",
    `<salary><min>${"9".repeat(400)}</min><max/><currency>USD</currency></salary>`,
  ])("does not invent valid pay from malformed salary data", async (salary) => {
    text.mockResolvedValue(`<offers>${offer(salary)}</offers>`);
    expect((await recruiteeAdapter.listJobs(company("recruitee"), capturedAt))[0]?.compensation).toBeNull();
  });

  it("rejects duplicate offer identities and invalid optional field types", async () => {
    text.mockResolvedValueOnce(`<offers>${offer()}${offer()}</offers>`)
      .mockResolvedValueOnce(`<offers>${offer("<remote>yes</remote>")}</offers>`);
    await expect(recruiteeAdapter.listJobs(company("recruitee"), capturedAt)).rejects.toThrow(/repeated/i);
    await expect(recruiteeAdapter.listJobs(company("recruitee"), capturedAt)).rejects.toThrow(/schema/i);
  });

  it("filters unpublished, closed and expired postings but retains future closing dates", async () => {
    text.mockResolvedValue(`<offers>
      ${offer("<published>false</published>", "1")}${offer("<status>closed</status>", "2")}
      ${offer("<close_at>2026-09-07 00:00:00 UTC</close_at>", "3")}
      ${offer("<close_at>2026-10-01 00:00:00 UTC</close_at>", "4")}
    </offers>`);
    expect((await recruiteeAdapter.listJobs(company("recruitee"), capturedAt)).map((job) => job.externalId)).toEqual(["4"]);
  });

  it.each([
    "<html><body>Not a board</body></html>", "<jobs><job/></jobs>",
    "<offers><unexpected/></offers>", "<offers><offer><title>Incomplete</title></offer></offers>",
    "<offers><offer></offers>", "<offers/><offers/>",
    '<!DOCTYPE offers SYSTEM "https://attacker.invalid/evil.dtd"><offers/>',
    '<!DOCTYPE offers [<!ENTITY xxe SYSTEM "file:///private">]><offers>&xxe;</offers>',
    '<!ENTITY injected "bad"><offers/>',
  ])("rejects malformed XML, wrong schemas, and entity declarations: %s", async (payload) => {
    text.mockResolvedValue(payload);
    await expect(recruiteeAdapter.listJobs(company("recruitee"), capturedAt)).rejects.toThrow(/schema|XML|payload|DOCTYPE|entity/i);
    expect(text).toHaveBeenCalledTimes(1);
  });

  it("verifies only actual offers rather than a generic success page", async () => {
    text.mockResolvedValue(`<offers>${offer()}</offers>`);
    expect(await recruiteeAdapter.verifyBoard!(company("recruitee"))).toMatchObject({ ok: true, postings: 1 });
  });
});

describe("public ATS board boundaries", () => {
  for (const adapter of [smartrecruitersAdapter, workableAdapter, recruiteeAdapter]) {
    it.each(["../other", "user@host", "example.invalid/path", "https://evil.invalid", "example?x=y", "example%2fother"])
      (`rejects unsafe ${adapter.kind} board token %s before a request`, async (board) => {
        await expect(adapter.listJobs(company(adapter.kind, { board }), capturedAt)).rejects.toThrow(/board/i);
        expect(json).not.toHaveBeenCalled();
        expect(text).not.toHaveBeenCalled();
      });
    it(`does not speculate about ${adapter.kind} board slugs`, () => {
      expect(adapter.probeUrls("example")).toEqual([]);
    });
    it(`returns a public ${adapter.kind} board URL`, () => {
      expect(new URL(adapter.boardUrl(company(adapter.kind))).protocol).toBe("https:");
    });
  }
});

describe.skipIf(process.env.AUTOAPPLY_LIVE_ATS_TESTS !== "1")("opt-in public employer smoke tests", () => {
  it.each([
    [smartrecruitersAdapter, "Axiado", "Lead Systems Architect"],
    [workableAdapter, "rokt", ""],
    [recruiteeAdapter, "aikidosecurity", ""],
  ])("reads and validates live %s jobs without storing or submitting them", async (adapter, board, query) => {
    const actual = await vi.importActual<typeof import("../src/sources/http.js")>("../src/sources/http.js");
    json.mockImplementation(actual.fetchJson);
    text.mockImplementation(actual.fetchText);
    const jobs = await adapter.listJobs(company(adapter.kind, { board, query }), new Date().toISOString());
    expect(jobs.length).toBeGreaterThan(0);
    for (const job of jobs) expect(JobSchema.safeParse(job).success).toBe(true);
  }, 60_000);
});
