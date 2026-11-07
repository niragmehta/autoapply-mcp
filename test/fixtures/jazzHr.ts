import { jobPostingLd } from "./smbHttp.js";

/**
 * Trimmed from a live ApplyToJob board page and posting page (Nov 2026).
 * Markup structure is preserved; names and text are placeholders.
 */

export function jazzCard(id: string, title: string, location = "Remote", department = ""): string {
  return `<li class="list-group-item">
    <h3 class='list-group-item-heading'>
      <a href="https://acme.applytojob.com/apply/${id}/${title.replace(/\W+/g, "-")}">
        ${title}      </a>
    </h3>
    <ul class='list-inline list-group-item-text'>
      <li><i class='fa fa-map-marker'></i>${location}</li>
      ${department ? `<li><i class='fa fa-sitemap'></i>${department}</li>` : ""}
    </ul>
  </li>`;
}

export function jazzBoard(cards: string[]): string {
  return `<!DOCTYPE html><html><head><title>Example Co - Career Page</title>
  <script>var DV_WEBSITE_URL_HTTPS = "https://acme.applytojob.com";</script></head><body>
  <div class="job-board-list"><a href="https://acme.applytojob.com/apply">All jobs</a>
  <ul class="jobs-list">${cards.join("\n")}</ul></div>
  <a href="https://info.jazzhr.com/job-seekers.html" id="resumator-logo">Powered by JazzHR</a></body></html>`;
}

export function jazzPosting(overrides: Record<string, unknown> = {}): string {
  return jobPostingLd({
    url: "https://acme.applytojob.com/apply/gdWcbFq2mr/Platform-Engineer",
    title: "Platform Engineer",
    description: "Own our CI&#160;platform.<br><strong>Salary Range</strong><br>$140k-$170k",
    datePosted: "2026-10-07",
    validThrough: "2027-01-05",
    employmentType: "FULL_TIME",
    hiringOrganization: { "@type": "Organization", name: "Example Co" },
    jobLocation: { "@type": "Place", address: { "@type": "PostalAddress", addressLocality: "Austin", addressRegion: "TX", addressCountry: "US" } },
    baseSalary: { "@type": "MonetaryAmount", currency: "USD", value: { "@type": "QuantitativeValue", unitText: "YEAR", minValue: 140000, maxValue: 170000 } },
    jobLocationType: "TELECOMMUTE",
    applicantLocationRequirements: { "@type": "Country", name: "US" },
    ...overrides,
  });
}
