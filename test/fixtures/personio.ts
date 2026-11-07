import { jobPostingLd } from "./smbHttp.js";

/**
 * Trimmed from live Personio /xml, /search.json and posting pages (Nov 2026).
 * Names, ids and text are placeholders.
 */

export function personioPosition(id = "2784397", extra = "", descriptions = ""): string {
  return `<position>
    <id>${id}</id>
    <office>Toronto</office>
    <department>Engineering</department>
    <recruitingCategory>Platform</recruitingCategory>
    <name>Platform &amp; Reliability Engineer</name>
    <jobDescriptions>${descriptions}</jobDescriptions>
    <employmentType>permanent</employmentType>
    <seniority>experienced</seniority>
    <schedule>full-time</schedule>
    <keywords>platform,reliability</keywords>
    <createdAt>2026-09-07T11:44:15+00:00</createdAt>
    <salaryInformation>
        <min>120000.00</min>
        <max>140000.00</max>
        <currencySymbol>$</currencySymbol>
        <currencyCode>CAD</currencyCode>
        <type>yearly</type>
    </salaryInformation>${extra}
</position>`;
}

export function personioXml(positions: string[]): string {
  return `<?xml version="1.0" encoding="UTF-8"?>\n<workzag-jobs>\n${positions.join("\n")}\n</workzag-jobs>`;
}

export function personioSearch(overrides: Record<string, unknown> = {}) {
  return {
    id: 602632, name: "Partner Manager (m/f/x)", employment_type: "Permanent employee", seniority: "Experienced",
    keywords: "", description: "", office: "Berlin", offices: ["Berlin"], schedule: "Full-time",
    category: "Sales", department: "Sales", subcompany: "", ...overrides,
  };
}

export function personioPage(overrides: Record<string, unknown> = {}): string {
  return jobPostingLd({
    title: "Platform & Reliability Engineer",
    description: "<h1>About Example Co</h1><p>Run our platform.</p>",
    identifier: { "@type": "PropertyValue", name: "Example Co", value: "2784397-416" },
    jobLocation: { "@type": "Place", address: { "@type": "PostalAddress", addressLocality: "Toronto", addressRegion: "Ontario", addressCountry: "CA" } },
    datePosted: "2026-09-08",
    employmentType: ["FULL_TIME"],
    ...overrides,
  });
}
