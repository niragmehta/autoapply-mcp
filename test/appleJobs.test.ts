import { describe, expect, it } from "vitest";
import {
  appleApplyUrl,
  appleDescriptionHtml,
  appleHydrationData,
  appleJobUrl,
  appleLocationNames,
  appleSearchUrl,
  parseAppleDetail,
  parseAppleSearch,
} from "../src/sources/appleJobs.js";

type AppleDetail = NonNullable<Parameters<typeof appleDescriptionHtml>[1]>;

const JOB_ID = "200612345-0836";
const CUPERTINO = { name: "Cupertino", stateProvince: "California", countryName: "United States" };

/**
 * A server-rendered page with its loader data embedded the way the site's
 * router does it: the JSON is stringified twice, and markup characters are
 * written as \u escapes so the payload cannot close its own script tag.
 */
function hydrationPage(loaderData: Record<string, unknown>): string {
  const literal = JSON.stringify(JSON.stringify({ loaderData, actionData: null, errors: null })).replace(
    /[<>&]/g,
    (char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`,
  );
  return [
    '<!DOCTYPE html><html lang="en-US"><body><div id="root"></div>',
    `<script>window.__staticRouterHydrationData = JSON.parse(${literal});</script>`,
    "</body></html>",
  ].join("\n");
}

const RESULT = {
  id: JOB_ID,
  postingTitle: "Software Engineer, Security",
  transformedPostingTitle: "software-engineer-security",
  locations: [CUPERTINO],
  jobSummary: "Help protect Apple platforms.",
  postDateInGMT: "2026-10-01T00:00:00.000Z",
};

const DETAIL: AppleDetail = {
  jobSummary: "Help protect Apple platforms.",
  description: "Design defenses.\nShip them.",
  minimumQualifications: "BS in Computer Science",
  preferredQualifications: "Experience with threat modeling",
  lowJobTitle: "Software Engineer - Security ICT3",
  highJobTitle: "Software Engineer - Security ICT4",
  locations: [CUPERTINO],
};

describe("Apple Jobs URLs", () => {
  it("searches with the trimmed query, relevance order, location slug and page", () => {
    expect(appleSearchUrl("united-states-USA", "  security engineer ", 2)).toBe(
      "https://jobs.apple.com/en-us/search?search=security+engineer&sort=relevance&location=united-states-USA&page=2",
    );
  });

  it("leaves out a blank query, a blank location and the first page's number", () => {
    expect(appleSearchUrl("  ", "", 1)).toBe("https://jobs.apple.com/en-us/search?sort=relevance");
  });

  it("adds the title slug to the posting URL when there is one", () => {
    expect(appleJobUrl(JOB_ID, "software-engineer-security")).toBe(
      `https://jobs.apple.com/en-us/details/${JOB_ID}/software-engineer-security`,
    );
    expect(appleJobUrl(JOB_ID, "")).toBe(`https://jobs.apple.com/en-us/details/${JOB_ID}`);
  });

  it("points at the application form for the posting", () => {
    expect(appleApplyUrl(JOB_ID)).toBe(`https://jobs.apple.com/app/en-us/apply/${JOB_ID}`);
  });
});

describe("appleHydrationData", () => {
  it("decodes the doubly encoded payload, including escaped markup and quotes", () => {
    const loaderData = { jobDetails: { jobsData: { description: 'Protect <b>Security & Privacy</b> for "everyone".' } } };

    expect(appleHydrationData(hydrationPage(loaderData))).toEqual({ loaderData, actionData: null, errors: null });
  });

  it("returns null when the page carries no hydration data", () => {
    expect(appleHydrationData("<html><body>Scheduled maintenance</body></html>")).toBeNull();
  });

  it("returns null when the payload is not valid JSON", () => {
    expect(appleHydrationData('<script>window.__staticRouterHydrationData = JSON.parse("{not json}");</script>')).toBeNull();
  });
});

