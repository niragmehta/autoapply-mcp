import { describe, expect, it } from "vitest";
import {
  googleJobUrl,
  googleSearchUrl,
  parseGoogleBoard,
  parseGooglePay,
  parseGoogleResults,
} from "../src/sources/googleCareers.js";

/**
 * Google's results page carries every posting as positional arrays inside an
 * `AF_initDataCallback` block keyed `ds:1`. These fixtures rebuild that shape
 * synthetically, so a shifted index fails here instead of producing blank
 * postings in a live run.
 */

const RESULTS = "https://www.google.com/about/careers/applications/jobs/results/";
const JOB_ID = "123456789012345678";
const APPLY_URL = `https://www.google.com/about/careers/applications/signin?jobId=${JOB_ID}`;

function errorFrom(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw");
}

/** One `ds:1` posting, with values at the positions the parser reads. */
function entry(overrides: Record<number, unknown> = {}): unknown[] {
  const fields: unknown[] = new Array(13).fill(null);
  fields[0] = JOB_ID;
  fields[1] = "  Senior Security Engineer, Cloud  ";
  fields[2] = APPLY_URL;
  fields[3] = [null, "<ul><li>Lead threat modeling for new services.</li></ul>"];
  fields[4] = [null, "<h3>Minimum qualifications:</h3><ul><li>5 years of security engineering.</li></ul>"];
  fields[7] = "Google";
  fields[9] = [["Sunnyvale, CA, USA"], ["New York, NY, USA"]];
  fields[10] = [null, "<p>Help secure Google Cloud.</p>"];
  fields[12] = [1767225600, 0]; // 2026-01-01T00:00:00Z in epoch seconds
  for (const [index, value] of Object.entries(overrides)) fields[Number(index)] = value;
  return fields;
}

/**
 * A results page with the given `ds:1` payload. A `ds:0` block holding a
 * posting-shaped decoy comes first, as other callback blocks do on the real
 * page, so reading the wrong block shows up as an unexpected posting.
 */
function resultsPage(data: unknown): string {
  return [
    "<!doctype html><html><body>",
    `<script nonce="n0">AF_initDataCallback({key: 'ds:0', hash: '1', data:[[["999", "Decoy posting"]], null, 1], sideChannel: {}});</script>`,
    `<script nonce="n1">AF_initDataCallback({key: 'ds:1', hash: '2', data:${JSON.stringify(data)}, sideChannel: {}});</script>`,
    "</body></html>",
  ].join("\n");
}

describe("parseGoogleBoard", () => {
  it("reads a location and Google's level filters, upper-casing the levels", () => {
    expect(parseGoogleBoard("United States;mid, Advanced")).toEqual({ location: "United States", levels: ["MID", "ADVANCED"] });
  });

  it("searches every level when the board names only a location", () => {
    expect(parseGoogleBoard("Canada")).toEqual({ location: "Canada", levels: [] });
  });

  it("trims whitespace and drops blank level entries", () => {
    // Hand-edited company files pick up stray spaces and trailing commas.
    expect(parseGoogleBoard("  United States ; MID,, EARLY , ")).toEqual({ location: "United States", levels: ["MID", "EARLY"] });
  });

  it.each(["", "   ", ";MID,ADVANCED"])("rejects a board without a location: %j", (board) => {
    expect(errorFrom(() => parseGoogleBoard(board))).toMatchObject({ code: "invalid_board" });
  });
});

describe("googleSearchUrl", () => {
  it("sends the location, one target_level per level, the trimmed query and the page", () => {
    const url = googleSearchUrl({ location: "United States", levels: ["MID", "ADVANCED"] }, "  security engineer ", 3);

    expect(url).toBe(`${RESULTS}?location=United+States&target_level=MID&target_level=ADVANCED&q=security+engineer&page=3`);
  });

  it("leaves out a blank query and the first page's number", () => {
    expect(googleSearchUrl({ location: "Canada", levels: [] }, "   ", 1)).toBe(`${RESULTS}?location=Canada`);
  });

  it("keeps punctuation in the query inside the q parameter", () => {
    // "C++ & Rust" must not split into a second parameter at the ampersand.
    const url = new URL(googleSearchUrl(parseGoogleBoard("United States;MID"), "C++ & Rust", 1));

    expect(url.searchParams.get("q")).toBe("C++ & Rust");
    expect([...url.searchParams.keys()]).toEqual(["location", "target_level", "q"]);
  });
});

describe("googleJobUrl", () => {
  it("appends the posting id to the results path", () => {
    expect(googleJobUrl(JOB_ID)).toBe(`${RESULTS}${JOB_ID}`);
  });

  it("keeps an id with reserved characters inside one path segment", () => {
    expect(googleJobUrl("12/34 x")).toBe(`${RESULTS}12%2F34%20x`);
  });
});

