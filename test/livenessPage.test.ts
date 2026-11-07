import { describe, expect, it } from "vitest";
import { classifyPostingPage, pageMentionsTitle } from "../src/hygiene/livenessPage.js";
import { extractJobPostings } from "../src/hygiene/jsonLd.js";

const url = "https://careers.example.com/jobs/12345-senior-security-engineer";
const title = "Senior Security Engineer";

function page(body: string, overrides: Partial<Parameters<typeof classifyPostingPage>[0]> = {}) {
  return classifyPostingPage({ status: 200, requestedUrl: url, finalUrl: url, body, title, ...overrides });
}

const filler = "We build secure infrastructure for payments. ".repeat(12);

describe("classifyPostingPage", () => {
  it("reads 404 and 410 as closed", () => {
    expect(page("", { status: 404 }).status).toBe("closed");
    expect(page("", { status: 410 }).status).toBe("closed");
  });

  it("never reads a refused or failing request as closed", () => {
    for (const status of [401, 403, 429, 451, 500, 503]) {
      expect(page("Too Many Requests", { status }).status).toBe("unknown");
    }
  });

  it("reads Greenhouse's error redirect to the board index as closed", () => {
    const result = page("<html>Open roles at Acme</html>", {
      requestedUrl: "https://job-boards.greenhouse.io/acme/jobs/4001",
      finalUrl: "https://job-boards.greenhouse.io/acme?error=true",
    });
    expect(result).toMatchObject({ status: "closed", via: "page" });
  });

  it("reads a redirect to the board's own index as closed", () => {
    const result = page("<html>Careers</html>", {
      requestedUrl: "https://jobs.example.com/acme/jobs/987654",
      finalUrl: "https://jobs.example.com/acme",
    });
    expect(result.status).toBe("closed");
    const board = page("<html>Careers</html>", {
      requestedUrl: "https://apply.example.com/posting/abc",
      finalUrl: "https://apply.example.com/acme-careers",
      boardUrl: "https://apply.example.com/acme-careers",
    });
    expect(board.status).toBe("closed");
  });

  it("does not call an unrelated redirect closed", () => {
    const result = page(`<html><body>${filler}</body></html>`, {
      requestedUrl: "https://jobs.example.com/acme/jobs/987654",
      finalUrl: "https://www.example.com/careers/home",
    });
    expect(result.status).toBe("unknown");
  });

  it("reads closure banners as closed", () => {
    for (const banner of [
      "This job is no longer available.",
      "We are no longer accepting applications for this role.",
      "Sorry, this position has been filled.",
      "This job posting has expired",
      "Job not found",
      "The page you are looking for doesn't exist",
    ]) {
      expect(page(`<html><body><h1>${banner}</h1>${filler}</body></html>`).status).toBe("closed");
    }
  });

  it("ignores closure wording inside a condition", () => {
    const body = `<h1>${title}</h1><p>Applications will be accepted until the position has been filled.</p>${filler}<a href="/apply">Apply now</a>`;
    expect(page(body).status).toBe("open");
  });

  it("does not read prose such as closed-loop as a closure", () => {
    const body = `<h1>${title}</h1><p>This role is closed-loop control of our platform.</p>${filler}`;
    expect(page(body).status).toBe("unknown");
  });

  it("reads an anti-bot wall as unknown, never closed", () => {
    expect(page("<title>Just a moment...</title> Checking your browser before accessing.").status).toBe("unknown");
  });

  it("reads the posting's JSON-LD as open", () => {
    const body = `<script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@type": "JobPosting", title })}</script>`;
    expect(page(body).status).toBe("open");
  });

  it("reads the title plus an apply control as open", () => {
    const body = `<h1>${title}</h1>${filler}<button class="btn">Apply for this job</button>`;
    expect(page(body)).toMatchObject({ status: "open", via: "page" });
  });

  it("leaves a client-rendered shell unknown", () => {
    expect(page('<html><div id="root"></div><script src="app.js"></script></html>').status).toBe("unknown");
  });

  it("reads a search page that lost the posting id as closed", () => {
    const result = page("<html><p>125 jobs found</p><a>Apply</a></html>", {
      requestedUrl: "https://careers.example.com/job/55555",
      finalUrl: "https://careers.example.com/search?q=",
    });
    expect(result.status).toBe("closed");
  });
});

describe("pageMentionsTitle", () => {
  it("needs every meaningful title word", () => {
    expect(pageMentionsTitle("Senior Security Engineer - Remote", "Senior Security Engineer (Remote)")).toBe(true);
    expect(pageMentionsTitle("Security Engineer", "Senior Security Engineer")).toBe(false);
  });
});

describe("extractJobPostings", () => {
  it("reads nested graphs, salaries and locations defensively", () => {
    const html = `
      <script type="application/ld+json">{ not json }</script>
      <script type="application/ld+json">${JSON.stringify({
        "@graph": [
          { "@type": "Organization", name: "Acme" },
          {
            "@type": "JobPosting",
            title: "Platform Engineer &amp; SRE",
            description: "<p>Build things</p>",
            hiringOrganization: { "@type": "Organization", name: "Acme Corp" },
            jobLocation: [{ "@type": "Place", address: { addressLocality: "Denver", addressRegion: "CO", addressCountry: "US" } }],
            datePosted: "2026-10-01",
            employmentType: ["FULL_TIME"],
            identifier: { "@type": "PropertyValue", value: "REQ-9" },
            baseSalary: { "@type": "MonetaryAmount", currency: "USD", value: { minValue: 150000, maxValue: 190000, unitText: "YEAR" } },
          },
        ],
      })}</script>`;
    const [posting] = extractJobPostings(html);
    expect(posting).toMatchObject({
      title: "Platform Engineer & SRE",
      hiringOrganization: "Acme Corp",
      locations: ["Denver, CO, US"],
      countries: ["US"],
      datePosted: "2026-10-01",
      employmentType: "FULL_TIME",
      identifier: "REQ-9",
      salary: { min: 150000, max: 190000, currency: "USD", unit: "YEAR" },
    });
  });

  it("marks telecommute postings remote with their applicant region", () => {
    const html = `<script type="application/ld+json">${JSON.stringify({
      "@type": "JobPosting",
      title: "Engineer",
      jobLocationType: "TELECOMMUTE",
      applicantLocationRequirements: { "@type": "Country", name: "United States" },
    })}</script>`;
    expect(extractJobPostings(html)[0]).toMatchObject({ remote: true, locations: ["Remote - United States"] });
  });
});