describe("appleLocationNames", () => {
  it("joins each location's name, state and country", () => {
    const locations = [CUPERTINO, { name: "Austin", stateProvince: "Texas", countryName: "United States" }];

    expect(appleLocationNames(locations)).toEqual(["Cupertino, California, United States", "Austin, Texas, United States"]);
  });

  it("skips missing or non-text parts, and locations left with nothing", () => {
    const locations = [{ name: "London", countryName: "United Kingdom" }, { name: 42, stateProvince: null, countryName: "Canada" }, {}];

    expect(appleLocationNames(locations)).toEqual(["London, United Kingdom", "Canada"]);
  });

  it("returns nothing for a posting without locations", () => {
    expect(appleLocationNames(undefined)).toEqual([]);
  });
});

describe("parseAppleSearch", () => {
  it("reads the results and the total from the search loader", () => {
    const second = { ...RESULT, id: "200612346-0836", postingTitle: "Security Engineer, Cloud" };
    const page = hydrationPage({ search: { searchResults: [RESULT, second], totalRecords: 57 } });

    expect(parseAppleSearch(page)).toEqual({ results: [RESULT, second], total: 57 });
  });

  it("reports an unknown total when the loader carries no count", () => {
    expect(parseAppleSearch(hydrationPage({ search: { searchResults: [RESULT] } }))).toEqual({ results: [RESULT], total: null });
  });

  it("returns no results for a malformed results list", () => {
    const page = hydrationPage({ search: { searchResults: "none", totalRecords: "57" } });

    expect(parseAppleSearch(page)).toEqual({ results: [], total: null });
  });

  it("returns no results when the page has no search loader or no hydration data", () => {
    expect(parseAppleSearch(hydrationPage({ jobDetails: { jobsData: DETAIL } }))).toEqual({ results: [], total: null });
    expect(parseAppleSearch("<html><body>Scheduled maintenance</body></html>")).toEqual({ results: [], total: null });
  });
});

describe("parseAppleDetail", () => {
  it("reads the posting data from the job details loader", () => {
    expect(parseAppleDetail(hydrationPage({ jobDetails: { jobsData: DETAIL } }))).toEqual(DETAIL);
  });

  it("returns null when the page carries no posting data", () => {
    // A withdrawn posting still renders, with an empty job details loader.
    expect(parseAppleDetail(hydrationPage({ jobDetails: { jobsData: null } }))).toBeNull();
    expect(parseAppleDetail(hydrationPage({ search: { searchResults: [] } }))).toBeNull();
    expect(parseAppleDetail("<html><body>Not found</body></html>")).toBeNull();
  });
});

describe("appleDescriptionHtml", () => {
  it("states the level range first, then each section under its own heading", () => {
    expect(appleDescriptionHtml("Search summary.", DETAIL)).toBe(
      [
        "<p>Apple job level: Software Engineer - Security ICT3 to Software Engineer - Security ICT4</p>",
        "<h3>Summary</h3><p>Help protect Apple platforms.</p>",
        "<h3>Description</h3><p>Design defenses.<br>Ship them.</p>",
        "<h3>Minimum qualifications</h3><p>BS in Computer Science</p>",
        "<h3>Preferred qualifications</h3><p>Experience with threat modeling</p>",
      ].join("\n"),
    );
  });

  it.each<{ variant: string; detail: AppleDetail }>([
    { variant: "the same title at both ends", detail: { ...DETAIL, highJobTitle: " Software Engineer - Security ICT3 " } },
    { variant: "only the low end", detail: { ...DETAIL, highJobTitle: undefined } },
  ])("states a single level once when the range has $variant", ({ detail }) => {
    expect(appleDescriptionHtml("", detail)).toContain("<p>Apple job level: Software Engineer - Security ICT3</p>");
  });

  it("falls back to the search summary when the posting page gave none", () => {
    // The posting page failed to load, or loaded without its own summary.
    for (const detail of [null, { description: "Design defenses." }]) {
      const html = appleDescriptionHtml("Help protect Apple platforms.", detail);

      expect(html).toContain("<h3>Summary</h3><p>Help protect Apple platforms.</p>");
      expect(html).not.toContain("Apple job level");
    }
  });

  it("omits sections the posting leaves blank", () => {
    const html = appleDescriptionHtml("", { jobSummary: "Help protect Apple platforms.", description: "   ", minimumQualifications: "" });

    expect(html).toContain("<h3>Summary</h3>");
    expect(html).not.toContain("<h3>Description</h3>");
    expect(html).not.toContain("<h3>Minimum qualifications</h3>");
  });
});
