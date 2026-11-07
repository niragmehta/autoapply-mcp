import { jobPostingLd } from "./smbHttp.js";

/**
 * Trimmed from a live Breezy /json feed and posting page (Nov 2026).
 * Names, ids and text are placeholders.
 */

export function breezyPosition(overrides: Record<string, unknown> = {}) {
  const location = {
    id: "e6440d9756fc", country: { name: "United States", id: "US" }, state: { id: "TX", name: "Texas" },
    city: "Dallas", primary: true, is_remote: false, name: "Dallas, TX",
  };
  return {
    id: "016614959b60",
    friendly_id: "016614959b60-platform-engineer",
    name: "Platform Engineer",
    url: "https://acme.breezy.hr/p/016614959b60-platform-engineer",
    published_date: "2026-11-05T20:16:02.931Z",
    type: { id: "fullTime", name: "Full-Time" },
    location,
    department: "Engineering",
    salary: "$80,000 – $102,000 / year",
    company: { name: "Example Co", friendly_id: "acme" },
    locations: [location],
    ...overrides,
  };
}

export function breezyPage(overrides: Record<string, unknown> = {}): string {
  return jobPostingLd({
    url: "https://acme.breezy.hr/p/016614959b60-platform-engineer?source=GoogleJobs",
    title: "Platform Engineer",
    description: "<h2>About Example Co</h2><p>Operate dependable infrastructure.</p>",
    employmentType: "FULL_TIME",
    datePosted: "2026-07-17",
    jobLocation: { "@type": "Place", address: { "@type": "PostalAddress", addressCountry: "US", addressRegion: "TX", addressLocality: "Dallas" } },
    baseSalary: { "@type": "MonetaryAmount", currency: "USD", value: { "@type": "QuantitativeValue", unitText: "YEAR", minValue: 80000, maxValue: 102000 } },
    ...overrides,
  });
}
