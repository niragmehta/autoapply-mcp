import { describe, expect, it } from "vitest";
import {
  metaApplyUrl,
  metaJobUrl,
  metaSearchPageUrl,
  parseLsdToken,
  parseMetaPostingPage,
  parseMetaSearchResponse,
} from "../src/sources/metaCareers.js";

const JOB_ID = "1234567890123456";

function errorFrom(fn: () => unknown): unknown {
  try {
    fn();
  } catch (error) {
    return error;
  }
  throw new Error("expected the call to throw");
}

/** A GraphQL search response in the shape the persisted query returns. */
function searchResponse(jobs: unknown[]): string {
  return JSON.stringify({
    data: { job_search_with_featured_jobs_v2: { featured_jobs: [], all_jobs: jobs } },
    extensions: { is_final: true },
  });
}

/** A posting page carrying one schema.org JobPosting block. */
function postingPage(ld: Record<string, unknown>): string {
  return [
    "<!DOCTYPE html><html><head><title>Security Engineer | Meta Careers</title>",
    `<script type="application/ld+json" nonce="n0">${JSON.stringify(ld)}</script>`,
    '</head><body><div id="root"></div></body></html>',
  ].join("\n");
}

describe("Meta Careers URLs", () => {
  it("builds the posting and application form URLs from a job id", () => {
    expect(metaJobUrl(JOB_ID)).toBe(`https://www.metacareers.com/jobs/${JOB_ID}/`);
    expect(metaApplyUrl(JOB_ID)).toBe(`https://www.metacareers.com/profile/create_application/${JOB_ID}/`);
  });

  it("keeps an id with reserved characters inside one path segment", () => {
    expect(metaJobUrl("12/34")).toBe("https://www.metacareers.com/jobs/12%2F34/");
    expect(metaApplyUrl("12/34")).toBe("https://www.metacareers.com/profile/create_application/12%2F34/");
  });

  it("puts the trimmed, encoded query on the search page URL", () => {
    expect(metaSearchPageUrl("  security engineer ")).toBe("https://www.metacareers.com/jobsearch/?q=security%20engineer");
    // "C++ & Rust" must survive as one q value rather than splitting at the ampersand.
    expect(new URL(metaSearchPageUrl("C++ & Rust")).searchParams.get("q")).toBe("C++ & Rust");
  });
});

describe("parseLsdToken", () => {
  it("reads the token from the page's server-side config", () => {
    const page =
      '<script>requireLazy(["ServerJS"],function(s){s.handle({"define":[["LSD",[],{"token":"AVqSyntheticLsd1"},323]]});});</script>';

    expect(parseLsdToken(page)).toBe("AVqSyntheticLsd1");
  });

  it("falls back to the hidden lsd form field", () => {
    const page = '<form><input type="hidden" name="lsd" value="AVrSyntheticLsd2" autocomplete="off" /></form>';

    expect(parseLsdToken(page)).toBe("AVrSyntheticLsd2");
  });

  it("prefers the config token when both are present", () => {
    const page = '<input type="hidden" name="lsd" value="FromForm" /><script>["LSD",[],{"token":"FromConfig"},323]</script>';

    expect(parseLsdToken(page)).toBe("FromConfig");
  });

  it("returns null when the page carries no usable token", () => {
    // A login wall or throttling page arrives in place of the search page.
    expect(parseLsdToken("<html><body>Something went wrong</body></html>")).toBeNull();
    expect(parseLsdToken('<script>["LSD",[],{"token":""},323]</script>')).toBeNull();
  });
});