describe("parseGoogleResults", () => {
  it("reads every posting field and the total hit count from ds:1", () => {
    const { postings, total } = parseGoogleResults(resultsPage([[entry()], null, 42]));

    expect(total).toBe(42);
    expect(postings).toEqual([
      {
        id: JOB_ID,
        title: "Senior Security Engineer, Cloud",
        applyUrl: APPLY_URL,
        company: "Google",
        locations: ["Sunnyvale, CA, USA", "New York, NY, USA"],
        descriptionHtml: [
          "<p>Help secure Google Cloud.</p>",
          "<h3>Responsibilities:</h3><ul><li>Lead threat modeling for new services.</li></ul>",
          "<h3>Minimum qualifications:</h3><ul><li>5 years of security engineering.</li></ul>",
        ].join("\n"),
        postedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
  });

  it("falls back to the posting page and to Google when the entry omits apply link and company", () => {
    const [posting] = parseGoogleResults(resultsPage([[entry({ 2: null, 7: null })]])).postings;

    expect(posting?.applyUrl).toBe(googleJobUrl(JOB_ID));
    expect(posting?.company).toBe("Google");
  });

  it("keeps the hiring company the entry names", () => {
    // Subsidiaries such as YouTube post through the same search.
    const [posting] = parseGoogleResults(resultsPage([[entry({ 7: "YouTube" })]])).postings;

    expect(posting?.company).toBe("YouTube");
  });

  it("builds the description from whichever sections the entry carries", () => {
    const [posting] = parseGoogleResults(resultsPage([[entry({ 3: null, 10: null })]])).postings;

    expect(posting?.descriptionHtml).toBe("<h3>Minimum qualifications:</h3><ul><li>5 years of security engineering.</li></ul>");
  });

  it("leaves locations, description and posting date empty when the entry has none", () => {
    const [posting] = parseGoogleResults(resultsPage([[entry({ 3: null, 4: null, 9: null, 10: null, 12: null })]])).postings;

    expect(posting).toMatchObject({ locations: [], descriptionHtml: "", postedAt: null });
  });

  it("drops location rows that carry no place name", () => {
    const [posting] = parseGoogleResults(resultsPage([[entry({ 9: [["Austin, TX, USA"], [null], "Remote", []] })]])).postings;

    expect(posting?.locations).toEqual(["Austin, TX, USA"]);
  });

  it("skips malformed entries instead of failing the whole page", () => {
    const data = [
      [entry(), [null, "No id"], ["no-title"], "not-an-entry", null, entry({ 0: "222", 1: "Staff Security Engineer" })],
      null,
      2,
    ];

    const { postings } = parseGoogleResults(resultsPage(data));

    expect(postings.map((posting) => [posting.id, posting.title])).toEqual([
      [JOB_ID, "Senior Security Engineer, Cloud"],
      ["222", "Staff Security Engineer"],
    ]);
  });

  it("reports an unknown total when ds:1 carries no count", () => {
    expect(parseGoogleResults(resultsPage([[entry()]])).total).toBeNull();
  });

  it("returns no postings when the page has no ds:1 block, even beside other callback blocks", () => {
    // An interstitial or error page has callback blocks but no results list.
    const page = resultsPage([[entry()], null, 1]).replace("key: 'ds:1'", "key: 'ds:2'");

    expect(parseGoogleResults(page)).toEqual({ postings: [], total: null });
  });

  it("returns no postings when the ds:1 payload is not valid JSON", () => {
    const page = `<script>AF_initDataCallback({key: 'ds:1', hash: '2', data:[[["${JOB_ID}", "Security Engineer"]], null, 3, sideChannel: {}});</script>`;

    expect(parseGoogleResults(page)).toEqual({ postings: [], total: null });
  });

  it.each([[null, null, 0], { jobs: [] }])("returns no postings when ds:1 holds no results list: %j", (data) => {
    expect(parseGoogleResults(resultsPage(data))).toEqual({ postings: [], total: null });
  });
});

describe("parseGooglePay", () => {
  it("reads the US range Google prints without thousands separators", () => {
    expect(parseGooglePay('<div class="pay"><span>US: $174000 - $252000 (USD)</span></div>')).toEqual({
      min: 174000,
      max: 252000,
      currency: "USD",
      period: "year",
      source: "description-text",
      raw: "US: $174000 - $252000 (USD)",
    });
  });

  it("accepts thousands separators and tight spacing", () => {
    expect(parseGooglePay("US:$166,000-$244,000(USD)")).toMatchObject({ min: 166000, max: 244000, currency: "USD" });
  });

  it("returns null when the page states no US range", () => {
    expect(parseGooglePay("<p>Compensation varies by location.</p>")).toBeNull();
  });

  it("leaves the prose salary sentence to the generic description parser", () => {
    // Only the "US: $X - $Y (USD)" line is read here.
    const prose = "The US base salary range for this full-time position is $166,000-$244,000 + bonus + equity + benefits.";

    expect(parseGooglePay(prose)).toBeNull();
  });

  it.each(["US: $252000 - $174000 (USD)", "US: $0 - $100000 (USD)"])("rejects an implausible range: %s", (html) => {
    expect(parseGooglePay(html)).toBeNull();
  });
});
