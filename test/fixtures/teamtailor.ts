/**
 * Trimmed from a live Teamtailor jobs.json feed (JSON Feed 1.1 with
 * `_jobposting`, Nov 2026). Names, ids and text are placeholders.
 */

export function teamtailorItem(overrides: Record<string, unknown> = {}, posting: Record<string, unknown> = {}) {
  return {
    id: "c44a3279-d46a-4b7e-9167-d42dcb356763",
    title: "Platform Engineer",
    url: "https://acme.teamtailor.com/jobs/8483649-platform-engineer",
    date_published: "2026-10-01T10:01:45+02:00",
    content_html: "<p><strong>About us:</strong> Example Co builds document tools.</p>",
    _jobposting: {
      "@context": "http://schema.org/",
      "@type": "JobPosting",
      title: "Platform Engineer",
      description: "<p>About us</p>",
      identifier: { "@type": "PropertyValue", name: "Example Co", value: "8483649" },
      datePosted: "2026-10-01T10:01:45+02:00",
      employmentType: "FULL_TIME",
      directApply: true,
      hiringOrganization: { "@type": "Organization", name: "Example Co" },
      jobLocation: [{ "@type": "Place", address: { "@type": "PostalAddress", addressLocality: "Toronto", addressRegion: "Ontario", addressCountry: "CA" } }],
      ...posting,
    },
    ...overrides,
  };
}

export function teamtailorFeed(items: unknown[], extra: Record<string, unknown> = {}) {
  return {
    version: "https://jsonfeed.org/version/1.1",
    title: "Example Co",
    home_page_url: "https://acme.teamtailor.com/jobs",
    feed_url: "https://acme.teamtailor.com/jobs.json",
    items,
    ...extra,
  };
}