describe("parseMetaSearchResponse", () => {
  it("reads id, title, locations and teams for every match", () => {
    const text = searchResponse([
      {
        id: JOB_ID,
        title: " Security Engineer, Product Security ",
        locations: ["Menlo Park, CA", "Seattle, WA"],
        teams: ["Security"],
        sub_teams: ["Product Security"],
      },
      { id: "2222", title: "Software Engineer, Privacy", locations: ["Remote, US"], teams: ["Software Engineering"] },
    ]);

    expect(parseMetaSearchResponse(text)).toEqual([
      { id: JOB_ID, title: "Security Engineer, Product Security", locations: ["Menlo Park, CA", "Seattle, WA"], teams: ["Security"] },
      { id: "2222", title: "Software Engineer, Privacy", locations: ["Remote, US"], teams: ["Software Engineering"] },
    ]);
  });

  it("reads the first document when the endpoint streams several", () => {
    const text = [
      "",
      searchResponse([{ id: JOB_ID, title: "Security Engineer" }]),
      JSON.stringify({ label: "deferred", path: ["job_search_with_featured_jobs_v2"], data: {} }),
      JSON.stringify({ extensions: { is_final: true } }),
    ].join("\n");

    expect(parseMetaSearchResponse(text)).toEqual([{ id: JOB_ID, title: "Security Engineer", locations: [], teams: [] }]);
  });

  it("skips a list item GraphQL could not resolve", () => {
    const text = JSON.stringify({ data: { job_search_with_featured_jobs_v2: { all_jobs: [null, { id: "1", title: "A" }] } } });

    expect(parseMetaSearchResponse(text)).toEqual([{ id: "1", title: "A", locations: [], teams: [] }]);
  });

  it("drops matches without an id or title and keeps only string locations and teams", () => {
    const text = searchResponse([
      { id: "1111", title: "   " },
      { title: "No id" },
      { id: JOB_ID, title: "Security Engineer", locations: ["Remote, US", 7, null], teams: "Security" },
    ]);

    expect(parseMetaSearchResponse(text)).toEqual([{ id: JOB_ID, title: "Security Engineer", locations: ["Remote, US"], teams: [] }]);
  });

  it("returns an empty list when the search matched nothing", () => {
    expect(parseMetaSearchResponse(searchResponse([]))).toEqual([]);
  });

  it("fails loudly, naming the setting, when a rotated query id returns errors instead of results", () => {
    const text = JSON.stringify({
      errors: [{ message: "PersistedQueryNotFound", severity: "CRITICAL" }, { message: "Query document not found" }],
    });

    const error = errorFrom(() => parseMetaSearchResponse(text));

    expect(error).toMatchObject({ code: "source_format" });
    expect((error as Error).message).toContain("(PersistedQueryNotFound; Query document not found)");
    expect((error as Error).message).toContain("AUTOAPPLY_META_SEARCH_DOC_ID");
  });

  it("fails loudly when the response has no results list and no error message", () => {
    const error = errorFrom(() => parseMetaSearchResponse(JSON.stringify({ data: { job_search_with_featured_jobs_v2: null } })));

    expect(error).toMatchObject({ code: "source_format" });
    expect((error as Error).message).toMatch(/^Meta search returned no results list; /);
  });

  it("fails loudly when the response is not JSON", () => {
    // A blocked or throttled request comes back as an HTML error page.
    const error = errorFrom(() => parseMetaSearchResponse("<!DOCTYPE html><html><body>Sorry, something went wrong.</body></html>"));

    expect(error).toMatchObject({ code: "source_format" });
    expect((error as Error).message).toBe("Meta search returned something other than JSON");
  });
});

describe("parseMetaPostingPage", () => {
  it("builds the description from the JobPosting's description, responsibilities and qualifications", () => {
    const page = postingPage({
      "@context": "https://schema.org/",
      "@type": "JobPosting",
      title: "Security Engineer",
      description: "Protect the people who use our apps.\nWork across product teams.",
      responsibilities: "Threat model new products",
      qualifications: "5+ years of security engineering experience",
      datePosted: "2026-10-01T09:00:00-07:00",
      jobLocation: [
        { "@type": "Place", name: "Menlo Park, CA" },
        { "@type": "Place", name: "New York, NY" },
      ],
    });

    expect(parseMetaPostingPage(page)).toEqual({
      descriptionHtml: [
        "<h3>About the role</h3><p>Protect the people who use our apps.<br>Work across product teams.</p>",
        "<h3>Responsibilities</h3><p>Threat model new products</p>",
        "<h3>Qualifications</h3><p>5+ years of security engineering experience</p>",
      ].join("\n"),
      postedAt: "2026-10-01T09:00:00-07:00",
      locations: ["Menlo Park, CA", "New York, NY"],
    });
  });

  it("omits missing sections and leaves the date and locations empty", () => {
    const detail = parseMetaPostingPage(postingPage({ "@type": "JobPosting", description: "Only a summary.", responsibilities: "  " }));

    expect(detail?.descriptionHtml).toContain("<h3>About the role</h3><p>Only a summary.</p>");
    expect(detail?.descriptionHtml).not.toContain("Responsibilities");
    expect(detail?.descriptionHtml).not.toContain("Qualifications");
    expect(detail?.postedAt).toBeNull();
    expect(detail?.locations).toEqual([]);
  });

  it("keeps only the places that carry a name", () => {
    const page = postingPage({
      "@type": "JobPosting",
      jobLocation: [{ "@type": "Place", address: { addressCountry: "US" } }, { "@type": "Place", name: "Remote, US" }],
    });

    expect(parseMetaPostingPage(page)?.locations).toEqual(["Remote, US"]);
  });

  it("returns null when the page has no JSON-LD block", () => {
    // A removed posting renders the "no longer available" shell without one.
    expect(parseMetaPostingPage("<html><body>This job is no longer available.</body></html>")).toBeNull();
  });

  it("returns null when the JSON-LD block is malformed", () => {
    expect(parseMetaPostingPage('<script type="application/ld+json">{"@type": "JobPosting", "description": </script>')).toBeNull();
  });
});
